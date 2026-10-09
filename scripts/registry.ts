// Skill registry CLI over `registry.json` (model: `lib/registry.ts`).
// Versions are git tags `skill/<name>@vN`. Also `npm run skills -- <command>`.
//
//   node scripts/registry.ts list [--json]
//   node scripts/registry.ts show <name> [--json]
//   node scripts/registry.ts install <skill> [--issue <n>] [--network]
//   node scripts/registry.ts disable <name>                  # operator only
//   node scripts/registry.ts enable <name>                   # operator only
//   node scripts/registry.ts rollback <name> [--to vN]       # operator only
//   node scripts/registry.ts remove <name> [--delete-tags]   # operator only
//
// `list`/`show` print a table (one JSON line with `--json`). The operator
// commands (`lib/operator.ts`) are denied to the agent by `guard-bash.ts`; a
// human runs them in a terminal. They print one JSON line
// `{ action, name, ok, … }` (exit 1 when `ok` is false).
//
// `install` is the only way into `.claude/skills/`. It requires the locked
// examples (unchanged), an `approve` verdict in `work/<skill>/review.json`
// captured for those locked examples (its `examplesHash` equals the lock), and
// a fresh passing `run-examples`, then copies the skill, updates the registry
// (appending an `install` history entry with the run's cost), commits, tags
// and pushes as the GitHub App bot. The issue defaults to
// `work/<skill>/issue.json` (written by `tracker.ts open`). Output is one JSON
// line: `{ installed, version, commit }`, or `{ installed: false, reason }`
// (exit 1).
//
// The bot credentials are resolved before anything changes. If the copy,
// commit, tag or push fails, install restores `.claude/skills/<skill>`,
// `registry.json`, the index, HEAD and the tag as they were.

import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDotEnv } from "./lib/env.ts";
import { isPlainObject, SKILL_NAME } from "./lib/examples.ts";
import { readIssueRecord } from "./lib/issue.ts";
import {
  disableSkill,
  enableSkill,
  formatList,
  formatShow,
  listSkills,
  type OperatorResult,
  removeSkill,
  rollbackSkill,
  showSkill,
} from "./lib/operator.ts";
import {
  applyChange,
  type Change,
  commitChange,
  localVersionTags,
  message,
  pushChange,
  type RegistryDeps,
  type RegistryEntry,
  readRegistry,
  realDeps,
  saveEntry,
  skillPath,
  skillTag,
  versionNumber,
} from "./lib/registry.ts";
import { examplesPath, hashExamples, readLock } from "./lock.ts";

const POSITIVE_INTEGER = /^[1-9]\d*$/;
const NOT_INSTALLED = new Set(["issue.json", "progress.md", "review.json"]);

export type InstallResult =
  | { commit: string; installed: string; version: string }
  | { installed: false; reason: string };

export interface InstallOptions {
  /** Defaults to `work/<skill>/issue.json`. */
  issue?: number;
  network: boolean;
}

const checkReview = (root: string, skill: string): void => {
  const file = path.join(root, "work", skill, "review.json");
  if (!existsSync(file)) {
    throw new Error(
      `work/${skill}/review.json not found: the skill-reviewer must approve first`
    );
  }
  let review: unknown;
  try {
    review = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`work/${skill}/review.json is not valid JSON`, {
      cause: error,
    });
  }
  const verdict = isPlainObject(review) ? review.verdict : undefined;
  if (verdict !== "approve") {
    throw new Error(
      `skill-reviewer verdict is ${JSON.stringify(verdict ?? null)}, not "approve"`
    );
  }
  // The approve must be for the examples locked now (checkLock ran first).
  const lockHash = readLock(root, skill)?.sha256;
  const reviewedHash = isPlainObject(review) ? review.examplesHash : undefined;
  if (reviewedHash !== lockHash) {
    throw new Error(
      `work/${skill}/review.json was captured for examplesHash ${JSON.stringify(
        reviewedHash ?? null
      )}, but the lock has ${JSON.stringify(lockHash ?? null)}: invoke the skill-reviewer again`
    );
  }
};

const checkLock = (root: string, skill: string): string => {
  const lock = readLock(root, skill);
  if (!lock) {
    throw new Error(
      `work/.locks/${skill}.json not found: lock the examples with \`node scripts/lock.ts ${skill}\` once the user confirms them`
    );
  }
  const file = examplesPath(root, skill);
  if (!existsSync(file)) {
    throw new Error(`work/${skill}/examples.json not found`);
  }
  if (hashExamples(path.dirname(file)) !== lock.sha256) {
    throw new Error(
      `work/${skill}/examples.json or its input files (work/${skill}/fixtures/input/) changed since they were locked at ${lock.lockedAt}`
    );
  }
  return lock.sha256;
};

const nextVersion = async (
  deps: RegistryDeps,
  skill: string,
  previous: RegistryEntry | undefined
): Promise<string> => {
  const prefix = `skill/${skill}@`;
  const numbers = (await localVersionTags(deps, skill)).map((tag) =>
    versionNumber(tag.slice(prefix.length))
  );
  numbers.push(versionNumber(previous?.version ?? ""));
  return `v${Math.max(...numbers) + 1}`;
};

const copySkill = (root: string, skill: string): void => {
  const source = path.join(root, "work", skill);
  const target = path.join(root, skillPath(skill));
  rmSync(target, { force: true, recursive: true });
  cpSync(source, target, {
    filter: (file) => !NOT_INSTALLED.has(path.relative(source, file)),
    recursive: true,
  });
};

const commitAndTag = async (
  deps: RegistryDeps,
  entry: RegistryEntry,
  change: Change
): Promise<string> => {
  const { name, version, issue } = entry;
  const tag = skillTag(name, version);
  const commit = await commitChange(deps, change, [
    `feat(skills): install ${name} ${version}`,
    `Refs #${issue}`,
  ]);
  await deps.bot("git", [
    "-C",
    deps.root,
    "tag",
    "-a",
    tag,
    "-m",
    `${name} ${version}`,
  ]);
  change.tag = tag;
  await pushChange(deps, [`refs/tags/${tag}`]);
  return commit;
};

/** Everything install requires before it may change any file. */
const checkInstallable = async (
  skill: string,
  options: InstallOptions,
  deps: RegistryDeps
): Promise<RegistryEntry> => {
  if (!SKILL_NAME.test(skill)) {
    throw new Error(`invalid skill name "${skill}"`);
  }
  const issue = options.issue ?? readIssueRecord(deps.root, skill)?.issue;
  if (issue === undefined) {
    throw new Error(
      `no build issue: pass --issue <n> or open one with \`node scripts/tracker.ts open --skill ${skill}\``
    );
  }
  const previous = readRegistry(deps.root).skills.find(
    (item) => item.name === skill
  );
  if (previous?.enabled === false) {
    throw new Error(
      `skill "${skill}" is disabled; the operator must enable or remove it first`
    );
  }
  const examplesHash = checkLock(deps.root, skill);
  checkReview(deps.root, skill);
  await deps.credentials();
  const summary = await deps.runExamples(path.join(deps.root, "work", skill));
  if (summary.status !== "PASS") {
    throw new Error(
      `run-examples failed at ${summary.stage}: ${summary.reason}`
    );
  }
  return {
    enabled: true,
    examplesHash,
    history: previous?.history ?? [],
    installedAt: deps.now().toISOString(),
    issue,
    name: skill,
    network: options.network,
    version: await nextVersion(deps, skill, previous),
  };
};

export const install = async (
  skill: string,
  options: InstallOptions,
  deps: RegistryDeps
): Promise<InstallResult> => {
  try {
    const entry = await checkInstallable(skill, options, deps);
    const commit = await applyChange(
      deps,
      [skillPath(skill)],
      "installed",
      async (change) => {
        copySkill(deps.root, skill);
        entry.history = [
          ...entry.history,
          {
            action: "install",
            at: entry.installedAt,
            commit: change.head,
            costUsd: deps.costUsd(),
            issue: entry.issue,
            version: entry.version,
          },
        ];
        saveEntry(deps.root, readRegistry(deps.root), entry);
        return await commitAndTag(deps, entry, change);
      }
    );
    return { commit, installed: skill, version: entry.version };
  } catch (error) {
    return { installed: false, reason: message(error) };
  }
};

// ---------------------------------------------------------------------------
// CLI

const USAGE = `usage: node scripts/registry.ts <command>
  list [--json]
  show <name> [--json]
  install <skill> [--issue <n>] [--network]
  disable <name>                   (operator)
  enable <name>                    (operator)
  rollback <name> [--to vN]        (operator)
  remove <name> [--delete-tags]    (operator)
`;

interface CliValues {
  "delete-tags": boolean;
  issue?: string;
  json: boolean;
  network: boolean;
  to?: string;
}

const runInstall = async (skill: string, values: CliValues): Promise<void> => {
  let result: InstallResult;
  if (values.issue === undefined || POSITIVE_INTEGER.test(values.issue)) {
    loadDotEnv();
    result = await install(
      skill,
      {
        network: values.network,
        ...(values.issue === undefined ? {} : { issue: Number(values.issue) }),
      },
      realDeps
    );
  } else {
    result = { installed: false, reason: "--issue must be a positive integer" };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.installed === false ? 1 : 0;
};

const runOperator = async (
  command: string,
  name: string,
  values: CliValues
): Promise<OperatorResult> => {
  loadDotEnv();
  switch (command) {
    case "disable":
      return await disableSkill(name, realDeps);
    case "enable":
      return await enableSkill(name, realDeps);
    case "rollback":
      return await rollbackSkill(
        name,
        values.to === undefined ? {} : { to: values.to },
        realDeps
      );
    default:
      return await removeSkill(
        name,
        { deleteTags: values["delete-tags"] },
        realDeps
      );
  }
};

const OPERATOR_COMMANDS: Record<string, true> = {
  disable: true,
  enable: true,
  remove: true,
  rollback: true,
};

const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      "delete-tags": { default: false, type: "boolean" },
      issue: { type: "string" },
      json: { default: false, type: "boolean" },
      network: { default: false, type: "boolean" },
      to: { type: "string" },
    },
    strict: true,
  });
  const [command = "", name] = positionals;
  if (command === "list" && name === undefined) {
    const skills = listSkills(realDeps.root);
    process.stdout.write(
      values.json
        ? `${JSON.stringify({ skills })}\n`
        : `${formatList(skills)}\n`
    );
    return;
  }
  if (name === undefined) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  if (command === "show") {
    try {
      const details = await showSkill(realDeps, name);
      process.stdout.write(
        values.json
          ? `${JSON.stringify(details)}\n`
          : `${formatShow(details)}\n`
      );
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ error: message(error) })}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === "install") {
    await runInstall(name, values);
    return;
  }
  if (OPERATOR_COMMANDS[command] !== true) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const result = await runOperator(command, name, values);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
};

if (import.meta.main) {
  await main();
}
