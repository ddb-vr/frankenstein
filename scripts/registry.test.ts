import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { writeIssueRecord } from "./lib/issue.ts";
import { type RegistryDeps, readRegistry } from "./lib/registry.ts";
import { lockSkill, readLock } from "./lock.ts";
import { install } from "./registry.ts";
import type { Summary } from "./run-examples.ts";

const SKILL = "text-stats";
const FIXTURE = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "skills",
  SKILL
);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PASS: Summary = {
  examples: { passed: 3, total: 3 },
  log: "logs/text-stats/x.log",
  status: "PASS",
  unit: "pass",
};
const NOT_LOCKED = /work\/\.locks\/text-stats\.json not found/;
const CHANGED = /examples\.json changed since it was locked/;
const NO_REVIEW = /review\.json not found/;
const REJECTED = /verdict is "reject", not "approve"/;
const INVALID_REVIEW = /review\.json is not valid JSON/;
const STALE_REVIEW =
  /captured for examplesHash "0+", but the lock has "[0-9a-f]{64}"/;
const UNHASHED_REVIEW = /captured for examplesHash null/;
const TESTS_FAILED = /run-examples failed at examples: expected 2, got 3/;
const INVALID_NAME = /invalid skill name/;
const PUSH_FAILED = /push rejected \(rolled back, nothing installed\)$/;
const COMMIT_FAILED = /commit rejected \(rolled back, nothing installed\)$/;
const ROLLBACK_FAILED =
  /push rejected; rollback failed, .*: git reset failed: reset rejected$/;
const NO_CREDENTIALS = /Missing required env var GITHUB_APP_INSTALLATION_ID/;
const ALREADY_LOCKED = /already locked/;
const NO_ISSUE = /no build issue: pass --issue <n>/;

let root = "";
let workDir = "";
let installedDir = "";
let botCalls: string[][] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "registry-test-"));
  workDir = path.join(root, "work", SKILL);
  installedDir = path.join(root, ".claude", "skills", SKILL);
  cpSync(FIXTURE, workDir, { recursive: true });
  writeFileSync(path.join(workDir, "progress.md"), "iteration 2\n");
  writeFileSync(path.join(root, "registry.json"), '{ "skills": [] }\n');
  botCalls = [];
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/** A review as capture-review writes it, tied to the current lock by default. */
const approve = (
  verdict = "approve",
  examplesHash = readLock(root, SKILL)?.sha256
): void => {
  writeFileSync(
    path.join(workDir, "review.json"),
    JSON.stringify({
      capturedAt: "2026-10-08T11:00:00.000Z",
      examplesHash,
      reasons: [],
      skill: SKILL,
      verdict,
    })
  );
};

const deps = (overrides: Partial<RegistryDeps> = {}): RegistryDeps => ({
  bot: (_cmd, args) => {
    botCalls.push([...args]);
    return Promise.resolve("");
  },
  costUsd: () => 0.9,
  credentials: () => Promise.resolve(),
  git: (args) =>
    Promise.resolve(
      args.includes("tag")
        ? "skill/text-stats@v1\nskill/text-stats@v2\nskill/text-stats-old@v9\n"
        : `${COMMIT}\n`
    ),
  now: () => new Date("2026-10-08T12:00:00Z"),
  root,
  runExamples: () => Promise.resolve(PASS),
  ...overrides,
});

const installFails = async (
  reason: RegExp,
  overrides: Partial<RegistryDeps> = {},
  skill = SKILL
): Promise<void> => {
  const result = await install(
    skill,
    { issue: 7, network: false },
    deps(overrides)
  );
  assert.equal(result.installed, false);
  assert.match("reason" in result ? result.reason : "", reason);
  assert.deepEqual(botCalls, []);
  assert.ok(!existsSync(path.join(root, ".claude", "skills", SKILL)));
  assert.deepEqual(readRegistry(root).skills, []);
};

test("refuses without a lock", async () => {
  approve();
  await installFails(NOT_LOCKED);
});

test("refuses when examples.json changed after locking", async () => {
  lockSkill(root, SKILL);
  appendFileSync(path.join(workDir, "examples.json"), " ");
  approve();
  await installFails(CHANGED);
});

test("refuses without an approve verdict", async () => {
  lockSkill(root, SKILL);
  await installFails(NO_REVIEW);
  approve("reject");
  await installFails(REJECTED);
  writeFileSync(path.join(workDir, "review.json"), "approve");
  await installFails(INVALID_REVIEW);
});

test("refuses an approve captured for other examples than the lock", async () => {
  lockSkill(root, SKILL);
  approve("approve", "0".repeat(64));
  await installFails(STALE_REVIEW);
  // A bare approve (no examplesHash) is not tied to any lock.
  writeFileSync(
    path.join(workDir, "review.json"),
    JSON.stringify({ verdict: "approve" })
  );
  await installFails(UNHASHED_REVIEW);
});

test("refuses when the fresh test run fails", async () => {
  lockSkill(root, SKILL);
  approve();
  await installFails(TESTS_FAILED, {
    runExamples: () =>
      Promise.resolve({
        example: "two words",
        log: "logs/text-stats/x.log",
        reason: "expected 2, got 3",
        stage: "examples",
        status: "FAIL",
      }),
  });
});

test("refuses skill names that are not plain directory names", async () => {
  await installFails(INVALID_NAME, {}, "../text-stats");
});

test("refuses before changing anything when the bot credentials are missing", async () => {
  lockSkill(root, SKILL);
  approve();
  let tested = false;
  await installFails(NO_CREDENTIALS, {
    credentials: () =>
      Promise.reject(
        new Error("Missing required env var GITHUB_APP_INSTALLATION_ID")
      ),
    runExamples: () => {
      tested = true;
      return Promise.resolve(PASS);
    },
  });
  assert.equal(tested, false);
});

test("installs: copies the skill, bumps the version, commits, tags and pushes as the bot", async () => {
  const lock = lockSkill(root, SKILL);
  approve();
  let testedDir = "";
  const result = await install(
    SKILL,
    { issue: 7, network: true },
    deps({
      runExamples: (dir) => {
        testedDir = dir;
        return Promise.resolve(PASS);
      },
    })
  );
  assert.deepEqual(result, { commit: COMMIT, installed: SKILL, version: "v3" });
  assert.equal(testedDir, workDir);

  const installed = path.join(root, ".claude", "skills", SKILL);
  assert.deepEqual(readdirSync(installed).sort(), [
    "SKILL.md",
    "examples.json",
    "scripts",
    "tests",
  ]);
  assert.equal(
    readFileSync(path.join(installed, "scripts", "main.ts"), "utf8"),
    readFileSync(path.join(FIXTURE, "scripts", "main.ts"), "utf8")
  );
  assert.deepEqual(readRegistry(root).skills, [
    {
      enabled: true,
      examplesHash: lock.sha256,
      history: [
        {
          action: "install",
          at: "2026-10-08T12:00:00.000Z",
          commit: COMMIT,
          costUsd: 0.9,
          issue: 7,
          version: "v3",
        },
      ],
      installedAt: "2026-10-08T12:00:00.000Z",
      issue: 7,
      name: SKILL,
      network: true,
      version: "v3",
    },
  ]);

  const commands = botCalls.map((args) => args.slice(2));
  const paths = ["--", `.claude/skills/${SKILL}`, "registry.json"];
  assert.deepEqual(commands[0], ["add", ...paths]);
  assert.deepEqual(commands[1]?.slice(0, 5), [
    "commit",
    "-m",
    "feat(skills): install text-stats v3",
    "-m",
    "Refs #7",
  ]);
  assert.deepEqual(commands[2], [
    "tag",
    "-a",
    "skill/text-stats@v3",
    "-m",
    "text-stats v3",
  ]);
  assert.deepEqual(commands[3]?.slice(-5), [
    "push",
    "--atomic",
    "origin",
    "HEAD",
    "refs/tags/skill/text-stats@v3",
  ]);
  assert.ok(botCalls.every((args) => args[0] === "-C" && args[1] === root));
});

const INSTALL_PATHS = ["--", `.claude/skills/${SKILL}`, "registry.json"];
const PREVIOUS_HEAD = "fedcba9876543210fedcba9876543210fedcba98";

/** v1 installed; registry.json as written by an earlier install. */
const installPrevious = (): string => {
  mkdirSync(path.join(installedDir, "scripts"), { recursive: true });
  writeFileSync(path.join(installedDir, "SKILL.md"), "v1\n");
  writeFileSync(path.join(installedDir, "scripts", "main.ts"), "// v1\n");
  const registry = `${JSON.stringify(
    {
      skills: [
        {
          enabled: true,
          examplesHash: "1".repeat(64),
          installedAt: "2026-10-01T12:00:00.000Z",
          issue: 3,
          name: SKILL,
          network: false,
          version: "v1",
        },
      ],
    },
    null,
    2
  )}\n`;
  writeFileSync(path.join(root, "registry.json"), registry);
  return registry;
};

/** HEAD is `PREVIOUS_HEAD` until the install commit, `COMMIT` after it. */
const movingHeadGit = (): RegistryDeps["git"] => {
  let revParses = 0;
  return (args) => {
    if (args.includes("tag")) {
      return Promise.resolve("skill/text-stats@v1\n");
    }
    revParses += 1;
    return Promise.resolve(`${revParses === 1 ? PREVIOUS_HEAD : COMMIT}\n`);
  };
};

const failingBot =
  (...failing: string[]): RegistryDeps["bot"] =>
  (_cmd, args) => {
    botCalls.push([...args]);
    const step = failing.find((name) => args.includes(name));
    return step === undefined
      ? Promise.resolve("")
      : Promise.reject(new Error(`git ${step} failed: ${step} rejected`));
  };

test("a failed push restores the previous install, registry.json, HEAD, tag and index", async () => {
  lockSkill(root, SKILL);
  approve();
  const registry = installPrevious();
  const result = await install(
    SKILL,
    { issue: 7, network: false },
    deps({ bot: failingBot("push"), git: movingHeadGit() })
  );
  assert.equal(result.installed, false);
  assert.match("reason" in result ? result.reason : "", PUSH_FAILED);

  assert.deepEqual(readdirSync(installedDir).sort(), ["SKILL.md", "scripts"]);
  assert.equal(
    readFileSync(path.join(installedDir, "SKILL.md"), "utf8"),
    "v1\n"
  );
  assert.equal(
    readFileSync(path.join(installedDir, "scripts", "main.ts"), "utf8"),
    "// v1\n"
  );
  assert.equal(
    readFileSync(path.join(root, "registry.json"), "utf8"),
    registry
  );

  const commands = botCalls.map((args) => args.slice(2));
  assert.equal(commands[2]?.[2], "skill/text-stats@v2");
  assert.deepEqual(commands.slice(4), [
    ["tag", "-d", "skill/text-stats@v2"],
    ["reset", "--soft", PREVIOUS_HEAD],
    ["reset", "--quiet", PREVIOUS_HEAD, ...INSTALL_PATHS],
  ]);
});

test("a failed first install leaves no skill directory and the old registry.json", async () => {
  lockSkill(root, SKILL);
  approve();
  const result = await install(
    SKILL,
    { issue: 7, network: false },
    deps({ bot: failingBot("commit") })
  );
  assert.equal(result.installed, false);
  assert.match("reason" in result ? result.reason : "", COMMIT_FAILED);
  assert.ok(!existsSync(installedDir));
  assert.equal(
    readFileSync(path.join(root, "registry.json"), "utf8"),
    '{ "skills": [] }\n'
  );
  // HEAD never moved and no tag exists: only the staged paths are reset.
  assert.deepEqual(
    botCalls.slice(2).map((args) => args.slice(2)),
    [["reset", "--quiet", COMMIT, ...INSTALL_PATHS]]
  );
});

test("a failed rollback is reported, with the files still restored", async () => {
  lockSkill(root, SKILL);
  approve();
  const registry = installPrevious();
  const result = await install(
    SKILL,
    { issue: 7, network: false },
    deps({ bot: failingBot("push", "reset"), git: movingHeadGit() })
  );
  assert.equal(result.installed, false);
  assert.match("reason" in result ? result.reason : "", ROLLBACK_FAILED);
  assert.equal(
    readFileSync(path.join(installedDir, "SKILL.md"), "utf8"),
    "v1\n"
  );
  assert.equal(
    readFileSync(path.join(root, "registry.json"), "utf8"),
    registry
  );
});

test("without --issue, the issue comes from work/<skill>/issue.json", async () => {
  lockSkill(root, SKILL);
  approve();
  const noIssue = await install(SKILL, { network: false }, deps());
  assert.match("reason" in noIssue ? noIssue.reason : "", NO_ISSUE);
  assert.deepEqual(botCalls, []);

  writeIssueRecord(root, SKILL, {
    issue: 12,
    url: "https://github.com/acme/frankenstein/issues/12",
  });
  const result = await install(SKILL, { network: false }, deps());
  assert.equal(result.installed, SKILL);
  assert.equal(readRegistry(root).skills[0]?.issue, 12);
  assert.equal(botCalls[1]?.[6], "Refs #12");
  assert.ok(
    !existsSync(path.join(root, ".claude", "skills", SKILL, "issue.json"))
  );
});

test("a lock is written once and never replaced", () => {
  lockSkill(root, SKILL);
  assert.throws(() => lockSkill(root, SKILL), ALREADY_LOCKED);
  mkdirSync(path.join(root, "work", "other"), { recursive: true });
  cpSync(
    path.join(workDir, "examples.json"),
    path.join(root, "work", "other", "examples.json")
  );
  // examples.json declares "text-stats", so it cannot lock "other".
  assert.throws(() => lockSkill(root, "other"));
});
