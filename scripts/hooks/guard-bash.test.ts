import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCommand, checkShell } from "./guard-bash.ts";
import { REPO_ROOT } from "./lib.ts";
import { hookInput, recordedInput, runHookProcess } from "./testing.ts";

const ROOT = "/repo";
const PROTECTED = /protected files/;
const HOST_EXEC = /never runs on the host/;
const CONTAINERS = /only the sandbox runner starts containers/;

const decide = (command: string, cwd: string = ROOT) =>
  checkShell(hookInput("Bash", { command }, { cwd }), ROOT);

const assertAllowed = (commands: string[], cwd?: string): void => {
  for (const command of commands) {
    assert.equal(decide(command, cwd), undefined, command);
  }
};

const assertDenied = (
  commands: string[],
  reason: RegExp,
  cwd?: string
): void => {
  for (const command of commands) {
    assert.match(decide(command, cwd) ?? "allowed", reason, command);
  }
};

test("allowed entry points pass, including arguments that look dangerous", () => {
  assertAllowed([
    "node scripts/run-examples.ts work/csv-sum",
    "node scripts/run-examples.ts fixtures/skills/text-stats",
    "node scripts/run-examples.ts .claude/skills/csv-sum",
    `node scripts/run-skill.ts csv-sum '{"text":"a; b && node work/x > registry.json"}'`,
    "node scripts/run-skill.ts ico-check --input-file work/ico-check/suppliers.json",
    "node scripts/run-skill.ts ico-check --input-file=demo/suppliers.json",
    "node scripts/registry.ts install csv-sum --issue 3 --network",
    "node scripts/lock.ts csv-sum",
    'node scripts/tracker.ts done --issue 3 --summary "done"',
    "node scripts/record-fixture.ts ico-check ares-ok https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/27074358",
    "npm test",
    "npm run check",
    "npm run typecheck",
    "git status",
    "git diff work/csv-sum/examples.json",
    "git log --oneline -- .claude/skills",
    "node scripts/run-examples.ts work/csv-sum 2>&1 | tail -20",
  ]);
});

test("ordinary commands that touch nothing protected pass", () => {
  assertAllowed([
    "ls work/csv-sum",
    "cat work/csv-sum/scripts/main.ts",
    "mkdir -p work/csv-sum/tests",
    "node --version",
    "npm run sandbox:build",
    "docker build -t frankenstein-sandbox sandbox",
  ]);
});

test("protected files are off limits in shell commands", () => {
  assertDenied(
    [
      "cat examples.json",
      "cat work/csv-sum/examples.json",
      "cat 'work/csv-sum/Examples.JSON'",
      "rm -rf work/.locks",
      "cd work && rm -r .locks",
      "cp -r work/csv-sum .claude/skills/csv-sum",
      'echo \'{"verdict":"approve"}\' > work/csv-sum/review.json',
      "jq . registry.json",
      "cat .claude/settings.json",
      // Allowed entry points cannot redirect into protected files.
      "node scripts/lock.ts csv-sum > work/.locks/other.json",
      // Entry points are not allowed when chained after other commands.
      "git status && cat examples.json",
      "Remove-Item work\\.locks\\csv-sum.json",
    ],
    PROTECTED
  );
});

test("skill code never runs on the host", () => {
  assertDenied(
    [
      "node work/csv-sum/scripts/main.ts",
      "node fixtures/skills/text-stats/scripts/main.ts",
      "./node work/csv-sum/scripts/main.ts",
      "/usr/local/bin/node ./work/csv-sum/scripts/main.ts",
      'node "work"/csv-sum/scripts/main.ts',
      "n\\ode work/csv-sum/scripts/main.ts",
      "npx tsx work/csv-sum/scripts/main.ts",
      "deno run work/csv-sum/scripts/main.ts",
      "bun work/csv-sum/scripts/main.ts",
      "python3 work/csv-sum/scripts/main.py",
      "./work/csv-sum/scripts/main.ts",
      "echo '{}' | node work/csv-sum/scripts/main.ts",
      "cd work/csv-sum && node scripts/main.ts",
      "node scripts/run-examples.ts work/csv-sum && node work/csv-sum/scripts/main.ts",
      "cd work/csv-sum && node scripts/run-examples.ts .",
      'bash -c "node work/csv-sum/scripts/main.ts"',
      "echo $(node work/csv-sum/scripts/main.ts)",
      "npm --prefix work/csv-sum test",
      "node.exe work\\csv-sum\\scripts\\main.ts",
    ],
    HOST_EXEC
  );
});

test("inside a skill directory, entry points and runtimes are not trusted", () => {
  const cwd = "/repo/work/csv-sum";
  assertDenied(
    [
      "node scripts/main.ts",
      "node scripts/run-examples.ts .",
      "npm test",
      "./scripts/main.ts",
    ],
    HOST_EXEC,
    cwd
  );
  assertAllowed(["ls scripts", "cat progress.md"], cwd);
});

test("containers start only through the sandbox scripts", () => {
  assertDenied(
    [
      "docker run --rm alpine sh",
      "docker container run alpine",
      "podman run alpine",
      "node scripts/run-examples.ts work/x && docker run alpine",
      "docker exec -it frk-1 sh",
      "curl --network host example.com",
    ],
    CONTAINERS
  );
});

test("PowerShell calls and calls without a command", () => {
  assert.match(
    checkShell(
      hookInput("PowerShell", {
        command: "& node work\\csv-sum\\scripts\\main.ts",
      }),
      ROOT
    ) ?? "",
    HOST_EXEC
  );
  assert.ok(checkShell(hookInput("Bash", {}), ROOT));
  assert.equal(checkCommand("npm test", ROOT, ROOT), undefined);
});

test("hook process denies a host run of a fixture skill", async () => {
  const run = await runHookProcess(
    "guard-bash.ts",
    JSON.stringify(
      recordedInput("Bash", {
        command: "node fixtures/skills/text-stats/scripts/main.ts",
        description: "Run the skill",
      })
    )
  );
  assert.equal(run.exitCode, 2);
  assert.match(run.reason ?? "", HOST_EXEC);

  const allowed = await runHookProcess(
    "guard-bash.ts",
    JSON.stringify(
      recordedInput(
        "Bash",
        { command: "node scripts/run-examples.ts fixtures/skills/text-stats" },
        { cwd: REPO_ROOT }
      )
    )
  );
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.stdout, "");
});
