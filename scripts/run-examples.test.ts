import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failedTestNames,
  formatSummary,
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
