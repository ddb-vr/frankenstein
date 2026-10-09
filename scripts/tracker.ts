// Build issue lifecycle: open / blocked / done (close with cost summary and
// sandbox audit). The backend is picked from the environment
// (`selectTrackerBackend`, logged once per run on stderr):
// - `github-app`: GitHub issues via `gh` as the GitHub App bot.
// - `pat`: the same `gh` calls as the user of `GH_TOKEN` on `GITHUB_REPO`.
// - `local`: `tracker/issues/<n>.md` (see `lib/local-issues.ts`) with the
//   same states, labels, bodies and comments.
//
//   node scripts/tracker.ts open    --skill <name> --summary <text>
//   node scripts/tracker.ts blocked --issue <n> --reason <text>
//   node scripts/tracker.ts done    --issue <n> --summary <text> [--usage <file>] [--version <vN>]
//
// `open` also writes `work/<skill>/issue.json` (`{ issue, url }`; locally the
// URL is `tracker/issues/<n>.md`). `done` without `--usage` reports the usage
// of the Claude Code session in `work/.run/current.json`, as tracked by
// `scripts/hooks/budget.ts`, and always appends the `scripts/audit-run.ts`
// result for that session.
//
// Every command accepts `--dry-run`: it prints the planned `gh` calls (or the
// local issue file contents) instead of running them and writes no files;
// needs no network. Dry-run still reads `.env` when present, so it shows the
// real backend and `GITHUB_REPO`, else a placeholder. Output is one JSON line.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { type AuditReport, auditRun } from "./audit-run.ts";
import { runAsBot, runCommand } from "./github-app-token.ts";
import { currentSessionId, getRunUsage, peekRunUsage } from "./hooks/budget.ts";
import {
  describeTrackerBackend,
  loadDotEnv,
  selectTrackerBackend,
  type TrackerBackend,
} from "./lib/env.ts";
import { SKILL_NAME } from "./lib/examples.ts";
import { type IssueRecord, writeIssueRecord } from "./lib/issue.ts";
import {
  formatLocalIssue,
  type LocalIssue,
  type LocalIssueFile,
  localIssuePath,
  nextLocalIssueNumber,
  readLocalIssue,
  withComment,
  writeLocalIssue,
} from "./lib/local-issues.ts";
import {
  type CostReport,
  computeCost,
  type UsageEntry,
} from "./lib/pricing.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const BUILD_LABEL = "skill-build";
const BLOCKED_LABEL = "blocked";
const PLACEHOLDER_REPO = "OWNER/REPO";
const DRY_RUN_ISSUE_NUMBER = 0;
const USD_DECIMALS = 4;
const ISSUE_URL_NUMBER = /\/issues\/(\d+)\s*$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;

const LABELS = [
  {
    color: "5319e7",
    description: "Skill build tracked by Frankenstein",
    name: BUILD_LABEL,
  },
  {
    color: "d93f0b",
    description: "Skill build is blocked",
    name: BLOCKED_LABEL,
  },
] as const;

// ---------------------------------------------------------------------------
// Formatting (pure, unit-tested)

export const issueTitle = (skill: string): string => `skill: ${skill}`;

export const formatOpenBody = (skill: string, summary: string): string =>
  `## Skill build: \`${skill}\`\n\n${summary.trim()}\n`;

export const formatBlockedComment = (reason: string): string =>
  `**Blocked:** ${reason.trim()}\n`;

const formatCount = (value: number): string => value.toLocaleString("en-US");
const formatUsd = (value: number): string => `$${value.toFixed(USD_DECIMALS)}`;

/** Audit of the closing session, or why it could not run. */
export type AuditOutcome = AuditReport | { error: string };

export const formatDoneComment = (
  summary: string,
  cost: CostReport,
  audit: AuditOutcome,
  version?: string
): string => {
  const lines = ["**Done.**", "", summary.trim(), ""];
  if (version) {
    lines.push(`**Version:** \`${version}\``, "");
  }
  lines.push(
    "### Cost",
    "",
    "| Model | Input | Cache write | Cache read | Output | USD |",
    "| --- | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const row of cost.perModel) {
    lines.push(
      `| \`${row.model}\` | ${formatCount(row.input)} | ${formatCount(row.cacheWrite)} | ${formatCount(row.cacheRead)} | ${formatCount(
        row.output
      )} | ${formatUsd(row.usd)} |`
    );
  }
  const { totals } = cost;
  lines.push(
    `| **Total** | ${formatCount(totals.input)} | ${formatCount(totals.cacheWrite)} | ${formatCount(totals.cacheRead)} | ${formatCount(
      totals.output
    )} | **${formatUsd(cost.totalUsd)}** |`
  );
  lines.push(
    "",
    "error" in audit
      ? `**Sandbox audit:** unavailable (${audit.error})`
      : `**Sandbox audit:** sandbox runs ${audit.sandboxRuns}, host executions ${audit.hostExecutions}, denials ${audit.denials}, denied mounts ${audit.deniedMounts.length}`
  );
  return `${lines.join("\n")}\n`;
};

// ---------------------------------------------------------------------------
// `gh` runners

export interface GhCall {
  args: string[];
  stdin?: string;
}

export type Gh = (args: string[], stdin?: string) => Promise<string>;

const ghRunners: Record<Exclude<TrackerBackend, "local">, Gh> = {
  "github-app": (args, stdin) => runAsBot("gh", args, { stdin }),
  // `gh` authenticates with `GH_TOKEN` from the environment (or `.env`).
  pat: (args, stdin) => runCommand("gh", args, process.env, stdin),
};

// Canned `gh` output so dry-run walks every step of each command.
const dryRunOutput = (args: readonly string[], repo: string): string => {
  const [group, action] = args;
  if (group === "issue" && action === "create") {
    return `https://github.com/${repo}/issues/${DRY_RUN_ISSUE_NUMBER}\n`;
  }
  if (group === "issue" && action === "view") {
    return JSON.stringify({ labels: [{ name: BLOCKED_LABEL }] });
  }
  return "";
};

const recordingGh =
  (calls: GhCall[], repo: string): Gh =>
  (args, stdin) => {
    calls.push(stdin === undefined ? { args } : { args, stdin });
    return Promise.resolve(dryRunOutput(args, repo));
  };

// ---------------------------------------------------------------------------
// Backends

/** Issue operations of one backend; titles, bodies and comments are formatted. */
interface Tracker {
  block: (issue: number, comment: string) => Promise<void>;
  /** Removes the `blocked` label, comments and closes. */
  complete: (issue: number, comment: string) => Promise<void>;
  open: (title: string, body: string) => Promise<IssueRecord>;
}

interface Context {
  gh: Gh;
  repo: string;
}

const issueNumberFromUrl = (url: string): number => {
  const match = ISSUE_URL_NUMBER.exec(url);
  if (!match?.[1]) {
    throw new Error(`Unexpected gh issue create output: ${url.trim()}`);
  }
  return Number(match[1]);
};

const hasLabel = (viewJson: string, label: string): boolean => {
  const parsed: unknown = JSON.parse(viewJson);
  if (typeof parsed !== "object" || parsed === null || !("labels" in parsed)) {
    return false;
  }
  const { labels } = parsed;
  return (
    Array.isArray(labels) &&
    labels.some(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        entry.name === label
    )
  );
};

const githubTracker = ({ gh, repo }: Context): Tracker => ({
  block: async (issue, comment) => {
    const ref = String(issue);
    await gh([
      "issue",
      "edit",
      ref,
      "--repo",
      repo,
      "--add-label",
      BLOCKED_LABEL,
    ]);
    await gh(
      ["issue", "comment", ref, "--repo", repo, "--body-file", "-"],
      comment
    );
  },
  complete: async (issue, comment) => {
    const ref = String(issue);
    const view = await gh([
      "issue",
      "view",
      ref,
      "--repo",
      repo,
      "--json",
      "labels",
    ]);
    if (hasLabel(view, BLOCKED_LABEL)) {
      await gh([
        "issue",
        "edit",
        ref,
        "--repo",
        repo,
        "--remove-label",
        BLOCKED_LABEL,
      ]);
    }
    await gh(
      ["issue", "comment", ref, "--repo", repo, "--body-file", "-"],
      comment
    );
    await gh(["issue", "close", ref, "--repo", repo]);
  },
  open: async (title, body) => {
    await Promise.all(
      LABELS.map(({ name, color, description }) =>
        gh([
          "label",
          "create",
          name,
          "--repo",
          repo,
          "--color",
          color,
          "--description",
          description,
          "--force",
        ])
      )
    );
    const url = (
      await gh(
        [
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          title,
          "--label",
          BUILD_LABEL,
          "--body-file",
          "-",
        ],
        body
      )
    ).trim();
    return { issue: issueNumberFromUrl(url), url };
  },
});

/** `save` writes (or, in dry-run, records) a file; `create` never replaces one. */
type SaveLocalIssue = (file: LocalIssueFile, create: boolean) => void;

const localTracker = (
  root: string,
  now: () => Date,
  save: SaveLocalIssue
): Tracker => {
  const update = (
    issue: number,
    comment: string,
    change: (
      current: LocalIssue,
      at: string
    ) => Pick<LocalIssue, "closedAt" | "labels" | "state">
  ): Promise<void> => {
    const current = readLocalIssue(root, issue);
    const at = now().toISOString();
    const next = withComment(
      { ...current, ...change(current, at) },
      at,
      comment
    );
    save(
      { content: formatLocalIssue(next), path: localIssuePath(issue) },
      false
    );
    return Promise.resolve();
  };
  return {
    block: (issue, comment) =>
      update(issue, comment, ({ closedAt, labels }) => ({
        closedAt,
        labels: labels.includes(BLOCKED_LABEL)
          ? labels
          : [...labels, BLOCKED_LABEL],
        state: "blocked",
      })),
    complete: (issue, comment) =>
      update(issue, comment, ({ labels }, at) => ({
        closedAt: at,
        labels: labels.filter((label) => label !== BLOCKED_LABEL),
        state: "done",
      })),
    open: (title, body) => {
      const issue = nextLocalIssueNumber(root);
      const at = now().toISOString();
      const file = localIssuePath(issue);
      save(
        {
          content: formatLocalIssue({
            body,
            closedAt: null,
            createdAt: at,
            labels: [BUILD_LABEL],
            state: "open",
            title,
            updatedAt: at,
          }),
          path: file,
        },
        true
      );
      return Promise.resolve({ issue, url: file });
    },
  };
};

// ---------------------------------------------------------------------------
// Sandbox audit

/** The audit is reported, never fatal: closing the issue must not fail on it. */
const auditCurrentRun = (root: string): AuditOutcome => {
  try {
    return auditRun(currentSessionId(root), root);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

// ---------------------------------------------------------------------------
// Input parsing

const USAGE_KEYS = ["input", "cacheWrite", "cacheRead", "output"] as const;

const isUsageEntry = (value: unknown): value is UsageEntry => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.model === "string" &&
    (record.longPrompt === undefined ||
      typeof record.longPrompt === "boolean") &&
    USAGE_KEYS.every(
      (key) =>
        typeof record[key] === "number" &&
        Number.isFinite(record[key]) &&
        record[key] >= 0
    )
  );
};

export const parseUsage = (json: string): UsageEntry[] => {
  const parsed: unknown = JSON.parse(json);
  if (!(Array.isArray(parsed) && parsed.every(isUsageEntry))) {
    throw new Error(
      "Usage file must be a JSON array of { model, input, cacheWrite, cacheRead, output, longPrompt? }"
    );
  }
  return parsed;
};

const requireText = (value: string | undefined, flag: string): string => {
  if (!value?.trim()) {
    throw new Error(`Missing required --${flag}`);
  }
  return value;
};

const requireIssue = (value: string | undefined): number => {
  if (!(value && POSITIVE_INTEGER.test(value))) {
    throw new Error("--issue must be a positive integer");
  }
  return Number(value);
};

const resolveRepo = (dryRun: boolean): string => {
  const repo = process.env.GITHUB_REPO;
  if (repo) {
    return repo;
  }
  if (dryRun) {
    return PLACEHOLDER_REPO;
  }
  throw new Error("Missing required env var GITHUB_REPO");
};

const CLI_OPTIONS = {
  "dry-run": { default: false, type: "boolean" },
  issue: { type: "string" },
  reason: { type: "string" },
  skill: { type: "string" },
  summary: { type: "string" },
  usage: { type: "string" },
  version: { type: "string" },
} as const;

export interface RunOptions {
  /** Replaces the GitHub backends' `gh` outside dry-run (tests). */
  gh?: Gh;
  /** Receives the backend log line; default stderr. */
  log?: (line: string) => void;
  /** Clock for local issue timestamps. */
  now?: () => Date;
  /** Repo whose `.env` is loaded and whose `work/` and `tracker/` hold issue records and run state. */
  root?: string;
}

export const run = async (
  argv: string[],
  {
    gh,
    log = (line) => process.stderr.write(line),
    now = () => new Date(),
    root = REPO_ROOT,
  }: RunOptions = {}
): Promise<unknown> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: CLI_OPTIONS,
    strict: true,
  });
  const [command] = positionals;
  const dryRun = values["dry-run"];
  loadDotEnv(root);
  const backend = selectTrackerBackend();
  log(describeTrackerBackend(backend));
  const calls: GhCall[] = [];
  const files: LocalIssueFile[] = [];
  let repo = "";
  let tracker: Tracker;
  if (backend === "local") {
    tracker = localTracker(
      root,
      now,
      dryRun
        ? (file) => files.push(file)
        : (file, create) => writeLocalIssue(root, file, create)
    );
  } else {
    repo = resolveRepo(dryRun);
    tracker = githubTracker({
      gh: dryRun ? recordingGh(calls, repo) : (gh ?? ghRunners[backend]),
      repo,
    });
  }

  let result: unknown;
  switch (command) {
    case "open": {
      const skill = requireText(values.skill, "skill");
      if (!SKILL_NAME.test(skill)) {
        throw new Error(`invalid skill name "${skill}"`);
      }
      const opened = await tracker.open(
        issueTitle(skill),
        formatOpenBody(skill, requireText(values.summary, "summary"))
      );
      if (!dryRun) {
        writeIssueRecord(root, skill, opened);
      }
      result = opened;
      break;
    }
    case "blocked": {
      const issue = requireIssue(values.issue);
      await tracker.block(
        issue,
        formatBlockedComment(requireText(values.reason, "reason"))
      );
      result = { issue, state: "blocked" };
      break;
    }
    case "done": {
      const issue = requireIssue(values.issue);
      const summary = requireText(values.summary, "summary");
      const sessionUsage = dryRun ? peekRunUsage : getRunUsage;
      const usage = values.usage
        ? parseUsage(await readFile(values.usage, "utf8"))
        : sessionUsage(currentSessionId(root), root);
      const cost = computeCost(usage);
      await tracker.complete(
        issue,
        formatDoneComment(summary, cost, auditCurrentRun(root), values.version)
      );
      result = { issue, state: "done", totalUsd: cost.totalUsd };
      break;
    }
    default:
      throw new Error(
        `Unknown command "${command ?? ""}". Use one of: open, blocked, done`
      );
  }

  if (!dryRun) {
    return result;
  }
  return backend === "local"
    ? { backend, dryRun, files, result }
    : { backend, calls, dryRun, repo, result };
};

const main = async (): Promise<void> => {
  try {
    const output = await run(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
