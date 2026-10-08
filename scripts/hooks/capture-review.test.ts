import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type CaptureOutcome, captureReview } from "./capture-review.ts";
import { runHookProcess } from "./testing.ts";

const SKILL = "ico-check";
const NOW = new Date("2026-10-08T12:00:00.000Z");
const NOT_RECORDED = /Your verdict was not recorded: no fenced `verdict` block/;
const NEEDS_REASON = /a reject needs at least one actionable reason/;
const UNKNOWN_SKILL = /work\/<skill> does not exist/;
const NO_VERDICT = /no verdict recorded/;
const FINAL = /is final \(round \d, (approve|reject)\)/;

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

const reject = {
  reasons: ["handle 7-digit IČO"],
  skill: SKILL,
  verdict: "reject",
};
const approve = { reasons: [], skill: SKILL, verdict: "approve" };

test("an approve is recorded and final", () => {
  assert.equal(stop(answer(approve)).kind, "written");
  assert.deepEqual(review(), {
    ...approve,
    reviewedAt: NOW.toISOString(),
    round: 1,
  });
  const again = stop(answer(reject));
  assert.equal(again.kind, "skipped");
  assert.match(again.kind === "skipped" ? again.message : "", FINAL);
  assert.partialDeepStrictEqual(review(), { verdict: "approve" });
});

test("a reject allows exactly one more review round", () => {
  stop(answer(reject));
  assert.deepEqual(review(), {
    ...reject,
    reviewedAt: NOW.toISOString(),
    round: 1,
  });
  stop(answer(approve));
  assert.deepEqual(review(), {
    ...approve,
    reviewedAt: NOW.toISOString(),
    round: 2,
  });

  rmSync(path.join(root, "work", SKILL, "review.json"));
  stop(answer(reject));
  stop(answer({ ...reject, reasons: ["still wrong"] }));
  const third = stop(answer(approve));
  assert.equal(third.kind, "skipped");
  assert.deepEqual(review(), {
    ...reject,
    reasons: ["still wrong"],
    reviewedAt: NOW.toISOString(),
    round: 2,
  });
});

test("the last verdict block in the answer wins", () => {
  stop(`Draft:\n${answer(reject)}\nOn reflection:\n${answer(approve)}`);
  assert.partialDeepStrictEqual(review(), { verdict: "approve" });
});

test("a malformed answer gets one retry, then nothing is recorded", () => {
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

  const retried = stop("Still no block.", false);
  assert.equal(retried.kind, "skipped");
  assert.match(retried.kind === "skipped" ? retried.message : "", NO_VERDICT);
  assert.throws(review);
});

test("a hand-back report is recorded and that reviewer's closing stop is ignored", () => {
  assert.equal(handback("No block here.").kind, "retry");
  assert.equal(handback(answer(reject)).kind, "written");
  assert.partialDeepStrictEqual(review(), { round: 1, verdict: "reject" });
  // Same agent: its closing text is not the report.
  assert.deepEqual(
    captureReview(
      {
        agentId: "a2",
        agentType: "skill-reviewer",
        message: "Handed back.",
        retryAllowed: true,
        source: "stop",
      },
      root,
      NOW
    ),
    { kind: "ignored" }
  );
  // A later reviewer without hand-back still reports at stop.
  assert.equal(stop("Handed back.").kind, "retry");
});

test("hook process blocks a malformed stop and ignores other agents", async () => {
  const run = (input: Record<string, unknown>) =>
    runHookProcess(
      "capture-review.ts",
      JSON.stringify({
        agent_id: "a1b2",
        cwd: root,
        hook_event_name: "SubagentStop",
        session_id: "6f1c2a7e-0b8d-4d6b-9a51-2f4e8c1d3b90",
        stop_hook_active: false,
        transcript_path: "/tmp/x.jsonl",
        ...input,
      })
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
});
