// Operator control over the skill registry (`npm run skills -- <command>`).
// `list` and `show` only read; the agent may run them. `disable`, `enable`,
// `rollback` and `remove` are for a human in a terminal (`guard-bash.ts`
// denies them to the agent): each commits as the GitHub App bot
// (`chore(registry): <action> <name>`), pushes and restores everything when a
// step before the push fails.

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { sha256File } from "../lock.ts";
import { SKILL_NAME } from "./examples.ts";
import {
  applyChange,
  BOT_CREDENTIALS,
  commitChange,
  disabledSkillPath,
  type HistoryAction,
  type HistoryEntry,
  localVersionTags,
  message,
  pushChange,
  type RegistryDeps,
  type RegistryEntry,
  readRegistry,
  saveEntry,
  skillPath,
  skillTag,
  versionNumber,
  writeRegistry,
} from "./registry.ts";

const VERSION = /^v[1-9]\d*$/;
/** `skill/<name>@vN`, capturing the name. */
export const SKILL_TAG = /^skill\/([a-z0-9][a-z0-9-]*)@v[1-9]\d*$/;
const FIELD_SEPARATOR = "\u001f";
const SHORT_COMMIT = 7;
const USD_DECIMALS = 2;
const NONE = "–";

// ---------------------------------------------------------------------------
// Read-only: list, show

export interface SkillSummary {
  enabled: boolean;
  installedAt: string;
  issue: number;
  name: string;
  network: boolean;
  /** Sum of the known install costs, `null` when none is known. */
  totalCostUsd: number | null;
  version: string;
}

export const listSkills = (root: string): SkillSummary[] =>
  readRegistry(root).skills.map((entry) => {
    const costs = entry.history
      .map((item) => item.costUsd)
      .filter((cost) => cost !== null);
    return {
      enabled: entry.enabled,
      installedAt: entry.installedAt,
      issue: entry.issue,
      name: entry.name,
      network: entry.network,
      totalCostUsd:
        costs.length === 0
          ? null
          : Number(costs.reduce((sum, cost) => sum + cost, 0).toFixed(6)),
      version: entry.version,
    };
  });

export interface TagInfo {
  /** Author of the tagged commit. */
  author: string;
  commit: string;
  /** Author date of the tagged commit (ISO 8601). */
  date: string;
  tag: string;
  version: string;
}

export interface SkillDetails {
  /** `null` when the skill is not in the registry (tags only). */
  entry: RegistryEntry | null;
  name: string;
  tags: TagInfo[];
}

const assertSkillName = (name: string): void => {
  if (!SKILL_NAME.test(name)) {
    throw new Error(`invalid skill name "${name}"`);
  }
};

/** All `skill/<name>@vN` tags with their commit, ascending by version. */
export const versionTags = async (
  deps: Pick<RegistryDeps, "git" | "root">,
  name: string
): Promise<TagInfo[]> => {
  // `*` atoms describe the commit an annotated tag points to; a lightweight
  // tag points to the commit itself.
  const format = [
    "%(refname:strip=2)",
    "%(*objectname)",
    "%(objectname)",
    "%(*authorname)",
    "%(authorname)",
    "%(*authordate:iso-strict)",
    "%(authordate:iso-strict)",
  ].join(FIELD_SEPARATOR);
  const output = await deps.git([
    "-C",
    deps.root,
    "for-each-ref",
    `--format=${format}`,
    `refs/tags/skill/${name}@v*`,
  ]);
  const prefix = `skill/${name}@`;
  const tags: TagInfo[] = [];
  for (const line of output.split("\n")) {
    const [tag = "", ...fields] = line.split(FIELD_SEPARATOR);
    const version = tag.slice(prefix.length);
    if (!(tag.startsWith(prefix) && VERSION.test(version))) {
      continue;
    }
    const [peeled, object, peeledAuthor, author, peeledDate, date] = fields;
    tags.push({
      author: peeledAuthor || author || "",
      commit: peeled || object || "",
      date: peeledDate || date || "",
      tag,
      version,
    });
  }
  return tags.sort(
    (a, b) => versionNumber(a.version) - versionNumber(b.version)
  );
};

export const showSkill = async (
  deps: Pick<RegistryDeps, "git" | "root">,
  name: string
): Promise<SkillDetails> => {
  assertSkillName(name);
  const entry =
    readRegistry(deps.root).skills.find((skill) => skill.name === name) ?? null;
  const tags = await versionTags(deps, name);
  if (entry === null && tags.length === 0) {
    throw new Error(`skill "${name}" is not installed and has no version tags`);
  }
  return { entry, name, tags };
};

const formatUsd = (usd: number | null): string =>
  usd === null ? NONE : `$${usd.toFixed(USD_DECIMALS)}`;

const formatTable = (
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): string => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length))
  );
  return [headers, ...rows]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd()
    )
    .join("\n");
};

export const formatList = (skills: readonly SkillSummary[]): string => {
  if (skills.length === 0) {
    return "No skills installed.";
  }
  return formatTable(
    [
      "NAME",
      "VERSION",
      "ENABLED",
      "NETWORK",
      "INSTALLED AT",
      "ISSUE",
      "TOTAL COST",
    ],
    skills.map((skill) => [
      skill.name,
      skill.version,
      skill.enabled ? "yes" : "no",
      skill.network ? "yes" : "no",
      skill.installedAt,
      `#${skill.issue}`,
      formatUsd(skill.totalCostUsd),
    ])
  );
};

export const formatShow = ({ entry, name, tags }: SkillDetails): string => {
  const lines: string[] = [];
  if (entry === null) {
    lines.push(`${name}: not in the registry (removed)`);
  } else {
    const state = entry.enabled ? "enabled" : "disabled";
    const network = entry.network ? "network" : "no network";
    lines.push(
      `${name} ${entry.version} (${state}, ${network}, issue #${entry.issue}, installed ${entry.installedAt})`,
      "",
      "History",
      formatTable(
        ["AT", "ACTION", "VERSION", "ISSUE", "COST", "BASE COMMIT"],
        entry.history.map((item) => [
          item.at,
          item.action,
          item.version,
          `#${item.issue}`,
          formatUsd(item.costUsd),
          item.commit?.slice(0, SHORT_COMMIT) ?? NONE,
        ])
      )
    );
  }
  lines.push("", "Tags");
  lines.push(
    tags.length === 0
      ? "No version tags."
      : formatTable(
          ["TAG", "COMMIT", "DATE", "AUTHOR"],
          tags.map((tag) => [
            tag.tag,
            tag.commit.slice(0, SHORT_COMMIT),
            tag.date,
            tag.author,
          ])
        )
  );
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Mutating: disable, enable, rollback, remove (human only)

export type OperatorResult =
  | {
      action: HistoryAction;
      commit: string;
      deletedTags?: string[];
      name: string;
      ok: true;
      version: string;
    }
  | { action: HistoryAction; name: string; ok: false; reason: string };

/** The registry entry of `name`; throws when it is missing. */
const requireEntry = (root: string, name: string): RegistryEntry => {
  assertSkillName(name);
  const entry = readRegistry(root).skills.find((skill) => skill.name === name);
  if (!entry) {
    throw new Error(`skill "${name}" is not installed`);
  }
  return entry;
};

const historyItem = (
  deps: RegistryDeps,
  action: HistoryAction,
  head: string,
  entry: Pick<RegistryEntry, "issue" | "version">
): HistoryEntry => ({
  action,
  at: deps.now().toISOString(),
  commit: head,
  costUsd: 0,
  issue: entry.issue,
  version: entry.version,
});

/** Runs an operator action; any error becomes `{ ok: false, reason }`. */
const operate = async (
  action: HistoryAction,
  name: string,
  run: () => Promise<
    Omit<OperatorResult & { ok: true }, "action" | "name" | "ok">
  >
): Promise<OperatorResult> => {
  try {
    return { action, name, ok: true, ...(await run()) };
  } catch (error) {
    return { action, name, ok: false, reason: message(error) };
  }
};

/** Moves the skill between `.claude/skills/` and `.claude/disabled-skills/`. */
const toggle = (
  deps: RegistryDeps,
  name: string,
  enabled: boolean
): Promise<OperatorResult> => {
  const action = enabled ? "enable" : "disable";
  return operate(action, name, async () => {
    const entry = requireEntry(deps.root, name);
    if (entry.enabled === enabled) {
      throw new Error(`skill "${name}" is already ${action}d`);
    }
    const [from, to] = enabled
      ? [disabledSkillPath(name), skillPath(name)]
      : [skillPath(name), disabledSkillPath(name)];
    if (!existsSync(path.join(deps.root, from))) {
      throw new Error(`${from} not found`);
    }
    if (existsSync(path.join(deps.root, to))) {
      throw new Error(`${to} already exists; move or delete it first`);
    }
    await deps.credentials();
    const commit = await applyChange(
      deps,
      [from, to],
      "changed",
      async (change) => {
        mkdirSync(path.dirname(path.join(deps.root, to)), { recursive: true });
        renameSync(path.join(deps.root, from), path.join(deps.root, to));
        saveEntry(deps.root, readRegistry(deps.root), {
          ...entry,
          enabled,
          history: [
            ...entry.history,
            historyItem(deps, action, change.head, entry),
          ],
        });
        const committed = await commitChange(deps, change, [
          `chore(registry): ${action} ${name}`,
        ]);
        await pushChange(deps);
        return committed;
      }
    );
    return { commit, version: entry.version };
  });
};

export const disableSkill = (
  name: string,
  deps: RegistryDeps
): Promise<OperatorResult> => toggle(deps, name, false);

export const enableSkill = (
  name: string,
  deps: RegistryDeps
): Promise<OperatorResult> => toggle(deps, name, true);

/** `--to`, or the highest tagged version below the current one. */
const rollbackTarget = async (
  deps: RegistryDeps,
  entry: RegistryEntry,
  to: string | undefined
): Promise<string> => {
  if (to !== undefined && !VERSION.test(to)) {
    throw new Error(`--to must be a version like v1, got "${to}"`);
  }
  const prefix = `skill/${entry.name}@`;
  const versions = (await localVersionTags(deps, entry.name)).map((tag) =>
    tag.slice(prefix.length)
  );
  const current = versionNumber(entry.version);
  const target =
    to ?? versions.findLast((version) => versionNumber(version) < current);
  if (target === undefined) {
    throw new Error(
      `no version before ${entry.version} is tagged; pass --to <vN>`
    );
  }
  if (target === entry.version) {
    throw new Error(`skill "${entry.name}" is already at ${target}`);
  }
  if (!versions.includes(target)) {
    throw new Error(`tag ${skillTag(entry.name, target)} not found`);
  }
  return target;
};

export const rollbackSkill = (
  name: string,
  options: { to?: string },
  deps: RegistryDeps
): Promise<OperatorResult> =>
  operate("rollback", name, async () => {
    const entry = requireEntry(deps.root, name);
    if (!entry.enabled) {
      throw new Error(
        `skill "${name}" is disabled; enable it before rolling back`
      );
    }
    const version = await rollbackTarget(deps, entry, options.to);
    const tag = skillTag(name, version);
    const dir = skillPath(name);
    const absolute = path.join(deps.root, dir);
    // The build issue of the restored version, when the history knows it.
    const issue =
      entry.history.findLast(
        (item) => item.action === "install" && item.version === version
      )?.issue ?? entry.issue;
    await deps.credentials();
    const commit = await applyChange(deps, [dir], "changed", async (change) => {
      rmSync(absolute, { force: true, recursive: true });
      // Worktree only: the index keeps HEAD until `commitChange` stages.
      await deps.git([
        "-C",
        deps.root,
        "restore",
        `--source=${tag}`,
        "--worktree",
        "--",
        dir,
      ]);
      const summary = await deps.runExamples(absolute);
      if (summary.status !== "PASS") {
        throw new Error(
          `run-examples failed on ${tag} at ${summary.stage}: ${summary.reason}`
        );
      }
      saveEntry(deps.root, readRegistry(deps.root), {
        ...entry,
        examplesHash: sha256File(path.join(absolute, "examples.json")),
        history: [
          ...entry.history,
          historyItem(deps, "rollback", change.head, { issue, version }),
        ],
        issue,
        version,
      });
      const committed = await commitChange(deps, change, [
        `chore(registry): rollback ${name} to ${version}`,
        `Restores ${tag}.`,
      ]);
      await pushChange(deps);
      return committed;
    });
    return { commit, version };
  });

/** `skill/<name>@vN` tags on origin; of every skill without `name`. */
export const remoteVersionTags = async (
  deps: RegistryDeps,
  name?: string
): Promise<string[]> => {
  const output = await deps.bot("git", [
    "-C",
    deps.root,
    ...BOT_CREDENTIALS,
    "ls-remote",
    "--tags",
    "origin",
  ]);
  return output
    .split("\n")
    .map((line) => line.split("\t")[1]?.trim().slice("refs/tags/".length))
    .filter((tag) => tag !== undefined)
    .filter((tag) => {
      const skill = SKILL_TAG.exec(tag)?.[1];
      return skill !== undefined && (name === undefined || skill === name);
    });
};

export const removeSkill = (
  name: string,
  options: { deleteTags: boolean },
  deps: RegistryDeps
): Promise<OperatorResult> =>
  operate("remove", name, async () => {
    const entry = requireEntry(deps.root, name);
    const dir = entry.enabled ? skillPath(name) : disabledSkillPath(name);
    await deps.credentials();
    const localTags = options.deleteTags
      ? await localVersionTags(deps, name)
      : [];
    const remoteTags = options.deleteTags
      ? await remoteVersionTags(deps, name)
      : [];
    const commit = await applyChange(deps, [dir], "removed", async (change) => {
      rmSync(path.join(deps.root, dir), { force: true, recursive: true });
      writeRegistry(
        deps.root,
        readRegistry(deps.root).skills.filter((skill) => skill.name !== name)
      );
      const committed = await commitChange(deps, change, [
        `chore(registry): remove ${name}`,
      ]);
      await pushChange(
        deps,
        remoteTags.map((tag) => `:refs/tags/${tag}`)
      );
      return committed;
    });
    // Pushed: from here on nothing is rolled back.
    if (localTags.length > 0) {
      try {
        await deps.bot("git", ["-C", deps.root, "tag", "-d", ...localTags]);
      } catch (error) {
        throw new Error(
          `removed and pushed as ${commit}, but deleting the local tags failed: ${message(error)}`,
          { cause: error }
        );
      }
    }
    const deletedTags = [...new Set([...localTags, ...remoteTags])].sort();
    return {
      commit,
      version: entry.version,
      ...(options.deleteTags ? { deletedTags } : {}),
    };
  });
