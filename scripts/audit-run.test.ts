import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { analyzeShellCommand, auditRun } from "./audit-run.ts";
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

test("a symlinked repo root still trusts the runners", async () => {
  const { root, sessionId } = await install("clean");
  const link = join(dirname(root), "linked-repo");
  await symlink(root, link, "junction");
  const report = auditRun(sessionId, link);
  assert.equal(report.hostExecutions, 0);
  assert.deepEqual(report.violations, []);
});

test("host execution classification of shell command lines", () => {
  const root = join(tmpdir(), "audit-classify-repo");
  const runsSkillCode = (command: string, cwd = root) =>
    analyzeShellCommand(command, cwd, root).hostExecution !== undefined;
  for (const command of [
    "node work/x/scripts/main.ts",
    "npx tsx work/x/scripts/main.ts",
    "node -e \"import('./work/x/scripts/ico.ts')\"",
    "node --test work/x/tests/",
    'bash -c "node work/x/scripts/main.ts"',
    "(cd work/x && node scripts/main.ts)",
    "echo work/x/scripts/main.ts | xargs node",
    "echo $(node work/x/scripts/main.ts)",
    "env node work/x/scripts/main.ts",
    "NODE_OPTIONS=--import=./work/x/a.ts node scripts/lock.ts x",
    "N=node; $N work/x/scripts/main.ts",
    "npm test -- work/x/tests/a.test.ts",
    "node --input-type=module < work/x/scripts/main.ts",
    "cat .claude/skills/x/scripts/main.ts | node",
    "./work/x/scripts/main.ts",
    "find work -name '*.ts' -exec node {} ;",
    "docker run -v ./work/x:/skill img",
    `cd ${join(root, "work", "x")} && python3 check.py`,
  ]) {
    assert.ok(runsSkillCode(command), command);
  }
  assert.ok(runsSkillCode("node scripts/main.ts", join(root, "work", "x")));

  for (const command of [
    "node scripts/run-examples.ts work/x",
    "node scripts/run-skill.ts x --input-file work/x/input.json",
    "echo '{}' | node scripts/run-skill.ts x --input-file /dev/stdin",
    "node scripts/tracker.ts done --issue 1 --summary 'built work/x'",
    "cat work/x/PRD.md",
    "cd work/x && ls; cat progress.md",
    "echo 'node work/x/main.ts'",
    "git commit -m 'run node work/x/main.ts'",
    "ls work/x && npm run check",
    "node scripts/lock.ts x",
  ]) {
    assert.ok(!runsSkillCode(command), command);
  }
  // Entry points are trusted only from the repo root.
  assert.ok(
    runsSkillCode("node scripts/run-examples.ts work/x", join(root, "work"))
  );
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
