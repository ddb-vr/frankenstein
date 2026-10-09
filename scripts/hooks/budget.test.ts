import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { checkBudget, getRunUsage, type Limits } from "./budget.ts";
import { hookInput, recordedInput, runHookProcess } from "./testing.ts";

const SESSION = "6f1c2a7e-0b8d-4d6b-9a51-2f4e8c1d3b90";
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const BUILDER_CAP = /skill-builder cap reached \(2\/2/;
const BUDGET_EXHAUSTED = /run budget exhausted/;
const NO_PRICE = /No price known/;
const MUST_BE_POSITIVE = /BUDGET_USD_PER_RUN must be a positive number/;

let root = "";
let transcript = "";
let subagentDir = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "budget-test-"));
  const projectDir = path.join(root, "claude-projects", "-repo");
  transcript = path.join(projectDir, `${SESSION}.jsonl`);
  subagentDir = path.join(projectDir, SESSION, "subagents");
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(transcript, "");
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/** One transcript line as Claude Code writes it (one per content block). */
const assistantLine = (
  id: string,
  model: string,
  usage: { cacheRead?: number; input?: number; output: number }
): string =>
  `${JSON.stringify({
    message: {
      content: [{ text: "…", type: "text" }],
      id,
      model,
      role: "assistant",
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: usage.cacheRead ?? 0,
        input_tokens: usage.input ?? 0,
        output_tokens: usage.output,
      },
    },
    sessionId: SESSION,
    type: "assistant",
  })}\n`;

const call = (
  toolName: string,
  toolInput: Record<string, unknown>,
  limits: Limits = { budgetUsd: 100, maxBuilderIterations: 2 }
) =>
  checkBudget(
    hookInput(toolName, toolInput, {
      session_id: SESSION,
      transcript_path: transcript,
    }),
    root,
    limits
  );

const usageByModel = () =>
  Object.fromEntries(
    getRunUsage(SESSION, root).map(({ model, output, input }) => [
      model,
      { input, output },
    ])
  );

test("skill-builder invocations are capped; other agents are not counted", () => {
  const builder = { prompt: "build", subagent_type: "skill-builder" };
  assert.equal(call("Agent", builder), undefined);
  assert.equal(call("Agent", { subagent_type: "prd-writer" }), undefined);
  assert.equal(call("Task", builder), undefined);
  assert.match(call("Agent", builder) ?? "", BUILDER_CAP);
  // Denied attempts are not counted; the cap stays.
  assert.match(call("Task", builder) ?? "", BUILDER_CAP);
  assert.equal(call("Agent", { subagent_type: "skill-reviewer" }), undefined);
});

test("spend at the budget blocks every tool except a plain tracker call", () => {
  // 500k Opus output tokens = $10.
  appendFileSync(transcript, assistantLine("msg_1", OPUS, { output: 500_000 }));
  const limits = { budgetUsd: 10, maxBuilderIterations: 5 };
  assert.match(
    call("Read", { file_path: "/repo/README.md" }, limits) ?? "",
    BUDGET_EXHAUSTED
  );
  assert.equal(
    call(
      "Bash",
      {
        command:
          'node scripts/tracker.ts blocked --issue 3 --reason "budget exhausted"',
      },
      limits
    ),
    undefined
  );
  assert.match(
    call(
      "Bash",
      { command: "node scripts/tracker.ts x && rm -rf work" },
      limits
    ) ?? "",
    BUDGET_EXHAUSTED
  );
  assert.equal(
    call(
      "Read",
      { file_path: "/repo/README.md" },
      { ...limits, budgetUsd: 10.01 }
    ),
    undefined
  );
});

test("over budget, only Read of work/<skill>/issue.json is allowed besides tracker", () => {
  appendFileSync(transcript, assistantLine("msg_1", OPUS, { output: 500_000 }));
  const limits = { budgetUsd: 10, maxBuilderIterations: 5 };
  const read = (filePath: string) =>
    call("Read", { file_path: filePath }, limits);
  assert.equal(
    read(path.join(root, "work", "ico-validator", "issue.json")),
    undefined
  );
  for (const denied of [
    path.join(root, "work", "ico-validator", "review.json"),
    path.join(root, "work", "ico-validator", "scripts", "issue.json"),
    path.join(root, "work", "..", "issue.json"),
    path.join(root, "work", "Bad_Name", "issue.json"),
    path.join(tmpdir(), "work", "ico-validator", "issue.json"),
  ]) {
    assert.match(read(denied) ?? "", BUDGET_EXHAUSTED, denied);
  }
  assert.match(
    call(
      "Write",
      { file_path: path.join(root, "work", "ico-validator", "issue.json") },
      limits
    ) ?? "",
    BUDGET_EXHAUSTED
  );
});

test("transcripts are read incrementally from the stored offset", () => {
  appendFileSync(transcript, assistantLine("msg_1", OPUS, { output: 100 }));
  // Claude Code repeats a message's usage on every content block line.
  appendFileSync(transcript, assistantLine("msg_1", OPUS, { output: 100 }));
  appendFileSync(transcript, '{"type":"user","message":{"role":"user"}}\n');
  assert.equal(call("Read", {}), undefined);
  assert.deepEqual(usageByModel(), { [OPUS]: { input: 0, output: 100 } });

  // A partial trailing line is not counted until it is complete.
  const next = assistantLine("msg_2", OPUS, { input: 7, output: 50 });
  appendFileSync(transcript, next.slice(0, 40));
  assert.deepEqual(usageByModel(), { [OPUS]: { input: 0, output: 100 } });
  appendFileSync(transcript, next.slice(40));
  assert.deepEqual(usageByModel(), { [OPUS]: { input: 7, output: 150 } });

  // Bytes before the offset are never read again.
  writeFileSync(
    transcript,
    assistantLine("msg_x", OPUS, { output: 999_999 }).padEnd(1000, " ")
  );
  appendFileSync(transcript, "\n");
  assert.deepEqual(usageByModel(), { [OPUS]: { input: 7, output: 150 } });
});

test("subagent transcripts of the session count towards spend", () => {
  appendFileSync(transcript, assistantLine("msg_1", OPUS, { output: 10 }));
  writeFileSync(
    path.join(subagentDir, "agent-a1b2.jsonl"),
    assistantLine("msg_s1", SONNET, { output: 20 }) +
      assistantLine("msg_s2", SONNET, { output: 30 })
  );
  writeFileSync(path.join(subagentDir, "agent-a1b2.meta.json"), "{}");
  assert.equal(call("Read", {}), undefined);
  assert.deepEqual(usageByModel(), {
    [OPUS]: { input: 0, output: 10 },
    [SONNET]: { input: 0, output: 50 },
  });
});

test("usage from an unpriced model fails closed", () => {
  appendFileSync(
    transcript,
    assistantLine("msg_1", "claude-unknown-1", { output: 1 })
  );
  assert.throws(() => call("Read", {}), NO_PRICE);
});

test("hook process denies when a cap is invalid", async () => {
  const run = await runHookProcess(
    "budget.ts",
    JSON.stringify(recordedInput("Read", { file_path: "/x" })),
    { BUDGET_USD_PER_RUN: "0", MAX_BUILDER_ITERATIONS: "3" }
  );
  assert.equal(run.exitCode, 2);
  assert.match(run.reason ?? "", MUST_BE_POSITIVE);
});
