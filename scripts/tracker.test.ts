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
import { parseLocalIssue } from "./lib/local-issues.ts";
import { computeCost } from "./lib/pricing.ts";
import {
  formatBlockedComment,
  formatDoneComment,
  formatOpenBody,
  issueTitle,
  parseUsage,
  type RunOptions,
  run,
} from "./tracker.ts";

const execFileAsync = promisify(execFile);
const TRACKER = join(import.meta.dirname, "tracker.ts");
const REPO = "acme/frankenstein";
const PAT_ENV = { GH_TOKEN: "ghp_test", GITHUB_REPO: REPO };
const BACKEND_ENV = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_REPO",
  "GH_TOKEN",
] as const;
const QUIET: RunOptions = { log: () => undefined };
const LOCAL_NOT_FOUND = /local issue #9 not found \(tracker\/issues\/9\.md\)/;
const USAGE_SHAPE_ERROR = /JSON array/;
const NO_ACTIVE_RUN = /no active run/;
const CLEAN_AUDIT = {
  bashCommands: 10,
  denials: 0,
  deniedMounts: [],
  hostExecutions: 0,
  mounts: [],
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
// real repo even if dry-run were broken. The backend variables are set empty:
// `.env` never overrides a variable that is already set.
const runTracker = async (
  args: string[],
  env: Record<string, string> = {}
): Promise<unknown> => {
  const noBackend = Object.fromEntries(BACKEND_ENV.map((name) => [name, ""]));
  const { stdout } = await execFileAsync(
    process.execPath,
    [...process.execArgv, TRACKER, ...args],
    { cwd: workDir, env: { ...process.env, ...noBackend, ...env } }
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
    {
      ...CLEAN_AUDIT,
      denials: 3,
      deniedMounts: [{ command: "x", reason: "mount denied: x: y" }],
    },
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
      "**Sandbox audit:** sandbox runs 28, host executions 0, denials 3, denied mounts 1",
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
    PAT_ENV
  );
  assert.deepEqual(output, {
    backend: "pat",
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

// Runs `action` with exactly `vars` of the backend env set, restoring it
// afterwards (`run` loads `<root>/.env` into `process.env`).
const withEnv = async <T>(
  vars: Partial<Record<(typeof BACKEND_ENV)[number], string>>,
  action: () => Promise<T>
): Promise<T> => {
  const saved = BACKEND_ENV.map((name) => [name, process.env[name]] as const);
  const apply = (
    entries: readonly (readonly [string, string | undefined])[]
  ): void => {
    for (const [name, value] of entries) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
  apply(BACKEND_ENV.map((name) => [name, vars[name]]));
  try {
    return await action();
  } finally {
    apply(saved);
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

test("dry-run uses a placeholder repo when the GitHub App has no GITHUB_REPO", async () => {
  const root = await mkdtemp(join(workDir, "no-env-"));
  const output = (await withEnv(
    {
      GITHUB_APP_ID: "1",
      GITHUB_APP_INSTALLATION_ID: "2",
      GITHUB_APP_PRIVATE_KEY_PATH: "/keys/app.pem",
    },
    () => run(BLOCKED_DRY_RUN, { ...QUIET, root })
  )) as { backend: string; repo: string };
  assert.equal(output.backend, "github-app");
  assert.equal(output.repo, "OWNER/REPO");
});

test("dry-run reads the backend and GITHUB_REPO from the root's .env", async () => {
  const root = await mkdtemp(join(workDir, "with-env-"));
  await writeFile(
    join(root, ".env"),
    "GITHUB_REPO=from/dotenv\nGH_TOKEN=ghp_dotenv\n"
  );
  const output = (await withEnv({}, () =>
    run(BLOCKED_DRY_RUN, { ...QUIET, root })
  )) as { backend: string; repo: string };
  assert.equal(output.backend, "pat");
  assert.equal(output.repo, "from/dotenv");
});

test("blocked --dry-run plans label and comment", async () => {
  const output = await runTracker(
    ["blocked", "--issue", "7", "--reason", "Docker unavailable", "--dry-run"],
    PAT_ENV
  );
  assert.deepEqual(output, {
    backend: "pat",
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
  const output = await withEnv(PAT_ENV, () =>
    run(
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
      { ...QUIET, root }
    )
  );
  assert.deepEqual(output, {
    backend: "pat",
    calls: [
      {
        args: ["issue", "view", "7", "--repo", REPO, "--json", "labels"],
      },
      {
        args: [
          "issue",
          "edit",
          "7",
          "--repo",
          REPO,
          "--remove-label",
          "blocked",
        ],
      },
      {
        args: ["issue", "comment", "7", "--repo", REPO, "--body-file", "-"],
        stdin: formatDoneComment(
          "Built pdf-merge.",
          computeCost(SAMPLE_USAGE),
          CLEAN_AUDIT,
          "v2"
        ),
      },
      { args: ["issue", "close", "7", "--repo", REPO] },
    ],
    dryRun: true,
    repo: REPO,
    result: { issue: 7, state: "done", totalUsd: 11 },
  });
});

test("invalid input exits non-zero with a JSON error", async () => {
  await assert.rejects(
    runTracker(["blocked", "--issue", "abc", "--reason", "x", "--dry-run"]),
    (error: { code?: number; stderr?: string }) => {
      assert.equal(error.code, 1);
      // The backend log line comes first; the error is the last line.
      const lines = (error.stderr ?? "").trim().split("\n");
      assert.deepEqual(JSON.parse(lines.at(-1) ?? ""), {
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
    withEnv(PAT_ENV, () =>
      run(["done", "--issue", "7", "--summary", "Built.", "--dry-run"], {
        ...QUIET,
        root,
      })
    ) as Promise<{ result: { totalUsd: number } }>;
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

  const output = (await withEnv(PAT_ENV, () =>
    run(["done", "--issue", "7", "--summary", "Built.", "--dry-run"], {
      ...QUIET,
      root,
    })
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

test("local backend keeps open, blocked and done in tracker/issues/<n>.md", async () => {
  const root = await mkdtemp(join(workDir, "local-lifecycle-"));
  const logs: string[] = [];
  const times = [
    "2026-10-09T10:00:00.000Z",
    "2026-10-09T10:05:00.000Z",
    "2026-10-09T10:30:00.000Z",
  ];
  const clock = [...times];
  const options: RunOptions = {
    log: (line) => logs.push(line),
    now: () => new Date(clock.shift() ?? ""),
    root,
  };
  const file = join(root, "tracker", "issues", "1.md");
  const issue = async () =>
    parseLocalIssue(await readFile(file, "utf8"), "tracker/issues/1.md");

  const opened = await withEnv({}, () =>
    run(["open", "--skill", "pdf-merge", "--summary", "Merge PDFs."], options)
  );
  assert.deepEqual(opened, { issue: 1, url: "tracker/issues/1.md" });
  assert.deepEqual(
    JSON.parse(
      await readFile(join(root, "work", "pdf-merge", "issue.json"), "utf8")
    ),
    opened
  );
  assert.deepEqual(await issue(), {
    body: formatOpenBody("pdf-merge", "Merge PDFs."),
    closedAt: null,
    createdAt: times[0],
    labels: ["skill-build"],
    state: "open",
    title: "skill: pdf-merge",
    updatedAt: times[0],
  });

  assert.deepEqual(
    await withEnv({}, () =>
      run(
        ["blocked", "--issue", "1", "--reason", "Docker unavailable"],
        options
      )
    ),
    { issue: 1, state: "blocked" }
  );
  const blocked = await issue();
  assert.equal(blocked.state, "blocked");
  assert.deepEqual(blocked.labels, ["skill-build", "blocked"]);

  assert.deepEqual(
    await withEnv({}, () =>
      run(
        [
          "done",
          "--issue",
          "1",
          "--summary",
          "Built pdf-merge.",
          "--usage",
          usagePath,
          "--version",
          "v1",
        ],
        options
      )
    ),
    { issue: 1, state: "done", totalUsd: 11 }
  );
  const done = await issue();
  assert.deepEqual(
    { ...done, body: "" },
    {
      body: "",
      closedAt: times[2],
      createdAt: times[0],
      labels: ["skill-build"],
      state: "done",
      title: "skill: pdf-merge",
      updatedAt: times[2],
    }
  );
  // Outside Claude Code there is no session to audit; the comment says so.
  const [doneWithoutAudit] = formatDoneComment(
    "Built pdf-merge.",
    computeCost(SAMPLE_USAGE),
    { error: "" },
    "v1"
  ).split("**Sandbox audit:**");
  const comments = [
    formatOpenBody("pdf-merge", "Merge PDFs.").trimEnd(),
    "",
    "---",
    "",
    `**Comment** (${times[1]})`,
    "",
    formatBlockedComment("Docker unavailable").trimEnd(),
    "",
    "---",
    "",
    `**Comment** (${times[2]})`,
    "",
    `${doneWithoutAudit}**Sandbox audit:** unavailable (`,
  ].join("\n");
  assert.ok(done.body.startsWith(comments), done.body);
  assert.match(done.body, NO_ACTIVE_RUN);
  // One backend line per run.
  assert.equal(logs.length, 3);
  assert.ok(logs.every((line) => line.startsWith("tracker backend: local")));
});

test("local backend numbers issues, refuses unknown ones and writes nothing on dry-run", async () => {
  const root = await mkdtemp(join(workDir, "local-numbers-"));
  const open = (...flags: string[]) =>
    withEnv({}, () =>
      run(["open", "--skill", "csv-sum", "--summary", "Sum.", ...flags], {
        ...QUIET,
        root,
      })
    );
  assert.deepEqual(await open(), { issue: 1, url: "tracker/issues/1.md" });
  assert.deepEqual(await open(), { issue: 2, url: "tracker/issues/2.md" });
  await assert.rejects(
    withEnv({}, () =>
      run(["blocked", "--issue", "9", "--reason", "x"], { ...QUIET, root })
    ),
    LOCAL_NOT_FOUND
  );

  const planned = (await open("--dry-run")) as {
    backend: string;
    files: { content: string; path: string }[];
    result: unknown;
  };
  assert.equal(planned.backend, "local");
  assert.deepEqual(planned.result, { issue: 3, url: "tracker/issues/3.md" });
  assert.deepEqual(
    planned.files.map(({ path }) => path),
    ["tracker/issues/3.md"]
  );
  assert.deepEqual(await readdir(join(root, "tracker", "issues")), [
    "1.md",
    "2.md",
  ]);
});
