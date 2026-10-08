// Skill registry over `registry.json`. Versions are git tags `skill/<name>@vN`.
//
//   node scripts/registry.ts install <skill> [--issue <n>] [--network]
//
// `install` is the only way into `.claude/skills/`. It requires the locked
// examples (unchanged), an `approve` verdict in `work/<skill>/review.json` and
// a fresh passing `run-examples`, then copies the skill, updates the registry,
// commits, tags and pushes as the GitHub App bot. The issue defaults to
// `work/<skill>/issue.json` (written by `tracker.ts open`). Output is one JSON
// line: `{ installed, version, commit }`, or `{ installed: false, reason }`
// (exit 1).

import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { runAsBot } from "./github-app-token.ts";
import { loadDotEnv } from "./lib/env.ts";
import { isPlainObject, SKILL_NAME } from "./lib/examples.ts";
import { readIssueRecord } from "./lib/issue.ts";
import { examplesPath, readLock, sha256File } from "./lock.ts";
import type { Summary } from "./run-examples.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const VERSION = /^v([1-9]\d*)$/;
const NOT_INSTALLED = new Set(["issue.json", "progress.md", "review.json"]);
// Push with the bot token: `gh` serves `GH_TOKEN` as git credentials.
const BOT_CREDENTIALS = [
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
];

const execFileAsync = promisify(execFile);

export interface RegistryEntry {
  enabled: boolean;
  examplesHash: string;
  installedAt: string;
  issue: number;
  name: string;
  network: boolean;
  version: string;
}

export interface Registry {
  skills: RegistryEntry[];
}

export const registryPath = (root: string): string =>
  path.join(root, "registry.json");

const isRegistryEntry = (value: unknown): value is RegistryEntry =>
  isPlainObject(value) &&
  typeof value.name === "string" &&
  typeof value.version === "string" &&
  typeof value.enabled === "boolean" &&
  typeof value.network === "boolean" &&
  typeof value.examplesHash === "string" &&
  typeof value.installedAt === "string" &&
  typeof value.issue === "number";

export const readRegistry = (root: string): Registry => {
  const data: unknown = JSON.parse(readFileSync(registryPath(root), "utf8"));
  if (
    !(
      isPlainObject(data) &&
      Array.isArray(data.skills) &&
      data.skills.every(isRegistryEntry)
    )
  ) {
    throw new Error("registry.json is malformed");
  }
  return { skills: data.skills };
};

export type InstallResult =
  | { commit: string; installed: string; version: string }
  | { installed: false; reason: string };

export interface InstallDeps {
  /** Runs a command with the GitHub App bot identity; resolves to stdout. */
  bot: (cmd: string, args: readonly string[]) => Promise<string>;
  /** Read-only git as the local user; resolves to stdout. */
  git: (args: readonly string[]) => Promise<string>;
  now: () => Date;
  root: string;
  /** Fresh `run-examples` summary for a skill directory. */
  runExamples: (skillDir: string) => Promise<Summary>;
}

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
  if (sha256File(file) !== lock.sha256) {
    throw new Error(
      `work/${skill}/examples.json changed since it was locked at ${lock.lockedAt}`
    );
  }
  return lock.sha256;
};

const nextVersion = async (
  deps: InstallDeps,
  skill: string,
  previous: RegistryEntry | undefined
): Promise<string> => {
  const prefix = `skill/${skill}@`;
  const tags = await deps.git([
    "-C",
    deps.root,
    "tag",
    "--list",
    `${prefix}v*`,
  ]);
  // The glob also matches e.g. `skill/<skill>@vfoo`; count exact `vN` only.
  const numbers = tags
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => Number(VERSION.exec(tag.slice(prefix.length))?.[1] ?? 0));
  numbers.push(Number(VERSION.exec(previous?.version ?? "")?.[1] ?? 0));
  return `v${Math.max(...numbers) + 1}`;
};

const copySkill = (root: string, skill: string): void => {
  const source = path.join(root, "work", skill);
  const target = path.join(root, ".claude", "skills", skill);
  rmSync(target, { force: true, recursive: true });
  cpSync(source, target, {
    filter: (file) => !NOT_INSTALLED.has(path.relative(source, file)),
    recursive: true,
  });
};

const writeRegistry = (
  root: string,
  registry: Registry,
  entry: RegistryEntry
): void => {
  const skills = registry.skills.filter((skill) => skill.name !== entry.name);
  skills.push(entry);
  skills.sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(registryPath(root), `${JSON.stringify({ skills }, null, 2)}\n`);
};

const commitAndTag = async (
  deps: InstallDeps,
  entry: RegistryEntry
): Promise<string> => {
  const { name, version, issue } = entry;
  const repo = ["-C", deps.root];
  const paths = ["--", `.claude/skills/${name}`, "registry.json"];
  const tag = `skill/${name}@${version}`;
  await deps.bot("git", [...repo, "add", ...paths]);
  await deps.bot("git", [
    ...repo,
    "commit",
    "-m",
    `feat(skills): install ${name} ${version}`,
    "-m",
    `Refs #${issue}`,
    ...paths,
  ]);
  const commit = (await deps.git([...repo, "rev-parse", "HEAD"])).trim();
  await deps.bot("git", [
    ...repo,
    "tag",
    "-a",
    tag,
    "-m",
    `${name} ${version}`,
  ]);
  await deps.bot("git", [
    ...repo,
    ...BOT_CREDENTIALS,
    "push",
    "--atomic",
    "origin",
    "HEAD",
    `refs/tags/${tag}`,
  ]);
  return commit;
};

export const install = async (
  skill: string,
  options: InstallOptions,
  deps: InstallDeps
): Promise<InstallResult> => {
  try {
    if (!SKILL_NAME.test(skill)) {
      throw new Error(`invalid skill name "${skill}"`);
    }
    const issue = options.issue ?? readIssueRecord(deps.root, skill)?.issue;
    if (issue === undefined) {
      throw new Error(
        `no build issue: pass --issue <n> or open one with \`node scripts/tracker.ts open --skill ${skill}\``
      );
    }
    const examplesHash = checkLock(deps.root, skill);
    checkReview(deps.root, skill);
    const summary = await deps.runExamples(path.join(deps.root, "work", skill));
    if (summary.status !== "PASS") {
      throw new Error(
        `run-examples failed at ${summary.stage}: ${summary.reason}`
      );
    }
    const registry = readRegistry(deps.root);
    const previous = registry.skills.find((item) => item.name === skill);
    const entry: RegistryEntry = {
      enabled: true,
      examplesHash,
      installedAt: deps.now().toISOString(),
      issue,
      name: skill,
      network: options.network,
      version: await nextVersion(deps, skill, previous),
    };
    copySkill(deps.root, skill);
    writeRegistry(deps.root, registry, entry);
    const commit = await commitAndTag(deps, entry);
    return { commit, installed: skill, version: entry.version };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { installed: false, reason };
  }
};

// ---------------------------------------------------------------------------
// CLI

const runExamplesScript = async (skillDir: string): Promise<Summary> => {
  const script = path.join(REPO_ROOT, "scripts", "run-examples.ts");
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync(process.execPath, [script, skillDir], {
      encoding: "utf8",
      windowsHide: true,
    }));
  } catch (error) {
    // Exit 1 means FAIL; the summary line is still on stdout.
    if (error instanceof Error && "stdout" in error) {
      stdout = String(error.stdout);
    }
    if (stdout.trim() === "") {
      throw error;
    }
  }
  const lastLine = stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(lastLine) as Summary;
};

const realDeps: InstallDeps = {
  bot: (cmd, args) => runAsBot(cmd, args),
  git: async (args) =>
    (await execFileAsync("git", args, { encoding: "utf8", windowsHide: true }))
      .stdout,
  now: () => new Date(),
  root: REPO_ROOT,
  runExamples: runExamplesScript,
};

const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      issue: { type: "string" },
      network: { default: false, type: "boolean" },
    },
    strict: true,
  });
  const [command, skill] = positionals;
  if (command !== "install" || skill === undefined) {
    process.stderr.write(
      "usage: node scripts/registry.ts install <skill> [--issue <n>] [--network]\n"
    );
    process.exitCode = 2;
    return;
  }
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

if (import.meta.main) {
  await main();
}
