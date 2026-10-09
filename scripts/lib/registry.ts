// `registry.json`: the installed skills, their versions and history. Versions
// are git tags `skill/<name>@vN`. Shared by `scripts/registry.ts` (install and
// the operator commands), `run-skill.ts` and `demo-reset.ts`.
//
// Every registry change runs inside `applyChange`: the touched skill
// directories and `registry.json` are backed up first, and a failed step
// restores them, the index, HEAD and a created tag.

import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { botEnv, runAsBot } from "../github-app-token.ts";
import { currentSessionId, peekRunUsage } from "../hooks/budget.ts";
import type { Summary } from "../run-examples.ts";
import { GITHUB_APP_ENV, requireEnvVars } from "./env.ts";
import { isPlainObject } from "./examples.ts";
import { computeCost } from "./pricing.ts";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const VERSION = /^v([1-9]\d*)$/;

const execFileAsync = promisify(execFile);

export const HISTORY_ACTIONS = [
  "install",
  "disable",
  "enable",
  "rollback",
  "remove",
] as const;

export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

export interface HistoryEntry {
  action: HistoryAction;
  at: string;
  /**
   * HEAD the action was applied to (its own commit is the child that adds
   * this entry, so it cannot name itself). `null` for migrated entries.
   */
  commit: string | null;
  /** Build cost of an install (its Claude Code session); 0 for operator actions. */
  costUsd: number | null;
  issue: number;
  version: string;
}

export interface RegistryEntry {
  enabled: boolean;
  examplesHash: string;
  history: HistoryEntry[];
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

/** Repo-relative directory of an installed (enabled) skill. */
export const skillPath = (skill: string): string => `.claude/skills/${skill}`;

/** Repo-relative directory of a disabled skill, hidden from Claude Code. */
export const disabledSkillPath = (skill: string): string =>
  `.claude/disabled-skills/${skill}`;

export const skillTag = (skill: string, version: string): string =>
  `skill/${skill}@${version}`;

/** N of `vN`, or 0 for anything else. */
export const versionNumber = (version: string): number =>
  Number(VERSION.exec(version)?.[1] ?? 0);

const isHistoryEntry = (value: unknown): value is HistoryEntry =>
  isPlainObject(value) &&
  HISTORY_ACTIONS.includes(value.action as HistoryAction) &&
  typeof value.at === "string" &&
  (value.commit === null || typeof value.commit === "string") &&
  (value.costUsd === null || typeof value.costUsd === "number") &&
  typeof value.issue === "number" &&
  typeof value.version === "string";

/** An entry as stored; entries from before `history` existed are migrated. */
const toRegistryEntry = (value: unknown): RegistryEntry | undefined => {
  if (
    !(
      isPlainObject(value) &&
      typeof value.name === "string" &&
      typeof value.version === "string" &&
      typeof value.enabled === "boolean" &&
      typeof value.network === "boolean" &&
      typeof value.examplesHash === "string" &&
      typeof value.installedAt === "string" &&
      typeof value.issue === "number"
    )
  ) {
    return;
  }
  const entry = {
    enabled: value.enabled,
    examplesHash: value.examplesHash,
    installedAt: value.installedAt,
    issue: value.issue,
    name: value.name,
    network: value.network,
    version: value.version,
  };
  if (value.history === undefined) {
    const installed: HistoryEntry = {
      action: "install",
      at: entry.installedAt,
      commit: null,
      costUsd: null,
      issue: entry.issue,
      version: entry.version,
    };
    return { ...entry, history: [installed] };
  }
  if (Array.isArray(value.history) && value.history.every(isHistoryEntry)) {
    return { ...entry, history: value.history };
  }
};

export const readRegistry = (root: string): Registry => {
  const data: unknown = JSON.parse(readFileSync(registryPath(root), "utf8"));
  const skills =
    isPlainObject(data) && Array.isArray(data.skills)
      ? data.skills.map(toRegistryEntry)
      : [undefined];
  if (skills.includes(undefined)) {
    throw new Error("registry.json is malformed");
  }
  return { skills: skills as RegistryEntry[] };
};

export const writeRegistry = (root: string, skills: RegistryEntry[]): void => {
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  writeFileSync(
    registryPath(root),
    `${JSON.stringify({ skills: sorted }, null, 2)}\n`
  );
};

/** Replaces (or adds) the entry with the same name. */
export const saveEntry = (
  root: string,
  registry: Registry,
  entry: RegistryEntry
): void => {
  writeRegistry(root, [
    ...registry.skills.filter((skill) => skill.name !== entry.name),
    entry,
  ]);
};

export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface RegistryDeps {
  /** Runs a command with the GitHub App bot identity; resolves to stdout. */
  bot: (cmd: string, args: readonly string[]) => Promise<string>;
  /** Build cost (USD) of the current Claude Code run, `null` when unknown. */
  costUsd: () => number | null;
  /** Resolves the bot credentials; rejects with what is missing or wrong. */
  credentials: () => Promise<void>;
  /** Git as the local user, never committing; resolves to stdout. */
  git: (args: readonly string[]) => Promise<string>;
  now: () => Date;
  root: string;
  /** Fresh `run-examples` summary for a skill directory. */
  runExamples: (skillDir: string) => Promise<Summary>;
}

/** Version tags `skill/<skill>@vN` that exist locally, ascending. */
export const localVersionTags = async (
  deps: RegistryDeps,
  skill: string
): Promise<string[]> => {
  const prefix = `skill/${skill}@`;
  const tags = await deps.git([
    "-C",
    deps.root,
    "tag",
    "--list",
    `${prefix}v*`,
  ]);
  // The glob also matches e.g. `skill/<skill>@vfoo`; keep exact `vN` only.
  return tags
    .split("\n")
    .map((tag) => tag.trim())
    .filter(
      (tag) =>
        tag.startsWith(prefix) && versionNumber(tag.slice(prefix.length)) > 0
    )
    .sort(
      (a, b) =>
        versionNumber(a.slice(prefix.length)) -
        versionNumber(b.slice(prefix.length))
    );
};

/** What a change touches, recorded so a failure can restore it. */
export interface Change {
  /** Absolute directory → its copy in `temp` (`undefined`: did not exist). */
  backups: Map<string, string | undefined>;
  head: string;
  /** `git add`/`commit` pathspec: the touched directories and the registry. */
  paths: string[];
  registry: string;
  /** Set before `git add` touches the index. */
  staged: boolean;
  /** Set once a new local tag exists. */
  tag?: string;
  temp: string;
}

const beginChange = async (
  deps: RegistryDeps,
  dirs: readonly string[]
): Promise<Change> => {
  const head = (await deps.git(["-C", deps.root, "rev-parse", "HEAD"])).trim();
  const temp = mkdtempSync(path.join(tmpdir(), "frankenstein-registry-"));
  const backups = new Map<string, string | undefined>();
  for (const [index, dir] of dirs.entries()) {
    const absolute = path.join(deps.root, dir);
    if (existsSync(absolute)) {
      const backup = path.join(temp, String(index));
      cpSync(absolute, backup, { recursive: true });
      backups.set(absolute, backup);
    } else {
      backups.set(absolute, undefined);
    }
  }
  return {
    backups,
    head,
    paths: ["--", ...dirs, "registry.json"],
    registry: readFileSync(registryPath(deps.root), "utf8"),
    staged: false,
    temp,
  };
};

/** Files first (local, cannot need the network), then the git state. */
const restoreChange = async (
  deps: RegistryDeps,
  change: Change
): Promise<void> => {
  for (const [dir, backup] of change.backups) {
    rmSync(dir, { force: true, recursive: true });
    if (backup !== undefined) {
      cpSync(backup, dir, { recursive: true });
    }
  }
  writeFileSync(registryPath(deps.root), change.registry);
  const repo = ["-C", deps.root];
  if (change.tag !== undefined) {
    await deps.bot("git", [...repo, "tag", "-d", change.tag]);
  }
  const head = (await deps.git([...repo, "rev-parse", "HEAD"])).trim();
  if (head !== change.head) {
    await deps.bot("git", [...repo, "reset", "--soft", change.head]);
  }
  if (change.staged) {
    await deps.bot("git", [
      ...repo,
      "reset",
      "--quiet",
      change.head,
      ...change.paths,
    ]);
  }
};

/**
 * Runs `work` with `dirs` (repo-relative) and `registry.json` backed up. On a
 * failure everything is restored and the error says so (`nothing <outcome>`).
 */
export const applyChange = async <T>(
  deps: RegistryDeps,
  dirs: readonly string[],
  outcome: string,
  work: (change: Change) => Promise<T>
): Promise<T> => {
  const change = await beginChange(deps, dirs);
  try {
    return await work(change);
  } catch (error) {
    try {
      await restoreChange(deps, change);
    } catch (restoreError) {
      throw new Error(
        `${message(error)}; rollback failed, check ${dirs.join(", ")}, registry.json and git status: ${message(
          restoreError
        )}`,
        { cause: restoreError }
      );
    }
    throw new Error(`${message(error)} (rolled back, nothing ${outcome})`, {
      cause: error,
    });
  } finally {
    rmSync(change.temp, { force: true, recursive: true });
  }
};

/** Stages and commits the change's paths as the bot; resolves to the commit. */
export const commitChange = async (
  deps: RegistryDeps,
  change: Change,
  messages: readonly string[]
): Promise<string> => {
  const repo = ["-C", deps.root];
  change.staged = true;
  await deps.bot("git", [...repo, "add", ...change.paths]);
  await deps.bot("git", [
    ...repo,
    "commit",
    ...messages.flatMap((text) => ["-m", text]),
    ...change.paths,
  ]);
  return (await deps.git([...repo, "rev-parse", "HEAD"])).trim();
};

/** Pushes HEAD and `refspecs` in one atomic push as the bot. */
export const pushChange = async (
  deps: RegistryDeps,
  refspecs: readonly string[] = []
): Promise<void> => {
  await deps.bot("git", [
    "-C",
    deps.root,
    "push",
    "--atomic",
    "origin",
    "HEAD",
    ...refspecs,
  ]);
};

// ---------------------------------------------------------------------------
// Real dependencies (CLI)

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

/** Cost of the Claude Code session that made the latest tool call. */
const currentRunCost = (): number | null => {
  try {
    return computeCost(peekRunUsage(currentSessionId(REPO_ROOT), REPO_ROOT))
      .totalUsd;
  } catch {
    // Outside Claude Code (or before the budget hook ran): unknown.
    return null;
  }
};

export const realDeps: RegistryDeps = {
  bot: (cmd, args) => runAsBot(cmd, args),
  costUsd: currentRunCost,
  credentials: async () => {
    requireEnvVars(GITHUB_APP_ENV);
    await botEnv();
  },
  git: async (args) =>
    (await execFileAsync("git", args, { encoding: "utf8", windowsHide: true }))
      .stdout,
  now: () => new Date(),
  root: REPO_ROOT,
  runExamples: runExamplesScript,
};
