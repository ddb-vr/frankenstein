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
import { lockSkill } from "./lock.ts";
import { type InstallDeps, install, readRegistry } from "./registry.ts";
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
const TESTS_FAILED = /run-examples failed at examples: expected 2, got 3/;
const INVALID_NAME = /invalid skill name/;
const PUSH_FAILED = /push rejected/;
const ALREADY_LOCKED = /already locked/;
const NO_ISSUE = /no build issue: pass --issue <n>/;

let root = "";
let workDir = "";
let botCalls: string[][] = [];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "registry-test-"));
  workDir = path.join(root, "work", SKILL);
  cpSync(FIXTURE, workDir, { recursive: true });
  writeFileSync(path.join(workDir, "progress.md"), "iteration 2\n");
  writeFileSync(path.join(root, "registry.json"), '{ "skills": [] }\n');
  botCalls = [];
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const approve = (verdict = "approve"): void => {
  writeFileSync(path.join(workDir, "review.json"), JSON.stringify({ verdict }));
};

const deps = (overrides: Partial<InstallDeps> = {}): InstallDeps => ({
  bot: (_cmd, args) => {
    botCalls.push([...args]);
    return Promise.resolve("");
  },
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
  overrides: Partial<InstallDeps> = {},
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

test("reports git failures as a failed install", async () => {
  lockSkill(root, SKILL);
  approve();
  const result = await install(
    SKILL,
    { issue: 7, network: false },
    deps({
      bot: (_cmd, args) =>
        args.includes("push")
          ? Promise.reject(new Error("git push failed: push rejected"))
          : Promise.resolve(""),
    })
  );
  assert.equal(result.installed, false);
  assert.match("reason" in result ? result.reason : "", PUSH_FAILED);
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
