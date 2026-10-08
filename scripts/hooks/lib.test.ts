import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionSubject, formatLogLine } from "./lib.ts";

const TIME = new Date("2026-10-09T08:00:00.000Z");
const MAX_COMMAND = 200;

test("a log line is one tab-separated record with a short reason", () => {
  const line = formatLogLine(
    {
      decision: "deny",
      hook: "guard-bash",
      reason:
        "Blocked: skill code never runs on the host. Test it in the sandbox with `node scripts/run-examples.ts work/<skill>`.",
      subject: "cd work/x && python3 - <<'E'\nprint(1)\tx\nE",
    },
    TIME
  );
  assert.deepEqual(line.split("\t"), [
    "2026-10-09T08:00:00.000Z",
    "guard-bash",
    "deny",
    "skill code never runs on the host.",
    "cd work/x && python3 - <<'E'\\nprint(1)\\tx\\nE",
  ]);
});

test("commands are truncated to 200 characters", () => {
  const command = `node ${"x".repeat(500)}`;
  const [, , , , logged = ""] = formatLogLine(
    {
      decision: "allow",
      hook: "budget",
      reason: "no objection",
      subject: command,
    },
    TIME
  ).split("\t");
  assert.equal(logged.length, MAX_COMMAND);
  assert.ok(logged.endsWith("…"));
  assert.ok(command.startsWith(logged.slice(0, -1)));
});

test("the subject is the command, else tool and file path, else the tool", () => {
  assert.equal(decisionSubject("Bash", { command: "ls" }), "ls");
  assert.equal(
    decisionSubject("Write", { file_path: "/repo/work/x/a.ts" }),
    "Write /repo/work/x/a.ts"
  );
  assert.equal(decisionSubject("Agent", { prompt: "p" }), "Agent");
});
