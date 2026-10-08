import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { checkBudget } from "./hooks/budget.ts";
import { hookInput } from "./hooks/testing.ts";
import { installAuditFixture } from "./lib/audit-fixture.ts";
import { computeCost } from "./lib/pricing.ts";
import {
  formatBlockedComment,
  formatDoneComment,
  formatOpenBody,
  issueTitle,
  parseUsage,
  run,
} from "./tracker.ts";

const execFileAsync = promisify(execFile);
const TRACKER = join(import.meta.dirname, "tracker.ts");
const REPO = "acme/frankenstein";
const USAGE_SHAPE_ERROR = /JSON array/;
const NO_ACTIVE_RUN = /no active run/;
const CLEAN_AUDIT = {
  bashCommands: 10,
  denials: 0,
  hostExecutions: 0,
  sandboxRuns: 28,
  session: "de781ccc-a467-4f65-a0af-77fa32bc81c4",
  violations: [],
};

const SAMPLE_USAGE = [
  {
    cacheRead: 2_000_000,
    cacheWrite: 200_000,
    input: 1_000_000,
    model: "claude-opus-5-5",
    output: 200_000,
  },
  {
    cacheRead: 1_000_000,
    cacheWrite: 0,
    input: 500_000,
    model: "claude-sonnet-5-5",
    output: 50_000,
  },
];

let workDir = "";
let usagePath = "";

before(async () => {
  workDir = await mkdtemp(join(tmpdir(), "tracker-test-"));
  usagePath = join(workDir, "usage.json");
  await writeFile(usagePath, JSON.stringify(SAMPLE_USAGE));
});

after(async () => {
  await rm(workDir, { force: true, recursive: true });
});

// Runs the CLI in a scratch cwd with no GitHub env, so it can never reach the
// real repo even if dry-run were broken.
const runTracker = async (
  args: string[],
  env: Record<string, string> = {}
): Promise<unknown> => {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GITHUB_"))
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [...process.execArgv, TRACKER, ...args],
    { cwd: workDir, env: { ...cleanEnv, ...env } }
  );
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1, "output is a single JSON line");
  return JSON.parse(lines[0] ?? "");
};

test("issueTitle and formatOpenBody", () => {
  assert.equal(issueTitle("pdf-merge"), "skill: pdf-merge");
  assert.equal(
    formatOpenBody("pdf-merge", "  Merge PDFs because no skill does.\n"),
    "## Skill build: `pdf-merge`\n\nMerge PDFs because no skill does.\n"
  );
});

test("formatBlockedComment", () => {
  assert.equal(
    formatBlockedComment("tests fail in sandbox "),
    "**Blocked:** tests fail in sandbox\n"
  );
});

test("formatDoneComment renders summary, version, cost table and audit", () => {
  const comment = formatDoneComment(
    "Built pdf-merge.",
    computeCost(SAMPLE_USAGE),
    { ...CLEAN_AUDIT, denials: 3 },
    "v2"
  );
  assert.equal(
    comment,
    [
      "**Done.**",
      "",
      "Built pdf-merge.",
      "",
      "**Version:** `v2`",
      "",
      "### Cost",
      "",
      "| Model | Input | Cache write | Cache read | Output | USD |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      "| `claude-opus-5-5` | 1,000,000 | 200,000 | 2,000,000 | 200,000 | $9.4000 |",
      "| `claude-sonnet-5-5` | 500,000 | 0 | 1,000,000 | 50,000 | $1.6000 |",
      "| **Total** | 1,500,000 | 200,000 | 3,000,000 | 250,000 | **$11.0000** |",
      "",
      "**Sandbox audit:** sandbox runs 28, host executions 0, denials 3",
      "",
    ].join("\n")
  );
});

test("formatDoneComment omits version and reports an unavailable audit", () => {
  const comment = formatDoneComment("Built.", computeCost([]), {
    error: "no active run",
  });
  assert.ok(!comment.includes("Version"));
  assert.ok(
    comment.endsWith("**Sandbox audit:** unavailable (no active run)\n")
  );
});

test("parseUsage rejects malformed usage", () => {
  assert.deepEqual(parseUsage(JSON.stringify(SAMPLE_USAGE)), SAMPLE_USAGE);
  assert.throws(() => parseUsage("{}"), USAGE_SHAPE_ERROR);
  assert.throws(
    () => parseUsage(JSON.stringify([{ input: -1, model: "x" }])),
    USAGE_SHAPE_ERROR
  );
  const longPrompt = [{ ...SAMPLE_USAGE[0], longPrompt: true }];
  assert.deepEqual(parseUsage(JSON.stringify(longPrompt)), longPrompt);
  assert.throws(
    () => parseUsage(JSON.stringify([{ ...SAMPLE_USAGE[0], longPrompt: 1 }])),
    USAGE_SHAPE_ERROR
  );
});

test("open --dry-run plans labels and issue creation", async () => {
  const output = await runTracker(
    ["open", "--skill", "pdf-merge", "--summary", "Merge PDFs.", "--dry-run"],
    { GITHUB_REPO: REPO }
  );
  assert.deepEqual(output, {
    calls: [
      {
        args: [
          "label",
          "create",
          "skill-build",
          "--repo",
          REPO,
          "--color",
          "5319e7",
          "--description",
          "Skill build tracked by Frankenstein",
          "--force",
        ],
      },
      {
        args: [
          "label",
          "create",
          "blocked",
          "--repo",
          REPO,
          "--color",
          "d93f0b",
          "--description",
          "Skill build is blocked",
          "--force",
        ],
      },
      {
        args: [
          "issue",
          "create",
          "--repo",
          REPO,
          "--title",
          "skill: pdf-merge",
          "--label",
          "skill-build",
          "--body-file",
          "-",
        ],
        stdin: "## Skill build: `pdf-merge`\n\nMerge PDFs.\n",
      },
    ],
    dryRun: true,
    repo: REPO,
    result: { issue: 0, url: `https://github.com/${REPO}/issues/0` },
  });
});

// Runs `run` in-process with `GITHUB_REPO` unset, restoring it afterwards
// (dry-run loads `<root>/.env` into `process.env`).
const withoutGitHubRepo = async <T>(action: () => Promise<T>): Promise<T> => {
  const saved = process.env.GITHUB_REPO;
  delete process.env.GITHUB_REPO;
  try {
    return await action();
  } finally {
    if (saved === undefined) {
      delete process.env.GITHUB_REPO;
    } else {
      process.env.GITHUB_REPO = saved;
    }
  }
};

const BLOCKED_DRY_RUN = [
  "blocked",
  "--issue",
  "7",
  "--reason",
  "x",
  "--dry-run",
];

test("dry-run uses a placeholder repo when GITHUB_REPO is unset and no .env", async () => {
  const root = await mkdtemp(join(workDir, "no-env-"));
  const output = (await withoutGitHubRepo(() =>
    run(BLOCKED_DRY_RUN, { root })
  )) as { repo: string };
  assert.equal(output.repo, "OWNER/REPO");
});

test("dry-run reads GITHUB_REPO from the root's .env", async () => {
  const root = await mkdtemp(join(workDir, "with-env-"));
  await writeFile(join(root, ".env"), "GITHUB_REPO=from/dotenv\n");
  const output = (await withoutGitHubRepo(() =>
    run(BLOCKED_DRY_RUN, { root })
  )) as { repo: string };
  assert.equal(output.repo, "from/dotenv");
});

test("blocked --dry-run plans label and comment", async () => {
  const output = await runTracker(
    ["blocked", "--issue", "7", "--reason", "Docker unavailable", "--dry-run"],
    { GITHUB_REPO: REPO }
  );
  assert.deepEqual(output, {
    calls: [
      {
        args: ["issue", "edit", "7", "--repo", REPO, "--add-label", "blocked"],
      },
      {
        args: ["issue", "comment", "7", "--repo", REPO, "--body-file", "-"],
        stdin: "**Blocked:** Docker unavailable\n",
      },
    ],
    dryRun: true,
    repo: REPO,
    result: { issue: 7, state: "blocked" },
  });
});

test("done --dry-run plans unblock, cost and audit comment, close", async () => {
  const { root } = await installAuditFixture("clean", join(workDir, "audited"));
  const output = await run(
    [
      "done",
      "--issue",
      "7",
      "--summary",
      "Built pdf-merge.",
      "--usage",
      usagePath,
      "--version",
      "v2",
      "--dry-run",
    ],
    { root }
  );
  const repo = process.env.GITHUB_REPO || "OWNER/REPO";
  assert.deepEqual(output, {
    calls: [
      {
        args: ["issue", "view", "7", "--repo", repo, "--json", "labels"],
      },
      {
        args: [
          "issue",
          "edit",
          "7",
          "--repo",
          repo,
          "--remove-label",
          "blocked",
        ],
      },
      {
        args: ["issue", "comment", "7", "--repo", repo, "--body-file", "-"],
        stdin: formatDoneComment(
          "Built pdf-merge.",
          computeCost(SAMPLE_USAGE),
          CLEAN_AUDIT,
          "v2"
        ),
      },
      { args: ["issue", "close", "7", "--repo", repo] },
    ],
    dryRun: true,
    repo,
    result: { issue: 7, state: "done", totalUsd: 11 },
  });
});

test("invalid input exits non-zero with a JSON error", async () => {
  await assert.rejects(
    runTracker(["blocked", "--issue", "abc", "--reason", "x", "--dry-run"]),
    (error: { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1);
      assert.deepEqual(JSON.parse(error.stderr ?? ""), {
        error: "--issue must be a positive integer",
      });
      return true;
    }
  );
});

test("done without --usage reports the session in work/.run/current.json", async () => {
  const root = join(workDir, "repo");
  await mkdir(root, { recursive: true });
  const done = () =>
    run(["done", "--issue", "7", "--summary", "Built.", "--dry-run"], {
      root,
    }) as Promise<{ result: { totalUsd: number } }>;
  await assert.rejects(done(), NO_ACTIVE_RUN);

  // Each session's budget hook call points current.json at that session.
  const toolCall = async (sessionId: string, outputTokens: number) => {
    const transcript = join(root, `${sessionId}.jsonl`);
    await writeFile(
      transcript,
      `${JSON.stringify({
        message: {
          id: `msg_${sessionId}`,
          model: "claude-opus-5-5",
          usage: { input_tokens: 0, output_tokens: outputTokens },
        },
        type: "assistant",
      })}\n`
    );
    checkBudget(
      hookInput(
        "Read",
        { file_path: "/x" },
        { session_id: sessionId, transcript_path: transcript }
      ),
      root,
      { budgetUsd: 100, maxBuilderIterations: 5 }
    );
  };
  const opusOutput = (output: number) =>
    computeCost([
      {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        model: "claude-opus-5-5",
        output,
      },
    ]).totalUsd;

  await toolCall("session-a", 100_000);
  assert.equal((await done()).result.totalUsd, opusOutput(100_000));
  await toolCall("session-b", 50_000);
  assert.equal((await done()).result.totalUsd, opusOutput(50_000));
});

test("done --dry-run reads session usage without touching budget state", async () => {
  const root = join(workDir, "peek-repo");
  await mkdir(root, { recursive: true });
  const sessionId = "session-peek";
  const transcript = join(root, `${sessionId}.jsonl`);
  const assistantLine = (id: string, outputTokens: number) =>
    `${JSON.stringify({
      message: {
        id,
        model: "claude-opus-5-5",
        usage: { input_tokens: 0, output_tokens: outputTokens },
      },
      type: "assistant",
    })}\n`;
  await writeFile(transcript, assistantLine("msg_1", 100_000));
  checkBudget(
    hookInput(
      "Read",
      { file_path: "/x" },
      { session_id: sessionId, transcript_path: transcript }
    ),
    root,
    { budgetUsd: 100, maxBuilderIterations: 5 }
  );
  // Usage the hook has not synced yet.
  await appendFile(transcript, assistantLine("msg_2", 50_000));

  const runDir = join(root, "work", ".run");
  const stateFile = join(runDir, `${sessionId}.json`);
  const stateBefore = await readFile(stateFile, "utf8");
  const entriesBefore = await readdir(runDir);

  const output = (await run(
    ["done", "--issue", "7", "--summary", "Built.", "--dry-run"],
    { root }
  )) as { result: { totalUsd: number } };
  assert.equal(
    output.result.totalUsd,
    computeCost([
      {
        cacheRead: 0,
        cacheWrite: 0,
        input: 0,
        model: "claude-opus-5-5",
        output: 150_000,
      },
    ]).totalUsd
  );
  assert.equal(await readFile(stateFile, "utf8"), stateBefore);
  assert.deepEqual(await readdir(runDir), entriesBefore);
});
