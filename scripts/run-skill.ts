// Runs an installed skill in the Docker sandbox: the only way the agent uses
// a skill from `.claude/skills/`. The skill must be enabled in `registry.json`;
// network access follows its registry entry. Not in test mode.
//
//   node scripts/run-skill.ts <skill> '<json>'
//   node scripts/run-skill.ts <skill> --input-file <path>   # larger inputs
//
// The JSON input is a CLI argument or a file; stdin is not read, so a pipe
// into this script fails with the missing-input error. Exactly one of the two
// must be given.
//
// stdout: the skill's JSON output (exit code passed through). Errors before
// the skill runs print `{ "error": … }` and exit 1. Full stderr goes to
// `logs/<name>/run-<timestamp>.log`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { requireEnvVars } from "./lib/env.ts";
import { SKILL_ENTRY, SKILL_NAME } from "./lib/examples.ts";
import { clientFromEnv, runWorkflow } from "./lib/n8n-client.ts";
import { WEBHOOK_HEADER, WEBHOOK_SECRET_ENV } from "./lib/n8n-workflow.ts";
import { type RegistryEntry, readRegistry } from "./lib/registry.ts";
import { runInSandbox, type SandboxResult, SKILL_MOUNT } from "./sandbox.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INPUT_FILE_FLAG = "--input-file";
const USAGE =
  "usage: node scripts/run-skill.ts <skill> '<json>' | node scripts/run-skill.ts <skill> --input-file <path>";

export interface Invocation {
  input: unknown;
  name: string;
}

/**
 * Skill name and parsed JSON input from the CLI arguments (after the script
 * path). Hand-parsed so an inline value like `-1` stays a JSON argument.
 */
export const parseInvocation = (
  args: readonly string[],
  readText: (file: string) => string = (file) => readFileSync(file, "utf8")
): Invocation => {
  const [name, ...rest] = args;
  if (name === undefined) {
    throw new Error(USAGE);
  }
  const inline: string[] = [];
  const files: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? "";
    if (arg === INPUT_FILE_FLAG) {
      const file = rest[index + 1];
      if (file === undefined) {
        throw new Error(`${INPUT_FILE_FLAG} needs a path`);
      }
      files.push(file);
      index += 1;
    } else if (arg.startsWith(`${INPUT_FILE_FLAG}=`)) {
      files.push(arg.slice(INPUT_FILE_FLAG.length + 1));
    } else {
      inline.push(arg);
    }
  }
  if (inline.length + files.length !== 1) {
    throw new Error(
      `pass the JSON input exactly once: as one argument '<json>' or with ${INPUT_FILE_FLAG} <path> (${USAGE})`
    );
  }
  const [file] = files;
  let text: string;
  if (file === undefined) {
    text = inline[0] ?? "";
  } else {
    try {
      text = readText(file);
    } catch (error) {
      throw new Error(`cannot read input file ${file}`, { cause: error });
    }
  }
  try {
    // The parse error is not echoed: it would quote the file's content.
    return { input: JSON.parse(text), name };
  } catch (error) {
    throw new Error(
      file === undefined
        ? "input must be one JSON value"
        : `input file ${file} must contain one JSON value`,
      { cause: error }
    );
  }
};

const writeLog = (name: string, lines: string[]): string => {
  const dir = path.join(REPO_ROOT, "logs", name);
  mkdirSync(dir, { recursive: true });
  // Milliseconds: two runs in the same second must not share a log.
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const file = path.join(dir, `run-${stamp}.log`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return path.relative(REPO_ROOT, file).replaceAll("\\", "/");
};

/** The skill's registry entry; throws unless it is installed and enabled. */
export const enabledEntry = (root: string, name: string): RegistryEntry => {
  if (!SKILL_NAME.test(name)) {
    throw new Error(`invalid skill name "${name}"`);
  }
  const entry = readRegistry(root).skills.find((skill) => skill.name === name);
  if (!entry) {
    throw new Error(`skill "${name}" is not installed`);
  }
  if (!entry.enabled) {
    throw new Error(`skill "${name}" is disabled`);
  }
  return entry;
};

/** An n8n skill: the workflow runs in n8n, called from the host, no sandbox. */
const runWorkflowSkill = async (
  name: string,
  workflow: { id: string; webhookPath: string },
  input: unknown
): Promise<number> => {
  const client = clientFromEnv();
  requireEnvVars([WEBHOOK_SECRET_ENV]);
  const result = await runWorkflow(client, {
    headerName: WEBHOOK_HEADER,
    input,
    secret: process.env[WEBHOOK_SECRET_ENV] ?? "",
    webhookPath: workflow.webhookPath,
    workflowId: workflow.id,
  });
  const output = {
    ...result,
    ...(result.id === ""
      ? {}
      : { url: client.executionUrl(workflow.id, result.id) }),
  };
  writeLog(name, [
    `skill: ${name} (n8n workflow ${workflow.id})`,
    `input: ${JSON.stringify(input)}`,
    JSON.stringify(output),
  ]);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return result.status === "success" ? 0 : 1;
};

const run = async ({ name, input }: Invocation): Promise<number> => {
  const entry = enabledEntry(REPO_ROOT, name);
  if (entry.workflow !== undefined) {
    return await runWorkflowSkill(name, entry.workflow, input);
  }
  const header = [
    `skill: ${name} ${entry.version}`,
    `network: ${entry.network}`,
    `input: ${JSON.stringify(input)}`,
  ];
  const runRecords: string[] = [];
  let result: SandboxResult;
  try {
    result = await runInSandbox({
      command: [`${SKILL_MOUNT}/${SKILL_ENTRY}`],
      network: entry.network,
      onRunLog: (record) => runRecords.push(record),
      skillDir: path.join(REPO_ROOT, ".claude", "skills", name),
      stdin: JSON.stringify(input),
      testMode: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const log = writeLog(name, [...header, ...runRecords, `error: ${message}`]);
    throw new Error(`${message} (log: ${log})`, { cause: error });
  }
  const log = writeLog(name, [
    ...header,
    ...runRecords,
    `exit: ${result.exitCode}, ${result.durationMs}ms${result.timedOut ? ", TIMED OUT" : ""}`,
    "stdout:",
    result.stdout,
    "stderr:",
    result.stderr,
  ]);
  if (result.timedOut) {
    throw new Error(`skill "${name}" timed out (log: ${log})`);
  }
  process.stdout.write(
    result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`
  );
  return result.exitCode;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = await run(parseInvocation(args));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
