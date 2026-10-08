// GitHub issue lifecycle for skill builds via `gh`: open / blocked / done
// (close with cost summary). All writes run as the GitHub App bot.
//
//   node scripts/tracker.ts open    --skill <name> --summary <text>
//   node scripts/tracker.ts blocked --issue <n> --reason <text>
//   node scripts/tracker.ts done    --issue <n> --summary <text> [--usage <file>] [--version <vN>]
//
// `done` without `--usage` reports the current Claude Code session's usage
// (`CLAUDE_CODE_SESSION_ID`), as tracked by `scripts/hooks/budget.ts`.
//
// Every command accepts `--dry-run` (prints the planned `gh` calls instead of
// running them; needs no `.env` and no network). Output is one JSON line.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { runAsBot } from "./github-app-token.ts";
import { getRunUsage } from "./hooks/budget.ts";
import { loadDotEnv } from "./lib/env.ts";
import {
  type CostReport,
  computeCost,
  type UsageEntry,
} from "./lib/pricing.ts";

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

export const formatDoneComment = (
  summary: string,
  cost: CostReport,
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
      `| \`${row.model}\` | ${formatCount(row.input)} | ${formatCount(row.cacheWrite)} | ${formatCount(row.cacheRead)} | ${formatCount(row.output)} | ${formatUsd(row.usd)} |`
    );
  }
  const { totals } = cost;
  lines.push(
    `| **Total** | ${formatCount(totals.input)} | ${formatCount(totals.cacheWrite)} | ${formatCount(totals.cacheRead)} | ${formatCount(totals.output)} | **${formatUsd(cost.totalUsd)}** |`
  );
  return `${lines.join("\n")}\n`;
};

// ---------------------------------------------------------------------------
// `gh` runners

export interface GhCall {
  args: string[];
  stdin?: string;
}

type Gh = (args: string[], stdin?: string) => Promise<string>;

const realGh: Gh = (args, stdin) => runAsBot("gh", args, { stdin });

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
// Commands

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

const openIssue = async (
  { gh, repo }: Context,
  skill: string,
  summary: string
): Promise<{ issue: number; url: string }> => {
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
        issueTitle(skill),
        "--label",
        BUILD_LABEL,
        "--body-file",
        "-",
      ],
      formatOpenBody(skill, summary)
    )
  ).trim();
  return { issue: issueNumberFromUrl(url), url };
};

const blockIssue = async (
  { gh, repo }: Context,
  issue: number,
  reason: string
): Promise<{ issue: number; state: "blocked" }> => {
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
    formatBlockedComment(reason)
  );
  return { issue, state: "blocked" };
};

const completeIssue = async (
  { gh, repo }: Context,
  issue: number,
  summary: string,
  cost: CostReport,
  version?: string
): Promise<{ issue: number; state: "done"; totalUsd: number }> => {
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
    formatDoneComment(summary, cost, version)
  );
  await gh(["issue", "close", ref, "--repo", repo]);
  return { issue, state: "done", totalUsd: cost.totalUsd };
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

const sessionUsage = (): UsageEntry[] => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) {
    throw new Error(
      "Missing --usage (outside Claude Code there is no CLAUDE_CODE_SESSION_ID)"
    );
  }
  return getRunUsage(sessionId);
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

export const run = async (argv: string[]): Promise<unknown> => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: CLI_OPTIONS,
    strict: true,
  });
  const [command] = positionals;
  const dryRun = values["dry-run"];
  if (!dryRun) {
    loadDotEnv();
  }
  const repo = resolveRepo(dryRun);
  const calls: GhCall[] = [];
  const ctx: Context = { gh: dryRun ? recordingGh(calls, repo) : realGh, repo };

  let result: unknown;
  switch (command) {
    case "open":
      result = await openIssue(
        ctx,
        requireText(values.skill, "skill"),
        requireText(values.summary, "summary")
      );
      break;
    case "blocked":
      result = await blockIssue(
        ctx,
        requireIssue(values.issue),
        requireText(values.reason, "reason")
      );
      break;
    case "done": {
      const issue = requireIssue(values.issue);
      const summary = requireText(values.summary, "summary");
      const usage = values.usage
        ? parseUsage(await readFile(values.usage, "utf8"))
        : sessionUsage();
      const cost = computeCost(usage);
      result = await completeIssue(ctx, issue, summary, cost, values.version);
      break;
    }
    default:
      throw new Error(
        `Unknown command "${command ?? ""}". Use one of: open, blocked, done`
      );
  }

  return dryRun ? { calls, dryRun: true, repo, result } : result;
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
