import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { auditRun } from "./audit-run.ts";
import { installAuditFixture } from "./lib/audit-fixture.ts";

const HOST_EXECUTION_REASON = /^host execution: `node` ran /;
const scratch: string[] = [];

after(async () => {
  await Promise.all(
    scratch.map((dir) => rm(dir, { force: true, recursive: true }))
  );
});

const install = async (name: string) => {
  const dir = await mkdtemp(join(tmpdir(), "audit-run-test-"));
  scratch.push(dir);
  return installAuditFixture(name, dir);
};

test("clean run: runner calls only, every sandbox run accounted for", async () => {
  const { root, sessionId } = await install("clean");
  assert.deepEqual(auditRun(sessionId, root), {
    bashCommands: 10,
    denials: 0,
    hostExecutions: 0,
    // 3 run-examples logs (unit tests + 8 examples each) and 1 run-skill log.
    sandboxRuns: 28,
    session: sessionId,
    violations: [],
  });
});

test("host execution: skill code run by node outside the runners", async () => {
  const { root, sessionId } = await install("host-execution");
  const report = auditRun(sessionId, root);
  assert.equal(report.hostExecutions, 2);
  assert.equal(report.sandboxRuns, 9);
  assert.deepEqual(
    report.violations.map(({ command }) => command),
    [
      "true && node work/ico-validator/scripts/main.ts < /dev/null",
      `cd ${root}/work/ico-validator && node --test tests/`,
    ]
  );
  for (const { reason } of report.violations) {
    assert.match(reason, HOST_EXECUTION_REASON);
  }
});

test("denied attempts are counted, not treated as host executions", async () => {
  const { root, sessionId } = await install("denied");
  assert.deepEqual(auditRun(sessionId, root), {
    bashCommands: 21,
    denials: 20,
    hostExecutions: 0,
    // Only the allowed run-skill call; earlier logs are outside the session.
    sandboxRuns: 1,
    session: sessionId,
    violations: [],
  });
});

test("transcript calls missing from the logs are violations", async () => {
  const { root, sessionId } = await install("clean");
  const hookLog = join(root, "logs", "hooks.log");
  const runSkill = `node scripts/run-skill.ts ico-validator '{"ico":["27082440"]}'`;
  const lines = (await readFile(hookLog, "utf8")).split("\n");
  await writeFile(
    hookLog,
    lines
      .filter(
        (line) => !line.endsWith(`guard-bash\tallow\tno objection\t${runSkill}`)
      )
      .join("\n")
  );
  await rm(join(root, "logs", "ico-validator", "2026-10-08T21-47-46.log"));
  await rm(
    join(root, "logs", "ico-validator", "run-2026-10-08T21-50-38.143Z.log")
  );

  assert.deepEqual(auditRun(sessionId, root).violations, [
    {
      command: runSkill,
      reason: "no guard-bash allow for it in logs/hooks.log",
    },
    {
      command: runSkill,
      reason:
        "no sandbox run log logs/ico-validator/run-*.log for this run-skill call",
    },
    {
      command: "node scripts/run-examples.ts work/ico-validator",
      reason:
        "run log logs/ico-validator/2026-10-08T21-47-46.log not found among the session's logs",
    },
  ]);
});

test("a session without hook decisions cannot be cross-checked", async () => {
  const { root, sessionId } = await install("denied");
  await rm(join(root, "logs", "hooks.log"));
  assert.deepEqual(auditRun(sessionId, root).violations, [
    {
      command: "logs/hooks.log",
      reason:
        "no hook decisions logged during the session; tool calls cannot be cross-checked",
    },
  ]);
});
