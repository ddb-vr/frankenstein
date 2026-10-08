import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  failedTestNames,
  findUnitTests,
  formatSummary,
  lintReason,
  logTimestamp,
  MAX_REASON_LENGTH,
  truncateReason,
} from "./run-examples.ts";

test("truncateReason keeps short reasons and caps long ones at the limit", () => {
  const exact = "x".repeat(MAX_REASON_LENGTH);
  assert.equal(truncateReason(exact), exact);
  const long = truncateReason("y".repeat(MAX_REASON_LENGTH + 1));
  assert.equal(long.length, MAX_REASON_LENGTH);
  assert.ok(long.endsWith("…"));
});

test("formatSummary emits one JSON line and truncates FAIL reasons", () => {
  const line = formatSummary({
    example: "invalid checksum",
    log: "logs/x/a.log",
    reason: `expected\n${"z".repeat(2000)}`,
    stage: "examples",
    status: "FAIL",
  });
  assert.ok(!line.includes("\n"));
  const parsed = JSON.parse(line);
  assert.equal(parsed.example, "invalid checksum");
  assert.equal(parsed.reason.length, MAX_REASON_LENGTH);
});

test("formatSummary keeps the PASS shape", () => {
  const summary = {
    examples: { passed: 4, total: 4 },
    log: "logs/x/a.log",
    status: "PASS",
    unit: "pass",
  } as const;
  assert.deepEqual(JSON.parse(formatSummary(summary)), summary);
});

test("logTimestamp is filesystem-safe and second-precise", () => {
  assert.equal(
    logTimestamp(new Date("2026-10-08T21:30:00.123Z")),
    "2026-10-08T21-30-00"
  );
});

test("failedTestNames extracts failing test names from spec output", () => {
  const output = [
    "✔ passes (1.2ms)",
    "✖ counts words (3.4ms)",
    "ℹ fail 1",
    "✖ failing tests:",
    "",
    "test at tests/main.test.ts:5:1",
    "✖ counts words (3.4ms)",
  ].join("\n");
  assert.deepEqual(failedTestNames(output), ["counts words"]);
});

test("findUnitTests: no tests/ skips, an empty tests/ yields none, nested files count", (t) => {
  const skillDir = mkdtempSync(path.join(tmpdir(), "run-examples-test-"));
  t.after(() => rmSync(skillDir, { force: true, recursive: true }));
  assert.equal(findUnitTests(skillDir), undefined);

  const tests = path.join(skillDir, "tests");
  mkdirSync(path.join(tests, "nested"), { recursive: true });
  writeFileSync(path.join(tests, "helper.ts"), "");
  assert.deepEqual(findUnitTests(skillDir), []);

  writeFileSync(path.join(tests, "nested", "main.test.ts"), "");
  assert.deepEqual(
    findUnitTests(skillDir)?.map((file) => file.replaceAll("\\", "/")),
    ["tests/nested/main.test.ts"]
  );
});

test("lintReason names the fixer for the skill and lists every problem", () => {
  const reason = lintReason("ico-validator", [
    "× scripts/ico.ts:24:39: lint/style/noIncrementDecrement: Unexpected",
    "a.ts(1,7): error TS2322: Type 'string' is not assignable",
  ]);
  assert.ok(reason.startsWith("2 lint problem(s)"));
  assert.ok(reason.includes("`node scripts/fix-skill.ts ico-validator`"));
  assert.ok(reason.includes("noIncrementDecrement"));
  assert.ok(reason.includes("error TS2322"));
});
