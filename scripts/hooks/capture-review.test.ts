import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { lockFilePath } from "../lock.ts";
import {
  type CaptureOutcome,
  captureReview,
  NO_VALID_BLOCK,
} from "./capture-review.ts";
import { HOOK_LOG_ENV, REPO_ROOT } from "./lib.ts";
import { runHookProcess } from "./testing.ts";

const SKILL = "ico-check";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const HASH = "a".repeat(64);
const NOT_RECORDED = /Your verdict was not recorded: no fenced `verdict` block/;
const NEEDS_REASON = /a reject needs at least one actionable reason/;
const UNKNOWN_SKILL = /work\/other-skill does not exist/;
const NOT_JSON = /the `verdict` block is not valid JSON/;
const DUPLICATED = /found 2 fenced `verdict` blocks; send exactly one/;
const NO_SKILL_NAMED = /no existing work\/<skill> is named/;

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "capture-review-test-"));
  mkdirSync(path.join(root, "work", SKILL), { recursive: true });
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const answer = (verdict: unknown): string =>
  `Checked everything.\n\n\`\`\`verdict\n${JSON.stringify(verdict, null, 2)}\n\`\`\`\n`;

const stop = (message: string, retryAllowed = true): CaptureOutcome =>
  captureReview(
    {
      agentId: "a1",
      agentType: "skill-reviewer",
      message,
      retryAllowed,
      source: "stop",
    },
    root,
    NOW
  );

const handback = (message: string, agentId = "a2"): CaptureOutcome =>
  captureReview(
    {
      agentId,
      agentType: "skill-reviewer",
      message,
      retryAllowed: true,
      source: "handback",
    },
    root,
    NOW
  );

const review = (): unknown =>
  JSON.parse(
    readFileSync(path.join(root, "work", SKILL, "review.json"), "utf8")
  );

const reviewsLog = (): Record<string, unknown>[] =>
  readFileSync(path.join(root, "logs", SKILL, "reviews.log"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));

const reject = {
  reasons: ["handle 7-digit IČO"],
  skill: SKILL,
  verdict: "reject",
};
const approve = { reasons: [], skill: SKILL, verdict: "approve" };
const failClosed = {
  capturedAt: NOW.toISOString(),
  examplesHash: null,
  reasons: [NO_VALID_BLOCK],
  skill: SKILL,
  verdict: "reject",
};

const lock = (): void => {
  mkdirSync(path.dirname(lockFilePath(root, SKILL)), { recursive: true });
  writeFileSync(
    lockFilePath(root, SKILL),
    JSON.stringify({ lockedAt: NOW.toISOString(), sha256: HASH, skill: SKILL })
  );
};

test("a review records the examples hash of the lock", () => {
  lock();
  assert.equal(stop(answer(approve)).kind, "written");
  assert.deepEqual(review(), {
    ...approve,
    capturedAt: NOW.toISOString(),
    examplesHash: HASH,
  });
});

test("each new review supersedes the previous one, approve included", () => {
  stop(answer(approve));
  assert.partialDeepStrictEqual(review(), { verdict: "approve" });
  assert.equal(stop(answer(reject)).kind, "written");
  assert.deepEqual(review(), {
    ...reject,
    capturedAt: NOW.toISOString(),
    examplesHash: null,
  });
  stop(answer(approve));
  assert.partialDeepStrictEqual(review(), { verdict: "approve" });
  const asWritten = (verdict: object) => ({
    ...verdict,
    capturedAt: NOW.toISOString(),
    examplesHash: null,
  });
  assert.deepEqual(
    reviewsLog().map((entry) => [entry.outcome, entry.review]),
    [
      ["written", asWritten(approve)],
      ["written", asWritten(reject)],
      ["written", asWritten(approve)],
    ]
  );
});

test("more than one verdict block is invalid", () => {
  const twice = `Draft:\n${answer(reject)}\nOn reflection:\n${answer(approve)}`;
  const first = stop(twice);
  assert.match(first.kind === "retry" ? first.reason : "", DUPLICATED);
  assert.equal(stop(twice, false).kind, "written");
  assert.deepEqual(review(), failClosed);
});

test("a malformed answer gets one retry, then a reject is recorded", () => {
  const first = stop("Looks good to me.");
  assert.equal(first.kind, "retry");
  assert.match(first.kind === "retry" ? first.reason : "", NOT_RECORDED);

  const missingReason = stop(answer({ ...reject, reasons: [] }));
  assert.match(
    missingReason.kind === "retry" ? missingReason.reason : "",
    NEEDS_REASON
  );
  const unknown = stop(answer({ ...approve, skill: "other-skill" }));
  assert.match(unknown.kind === "retry" ? unknown.reason : "", UNKNOWN_SKILL);

  // No skill named: nothing to write.
  const unnamed = stop("Still no block.", false);
  assert.equal(unnamed.kind, "skipped");
  assert.match(
    unnamed.kind === "skipped" ? unnamed.message : "",
    NO_SKILL_NAMED
  );
  assert.throws(review);

  // The block names the skill: the earlier approve is replaced by a reject.
  stop(answer(approve));
  const invalid = `\`\`\`verdict\n{ "skill": "${SKILL}", "verdict": "approve", }\n\`\`\``;
  const retried = stop(invalid);
  assert.match(retried.kind === "retry" ? retried.reason : "", NOT_JSON);
  const final = stop(invalid, false);
  assert.equal(final.kind, "written");
  assert.match(final.kind === "written" ? (final.problem ?? "") : "", NOT_JSON);
  assert.deepEqual(review(), failClosed);
  // The unknown skill and the block-less answers name no existing skill.
  assert.deepEqual(
    reviewsLog().map(({ outcome, problem }) => [outcome, problem]),
    [
      ["retry", "a reject needs at least one actionable reason"],
      ["written", undefined],
      ["retry", "the `verdict` block is not valid JSON"],
      ["written", "the `verdict` block is not valid JSON"],
    ]
  );
});

test("a hand-back report is recorded and that reviewer's closing stop is ignored", () => {
  const closingStop = (agentId: string) =>
    captureReview(
      {
        agentId,
        agentType: "skill-reviewer",
        message: "Handed back.",
        retryAllowed: true,
        source: "stop",
      },
      root,
      NOW
    );
  assert.equal(handback("No block here.").kind, "retry");
  assert.equal(handback(answer(reject)).kind, "written");
  assert.partialDeepStrictEqual(review(), { verdict: "reject" });
  // Same agent: its closing text is not the report.
  assert.deepEqual(closingStop("a2"), { kind: "ignored" });
  // A later reviewer without hand-back still reports at stop.
  assert.equal(stop("Handed back.").kind, "retry");
  // A later hand-back supersedes the reject.
  assert.equal(handback(answer(approve), "a3").kind, "written");
  assert.partialDeepStrictEqual(review(), { verdict: "approve" });
});

test("hand-back retries are bounded: the second failure records a reject", () => {
  const invalid = answer({ ...reject, reasons: [] });
  assert.equal(handback(invalid, "a5").kind, "retry");
  assert.ok(existsSync(path.join(root, "work", ".run", "handback-a5.retry")));
  const second = handback(invalid, "a5");
  assert.equal(second.kind, "written");
  assert.deepEqual(review(), failClosed);
  // The hand-back was the report: its closing stop is ignored.
  assert.deepEqual(
    captureReview(
      {
        agentId: "a5",
        agentType: "skill-reviewer",
        message: "Done.",
        retryAllowed: true,
        source: "stop",
      },
      root,
      NOW
    ),
    { kind: "ignored" }
  );
});

test("hook process blocks a malformed stop, ignores other agents and logs each decision", async (t) => {
  const log = path.join(root, "hooks.log");
  // The process works on the real repo: a unique agent keeps its hand-back
  // retry marker apart from real runs; removed afterwards.
  const agentId = `test-${process.pid}-${Date.now()}`;
  t.after(() =>
    rmSync(path.join(REPO_ROOT, "work", ".run", `handback-${agentId}.retry`), {
      force: true,
    })
  );
  const run = (input: Record<string, unknown>) =>
    runHookProcess(
      "capture-review.ts",
      JSON.stringify({
        agent_id: agentId,
        cwd: root,
        hook_event_name: "SubagentStop",
        session_id: "6f1c2a7e-0b8d-4d6b-9a51-2f4e8c1d3b90",
        stop_hook_active: false,
        transcript_path: "/tmp/x.jsonl",
        ...input,
      }),
      { [HOOK_LOG_ENV]: log }
    );
  const blocked = await run({
    agent_type: "skill-reviewer",
    last_assistant_message: "Approved.",
  });
  assert.equal(blocked.exitCode, 0);
  const output = JSON.parse(blocked.stdout);
  assert.equal(output.decision, "block");
  assert.match(output.reason, NOT_RECORDED);

  const other = await run({ agent_type: "prd", last_assistant_message: "x" });
  assert.equal(other.exitCode, 0);
  assert.equal(other.stdout, "");

  const denied = await run({
    agent_type: "skill-reviewer",
    hook_event_name: "PreToolUse",
    tool_input: { message: "Approved." },
    tool_name: "SubagentHandback",
  });
  assert.equal(denied.exitCode, 0);
  assert.match(denied.reason ?? "", NOT_RECORDED);

  const logged = readFileSync(log, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => line.split("\t"));
  assert.deepEqual(
    logged.map(([, hook, decision, , subject]) => [hook, decision, subject]),
    [
      ["capture-review", "block", "SubagentStop skill-reviewer"],
      ["capture-review", "allow", "SubagentStop prd"],
      ["capture-review", "deny", "SubagentHandback skill-reviewer"],
    ]
  );
});
