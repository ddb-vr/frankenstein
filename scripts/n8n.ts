// The n8n route of the lifecycle (`.claude/skills/frankenstein/N8N.md`): the
// only way the agent talks to n8n. Reads `N8N_BASE_URL`, `N8N_API_KEY` and
// `N8N_WEBHOOK_SECRET` from `.env`; the agent never reads `.env` and never
// calls the API directly.
//
//   node scripts/n8n.ts instance init --test-email <address> [--mail gmail|outlook|smtp]
//   node scripts/n8n.ts instance check
//   node scripts/n8n.ts creds <skill> [--check]
//   node scripts/n8n.ts lint <skill>            # the rules alone, offline
//   node scripts/n8n.ts push <skill>
//   node scripts/n8n.ts test <skill>
//   node scripts/n8n.ts run <skill> '<json>'
//   node scripts/n8n.ts approve <skill>
//   node scripts/n8n.ts go-live <skill> [--issue <n>]
//
// Files: `n8n/instance.json` (once per n8n instance), `work/<skill>/workflow.json`
// (the builder's source), `work/<skill>/n8n.json` (IDs written here),
// `work/<skill>/approval.json` (the user's go-live approval). Output is one
// JSON line on stdout; errors print `{ "error": … }` on stderr and exit 1.

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isPlainObject, SKILL_NAME, validateExamples } from "./lib/examples.ts";
import { readIssueRecord } from "./lib/issue.ts";
import {
  clientFromEnv,
  type N8nClient,
  runWorkflow,
} from "./lib/n8n-client.ts";
import {
  checkWorkflow,
  configMode,
  type Problem,
  parseWorkflow,
} from "./lib/n8n-rules.ts";
import {
  approvalHash,
  assignCredentials,
  credentialNeeds,
  droppedParameters,
  ERROR_HANDLER_NAME,
  errorHandlerWorkflow,
  evaluateChecks,
  FRANKENSTEIN_TAG,
  failedNodes,
  type Instance,
  liveTargets,
  MAIL_KINDS,
  type MailKind,
  mailCredentialType,
  parseChecks,
  prepareForLive,
  prepareForPush,
  validateInstance,
  WEBHOOK_CREDENTIAL_TYPE,
  WEBHOOK_HEADER,
  WEBHOOK_SECRET_ENV,
  webhookPath,
  workflowBody,
} from "./lib/n8n-workflow.ts";
import {
  type RegistryEntry,
  readRegistry,
  saveEntry,
  skillPath,
} from "./lib/registry.ts";
import { sha256File } from "./lock.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INSTANCE_FILE = path.join(REPO_ROOT, "n8n", "instance.json");
const SECRET_BYTES = 24;
const MAIL_LABEL: Record<MailKind, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  smtp: "SMTP",
};
const INSTALLED_FILES = [
  "SKILL.md",
  "workflow.json",
  "examples.json",
  "PRD.md",
];
const USAGE = `usage:
  node scripts/n8n.ts instance init --test-email <address> [--mail gmail|outlook|smtp]
  node scripts/n8n.ts instance check
  node scripts/n8n.ts creds <skill> [--check]
  node scripts/n8n.ts lint <skill>
  node scripts/n8n.ts push <skill>
  node scripts/n8n.ts test <skill>
  node scripts/n8n.ts run <skill> '<json>'
  node scripts/n8n.ts approve <skill>
  node scripts/n8n.ts go-live <skill> [--issue <n>]`;

// ---------------------------------------------------------------------------
// Files

const workDir = (skill: string): string => {
  if (!SKILL_NAME.test(skill)) {
    throw new Error(`invalid skill name "${skill}"`);
  }
  return path.join(REPO_ROOT, "work", skill);
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const relative = path.relative(REPO_ROOT, file).replaceAll("\\", "/");
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`${relative} does not exist`, { cause: error });
    }
    throw new Error(`${relative} is not valid JSON`, { cause: error });
  }
};

const writeJson = (file: string, value: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const readWorkflowFile = (skill: string): Record<string, unknown> => {
  const data = readJson(path.join(workDir(skill), "workflow.json"));
  if (!isPlainObject(data)) {
    throw new Error(`work/${skill}/workflow.json must be an object`);
  }
  return data;
};

const writeWorkflowFile = (skill: string, workflow: unknown): void => {
  writeJson(path.join(workDir(skill), "workflow.json"), workflow);
};

interface PushRecord {
  id: string;
  url: string;
  webhookPath: string;
}

const readPushRecord = (skill: string): PushRecord => {
  const data = readJson(path.join(workDir(skill), "n8n.json"));
  if (
    !(
      isPlainObject(data) &&
      typeof data.id === "string" &&
      typeof data.webhookPath === "string" &&
      typeof data.url === "string"
    )
  ) {
    throw new Error(`work/${skill}/n8n.json is malformed; run push first`);
  }
  return { id: data.id, url: data.url, webhookPath: data.webhookPath };
};

const readInstance = (): Instance => {
  if (!existsSync(INSTANCE_FILE)) {
    throw new Error(
      "n8n/instance.json does not exist: run `node scripts/n8n.ts instance init --test-email <address>` first"
    );
  }
  const instance = validateInstance(readJson(INSTANCE_FILE));
  if (typeof instance === "string") {
    throw new Error(instance);
  }
  return instance;
};

/** The webhook secret from `.env`; generated and appended when missing. */
const webhookSecret = (): string => {
  const existing = process.env[WEBHOOK_SECRET_ENV]?.trim();
  if (existing) {
    return existing;
  }
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const envFile = path.join(REPO_ROOT, ".env");
  const text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const newline = text === "" || text.endsWith("\n") ? "" : "\n";
  appendFileSync(envFile, `${newline}${WEBHOOK_SECRET_ENV}=${secret}\n`);
  process.env[WEBHOOK_SECRET_ENV] = secret;
  return secret;
};

const formatProblems = (problems: Problem[]): string =>
  problems
    .map((problem) =>
      problem.node === undefined
        ? `- ${problem.message}`
        : `- ${problem.node}: ${problem.message}`
    )
    .join("\n");

// ---------------------------------------------------------------------------
// instance

const findOrCreateCredential = async (
  client: N8nClient,
  name: string,
  type: string,
  data: Record<string, unknown>
): Promise<{ created: boolean; id: string }> => {
  const existing = (await client.listCredentials()).find(
    (credential) => credential.type === type && credential.name === name
  );
  if (existing !== undefined) {
    return { created: false, id: existing.id };
  }
  const created = await client.createCredential(name, type, data);
  return { created: true, id: created.id };
};

const instanceInit = async (
  client: N8nClient,
  testEmail: string,
  mail: MailKind
): Promise<unknown> => {
  const previous = existsSync(INSTANCE_FILE)
    ? validateInstance(readJson(INSTANCE_FILE))
    : undefined;
  const secret = webhookSecret();
  const webhook = await findOrCreateCredential(
    client,
    "Frankenstein Webhook",
    WEBHOOK_CREDENTIAL_TYPE,
    { name: WEBHOOK_HEADER, value: secret }
  );
  const mailType = mailCredentialType(mail);
  const mailCredential = await findOrCreateCredential(
    client,
    `Frankenstein ${MAIL_LABEL[mail]}`,
    mailType,
    {}
  );
  const body = workflowBody(
    errorHandlerWorkflow(mail, mailCredential.id, testEmail)
  );
  const reuse =
    typeof previous === "object" && previous.errorWorkflowId !== ""
      ? previous.errorWorkflowId
      : undefined;
  if (reuse !== undefined) {
    await client.updateWorkflow(reuse, body);
  }
  const errorWorkflowId =
    reuse ?? String((await client.createWorkflow(body)).id);
  await client.setWorkflowTags(errorWorkflowId, [
    await client.tagId(FRANKENSTEIN_TAG),
  ]);
  const instance: Instance = {
    errorWorkflowId,
    mail,
    mailCredentialId: mailCredential.id,
    testEmail,
    webhookCredentialId: webhook.id,
  };
  writeJson(INSTANCE_FILE, instance);
  return {
    errorHandler: client.workflowUrl(errorWorkflowId),
    instance: "n8n/instance.json",
    signIn: mailCredential.created
      ? [
          {
            credential: mailType,
            open: client.credentialUrl(mailCredential.id),
            what:
              mail === "smtp"
                ? "fill in the SMTP server and save"
                : "click Sign in and allow access",
          },
        ]
      : [],
    testEmail,
  };
};

const instanceCheck = async (client: N8nClient): Promise<unknown> => {
  if (!existsSync(INSTANCE_FILE)) {
    await client.ping();
    return {
      apiReachable: true,
      next: "node scripts/n8n.ts instance init --test-email <address>",
      ok: false,
      reason: "n8n/instance.json does not exist yet (first n8n build)",
    };
  }
  const instance = readInstance();
  const workflow = await client.getWorkflow(instance.errorWorkflowId);
  const mail = await client.testCredential(instance.mailCredentialId);
  const webhook = await client
    .testCredential(instance.webhookCredentialId)
    .catch(() => ({ message: "cannot be tested", status: "OK" }));
  const ok = workflow.name === ERROR_HANDLER_NAME && mail.status === "OK";
  return {
    errorHandler: {
      name: workflow.name,
      url: client.workflowUrl(instance.errorWorkflowId),
    },
    mailCredential: {
      ...mail,
      ...(mail.status === "OK"
        ? {}
        : { open: client.credentialUrl(instance.mailCredentialId) }),
    },
    ok,
    testEmail: instance.testEmail,
    webhookCredential: webhook,
  };
};

// ---------------------------------------------------------------------------
// creds

const creds = async (
  client: N8nClient,
  skill: string,
  check: boolean
): Promise<unknown> => {
  const instance = readInstance();
  const workflow = readWorkflowFile(skill);
  const needs = credentialNeeds(workflow);
  const existing = await client.listCredentials();
  const ids = new Map<string, { id: string; name: string }>();
  const signIn: unknown[] = [];
  for (const type of new Set(needs.map((need) => need.type))) {
    if (type === WEBHOOK_CREDENTIAL_TYPE) {
      ids.set(type, {
        id: instance.webhookCredentialId,
        name: "Frankenstein Webhook",
      });
      continue;
    }
    const assigned = needs.find(
      (need) => need.type === type && need.id !== ""
    )?.id;
    const reusable =
      existing.find((credential) => credential.id === assigned) ??
      existing.find((credential) => credential.type === type);
    if (reusable !== undefined) {
      ids.set(type, { id: reusable.id, name: reusable.name });
      continue;
    }
    const name = `Frankenstein ${type}`;
    // biome-ignore lint/performance/noAwaitInLoops: one credential at a time keeps the sign-in list ordered.
    const created = await client.createCredential(name, type, {});
    ids.set(type, { id: created.id, name });
    signIn.push({
      credential: type,
      open: client.credentialUrl(created.id),
      what: "click Sign in (or paste the API key) and save",
    });
  }
  writeWorkflowFile(skill, assignCredentials(workflow, ids));
  const credentials = [...ids.entries()].map(([type, value]) => ({
    id: value.id,
    name: value.name,
    type,
  }));
  if (!check) {
    return { credentials, signIn };
  }
  const results: Record<string, unknown>[] = [];
  for (const credential of credentials) {
    if (credential.type === WEBHOOK_CREDENTIAL_TYPE) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: credential tests are rate-limited by the apps behind them.
    const result = await client.testCredential(credential.id);
    results.push({
      ...credential,
      ...result,
      ...(result.status === "OK"
        ? {}
        : { open: client.credentialUrl(credential.id) }),
    });
  }
  return {
    credentials: results,
    ok: results.every((result) => result.status === "OK"),
  };
};

// ---------------------------------------------------------------------------
// push

const push = async (client: N8nClient, skill: string): Promise<unknown> => {
  const instance = readInstance();
  const prepared = prepareForPush(readWorkflowFile(skill), skill, instance);
  const problems = checkWorkflow(prepared);
  if (problems.length > 0) {
    throw new Error(
      `workflow.json breaks the rules:\n${formatProblems(problems)}`
    );
  }
  const unfilled = credentialNeeds(prepared).filter((need) => need.id === "");
  if (unfilled.length > 0) {
    throw new Error(
      `credentials missing on ${unfilled.map((need) => `${need.node} (${need.type})`).join(", ")}: run creds ${skill} first`
    );
  }
  const handler = await client.getWorkflow(instance.errorWorkflowId);
  if (handler.name !== ERROR_HANDLER_NAME) {
    throw new Error(
      "the Error Handler in n8n/instance.json is gone; run instance init again"
    );
  }
  writeWorkflowFile(skill, prepared);
  const recordFile = path.join(workDir(skill), "n8n.json");
  const previous = existsSync(recordFile) ? readPushRecord(skill) : undefined;
  const body = workflowBody(prepared);
  const id =
    previous === undefined
      ? String((await client.createWorkflow(body)).id)
      : previous.id;
  if (previous !== undefined) {
    await client.updateWorkflow(id, body);
  }
  await client.setWorkflowTags(id, [await client.tagId(FRANKENSTEIN_TAG)]);
  await client.publishWorkflow(id);
  const readBack = await client.getWorkflow(id);
  const dropped = droppedParameters(prepared, readBack);
  const record: PushRecord = {
    id,
    url: client.workflowUrl(id),
    webhookPath: webhookPath(skill),
  };
  writeJson(recordFile, record);
  return {
    ...record,
    dropped,
    mode: configMode(prepared as never),
    ...(dropped.length > 0
      ? {
          warning:
            "n8n dropped these parameters on read-back: the key or the typeVersion is wrong; check the node source",
        }
      : {}),
  };
};

// ---------------------------------------------------------------------------
// run and test

const runOnce = async (
  client: N8nClient,
  record: PushRecord,
  input: unknown
): Promise<
  ReturnType<typeof runWorkflow> extends Promise<infer T> ? T : never
> =>
  await runWorkflow(client, {
    headerName: WEBHOOK_HEADER,
    input,
    secret: webhookSecret(),
    webhookPath: record.webhookPath,
    workflowId: record.id,
  });

/** The pushed workflow of a skill: the installed one, else the work copy. */
const recordFor = (skill: string): PushRecord => {
  const entry = readRegistry(REPO_ROOT).skills.find(
    (candidate) => candidate.name === skill && candidate.workflow !== undefined
  );
  if (entry?.workflow !== undefined) {
    return {
      id: entry.workflow.id,
      url: "",
      webhookPath: entry.workflow.webhookPath,
    };
  }
  return readPushRecord(skill);
};

const run = async (
  client: N8nClient,
  skill: string,
  inputText: string
): Promise<unknown> => {
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch (error) {
    throw new Error("input must be one JSON value", { cause: error });
  }
  const result = await runOnce(client, recordFor(skill), input);
  return {
    ...result,
    url: client.executionUrl(recordFor(skill).id, result.id),
  };
};

const test = async (client: N8nClient, skill: string): Promise<unknown> => {
  const examples = validateExamples(
    readJson(path.join(workDir(skill), "examples.json"))
  );
  if (!examples.ok) {
    throw new Error(`work/${skill}/examples.json: ${examples.error}`);
  }
  const record = readPushRecord(skill);
  const results: {
    failures: string[];
    name: string;
    pass: boolean;
    url: string;
  }[] = [];
  for (const example of examples.value.examples) {
    const checks = parseChecks(example.expected);
    if (typeof checks === "string") {
      throw new Error(`example "${example.name}": ${checks}`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: examples run one at a time so each finds its own execution.
    const summary = await runOnce(client, record, example.input);
    const failures = [
      ...(summary.status === "success"
        ? []
        : [
            `execution ${summary.status}${summary.error === undefined ? "" : `: ${summary.error}`}`,
          ]),
      ...failedNodes(summary),
      ...evaluateChecks(checks, summary),
    ];
    results.push({
      failures,
      name: example.name,
      pass: failures.length === 0,
      url: client.executionUrl(record.id, summary.id),
    });
  }
  const passed = results.filter((result) => result.pass).length;
  return {
    pass: passed === results.length,
    results,
    summary: `${passed}/${results.length} examples passed`,
  };
};

// ---------------------------------------------------------------------------
// approve and go-live

const approve = (skill: string): unknown => {
  const file = path.join(workDir(skill), "workflow.json");
  const workflow = parseWorkflow(readJson(file));
  if (typeof workflow === "string") {
    throw new Error(workflow);
  }
  const approval = {
    approvedAt: new Date().toISOString(),
    sha256: approvalHash(readFileSync(file, "utf8")),
  };
  writeJson(path.join(workDir(skill), "approval.json"), approval);
  return { approved: skill, liveTargets: liveTargets(workflow), ...approval };
};

const goLive = async (
  client: N8nClient,
  skill: string,
  issueArg: number | undefined
): Promise<unknown> => {
  const dir = workDir(skill);
  const workflowFile = path.join(dir, "workflow.json");
  const approval = readJson(path.join(dir, "approval.json"));
  const currentHash = approvalHash(readFileSync(workflowFile, "utf8"));
  if (!(isPlainObject(approval) && approval.sha256 === currentHash)) {
    throw new Error(
      "workflow.json changed since the user approved it (or was never approved): show the test results and ask again, then run approve"
    );
  }
  const issue = issueArg ?? readIssueRecord(REPO_ROOT, skill)?.issue;
  if (issue === undefined) {
    throw new Error("no issue: pass --issue <n> or open one with tracker.ts");
  }
  const record = readPushRecord(skill);
  const workflow = readWorkflowFile(skill);
  const problems = checkWorkflow(workflow);
  if (problems.length > 0) {
    throw new Error(
      `workflow.json breaks the rules:\n${formatProblems(problems)}`
    );
  }
  const live = prepareForLive(workflow);
  await client.updateWorkflow(record.id, workflowBody(live));
  await client.publishWorkflow(record.id);

  const registry = readRegistry(REPO_ROOT);
  const previous = registry.skills.find(
    (candidate) => candidate.name === skill
  );
  const version = `v${(previous?.history.length ?? 0) + 1}`;
  const now = new Date().toISOString();
  const target = path.join(REPO_ROOT, skillPath(skill));
  mkdirSync(target, { recursive: true });
  for (const file of INSTALLED_FILES) {
    const source = path.join(dir, file);
    if (existsSync(source)) {
      cpSync(source, path.join(target, file));
    }
  }
  writeJson(path.join(target, "workflow.json"), live);
  const entry: RegistryEntry = {
    enabled: true,
    examplesHash: sha256File(path.join(dir, "examples.json")),
    history: [
      ...(previous?.history ?? []),
      {
        action: "install",
        at: now,
        commit: null,
        costUsd: null,
        issue,
        version,
      },
    ],
    installedAt: now,
    issue,
    name: skill,
    network: false,
    version,
    workflow: { id: record.id, webhookPath: record.webhookPath },
  };
  saveEntry(REPO_ROOT, registry, entry);
  const firstRun = await runOnce(client, record, {});
  return {
    firstRun: { ...firstRun, url: client.executionUrl(record.id, firstRun.id) },
    live: skill,
    url: record.url,
    version,
  };
};

// ---------------------------------------------------------------------------
// CLI

interface CliArgs {
  /** Second positional: the skill, or the `instance` subcommand. */
  argument: string;
  extra: string | undefined;
  values: {
    check?: boolean;
    issue?: string;
    mail?: string;
    "test-email"?: string;
  };
}

const instanceCommand = ({ argument, values }: CliArgs): Promise<unknown> => {
  if (argument === "check") {
    return instanceCheck(clientFromEnv());
  }
  if (argument !== "init") {
    throw new Error(USAGE);
  }
  const testEmail = values["test-email"];
  const mail = values.mail ?? "gmail";
  if (testEmail === undefined || !testEmail.includes("@")) {
    throw new Error("--test-email <address> is required");
  }
  if (!MAIL_KINDS.includes(mail as MailKind)) {
    throw new Error(`--mail must be one of ${MAIL_KINDS.join(", ")}`);
  }
  return instanceInit(clientFromEnv(), testEmail, mail as MailKind);
};

const goLiveCommand = ({ argument, values }: CliArgs): Promise<unknown> => {
  const issue = values.issue === undefined ? undefined : Number(values.issue);
  if (issue !== undefined && !(Number.isInteger(issue) && issue > 0)) {
    throw new Error("--issue must be a positive integer");
  }
  return goLive(clientFromEnv(), argument, issue);
};

/** The rules alone, offline: what push will refuse. */
const lint = (skill: string): unknown => {
  // Before `instance init`, stand-in values show what push will fill in.
  const instance: Instance = existsSync(INSTANCE_FILE)
    ? readInstance()
    : {
        errorWorkflowId: "pending",
        mail: "gmail",
        mailCredentialId: "pending",
        testEmail: "pending@example.com",
        webhookCredentialId: "pending",
      };
  const problems = checkWorkflow(
    prepareForPush(readWorkflowFile(skill), skill, instance)
  );
  return { ok: problems.length === 0, problems };
};

const COMMANDS: Record<string, (args: CliArgs) => Promise<unknown>> = {
  approve: ({ argument }) => Promise.resolve(approve(argument)),
  creds: ({ argument, values }) =>
    creds(clientFromEnv(), argument, values.check === true),
  "go-live": goLiveCommand,
  instance: instanceCommand,
  lint: ({ argument }) => Promise.resolve(lint(argument)),
  push: ({ argument }) => push(clientFromEnv(), argument),
  run: ({ argument, extra }) => {
    if (extra === undefined) {
      throw new Error(USAGE);
    }
    return run(clientFromEnv(), argument, extra);
  },
  test: ({ argument }) => test(clientFromEnv(), argument),
};

const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: process.argv.slice(2),
    options: {
      check: { type: "boolean" },
      issue: { type: "string" },
      mail: { type: "string" },
      "test-email": { type: "string" },
    },
  });
  const [command, argument, extra] = positionals;
  const handler = command === undefined ? undefined : COMMANDS[command];
  if (handler === undefined || argument === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await handler({ argument, extra, values });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (isPlainObject(result) && (result.pass === false || result.ok === false)) {
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
}
