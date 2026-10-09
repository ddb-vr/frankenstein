import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
import { promisify } from "node:util";
import { resetDemo } from "../demo-reset.ts";
import { LOCAL_BOT, runAsLocalBot } from "../github-app-token.ts";
import { lockSkill, readLock } from "../lock.ts";
import { install } from "../registry.ts";
import type { Summary } from "../run-examples.ts";
import { enabledEntry } from "../run-skill.ts";
import {
  disableSkill,
  enableSkill,
  formatList,
  formatShow,
  listSkills,
  removeSkill,
  rollbackSkill,
  showSkill,
} from "./operator.ts";
import { type RegistryDeps, readRegistry } from "./registry.ts";

const SKILL = "text-stats";
const FIXTURE = path.join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "skills",
  SKILL
);
const BOT = "frankenstein[bot]";
const PASS: Summary = {
  examples: { passed: 3, total: 3 },
  log: "logs/text-stats/x.log",
  status: "PASS",
  unit: "pass",
};
const FAIL: Summary = {
  example: "two words",
  log: "logs/text-stats/x.log",
  reason: "expected 2, got 3",
  stage: "examples",
  status: "FAIL",
};
const DISABLED = /skill "text-stats" is disabled/;
const ROLLBACK_FAILED =
  /run-examples failed on skill\/text-stats@v1 at examples: expected 2, got 3 \(rolled back, nothing changed\)/;
const NOT_INSTALLED = /skill "text-stats" is not installed/;
const LIST_ROW = /text-stats\s+v2\s+yes\s+no\s+.*#5\s+\$1\.30$/m;
const SHOW_HEADER = /^text-stats v2 \(enabled, no network, issue #5/;
const SHOW_TAG_ROW =
  /skill\/text-stats@v1\s+[0-9a-f]{7}\s+\S+\s+frankenstein\[bot\]/;
const V1_MARKER = /v1 marker/;
const V2_MARKER = /v2 marker/;
const MALFORMED = /registry\.json is malformed/;

const execFileAsync = promisify(execFile);

let base = "";
let root = "";
let origin = "";
let summary: Summary = PASS;
let tested: string[] = [];

const git = async (args: readonly string[], cwd = root): Promise<string> =>
  (await execFileAsync("git", args, { cwd, encoding: "utf8" })).stdout;

/** Real git; the bot identity is a fixed author instead of the GitHub App. */
const deps: RegistryDeps = {
  bot: async (cmd, args) =>
    (
      await execFileAsync(cmd, args, {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_EMAIL: "bot@example.com",
          GIT_AUTHOR_NAME: BOT,
          GIT_COMMITTER_EMAIL: "bot@example.com",
          GIT_COMMITTER_NAME: BOT,
        },
      })
    ).stdout,
  costUsd: () => null,
  credentials: () => Promise.resolve(),
  git: (args) => git(args),
  now: () => new Date("2026-10-09T12:00:00Z"),
  remote: true,
  get root() {
    return root;
  },
  runExamples: (dir) => {
    tested.push(dir);
    return Promise.resolve(summary);
  },
};

const skillFile = (dir: string, file = "SKILL.md"): string =>
  readFileSync(path.join(root, dir, SKILL, file), "utf8");

/** Installs the work copy through the real install, with an approve review. */
const installVersion = async (
  issue: number,
  costUsd: number,
  marker: string
): Promise<void> => {
  const work = path.join(root, "work", SKILL);
  appendFileSync(path.join(work, "SKILL.md"), `\n${marker}\n`);
  writeFileSync(
    path.join(work, "review.json"),
    JSON.stringify({
      examplesHash: readLock(root, SKILL)?.sha256,
      verdict: "approve",
    })
  );
  const result = await install(
    SKILL,
    { issue, network: false },
    { ...deps, costUsd: () => costUsd, root }
  );
  assert.equal(result.installed, SKILL, JSON.stringify(result));
};

const remoteTags = async (): Promise<string[]> =>
  (await git(["ls-remote", "--tags", "origin"]))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.split("\t")[1] ?? "");

const assertPushed = async (): Promise<void> => {
  assert.equal(
    (await git(["rev-parse", "HEAD"])).trim(),
    (await git(["rev-parse", "HEAD"], origin)).trim()
  );
};

const headCommit = async (): Promise<{ author: string; subject: string }> => {
  const [author = "", subject = ""] = (
    await git(["log", "-1", "--format=%an%n%s"])
  ).split("\n");
  return { author, subject };
};

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), "operator-test-"));
  root = path.join(base, "repo");
  origin = path.join(base, "origin.git");
  summary = PASS;
  tested = [];
  await git(
    ["init", "--bare", "--quiet", "--initial-branch=main", origin],
    base
  );
  mkdirSync(root);
  await git(["init", "--quiet", "--initial-branch=main"]);
  await git(["config", "user.name", "Operator"]);
  await git(["config", "user.email", "operator@example.com"]);
  await git(["config", "commit.gpgsign", "false"]);
  await git(["config", "tag.gpgsign", "false"]);
  await git(["remote", "add", "origin", origin]);
  writeFileSync(path.join(root, "registry.json"), '{ "skills": [] }\n');
  for (const dir of ["work", "logs"]) {
    mkdirSync(path.join(root, dir));
    writeFileSync(path.join(root, dir, ".gitkeep"), "");
  }
  writeFileSync(
    path.join(root, ".gitignore"),
    "work/*\n!work/.gitkeep\nlogs/*\n!logs/.gitkeep\n"
  );
  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "init"]);
  await git(["push", "--quiet", "origin", "HEAD"]);
  cpSync(FIXTURE, path.join(root, "work", SKILL), { recursive: true });
  lockSkill(root, SKILL);
  await installVersion(3, 0.9, "v1 marker");
  await installVersion(5, 0.4, "v2 marker");
});

afterEach(() => {
  rmSync(base, { force: true, recursive: true });
});

test("list and show report versions, history, cost and the bot-authored tags", async () => {
  const [skill] = listSkills(root);
  assert.deepEqual(skill, {
    enabled: true,
    installedAt: "2026-10-09T12:00:00.000Z",
    issue: 5,
    name: SKILL,
    network: false,
    totalCostUsd: 1.3,
    version: "v2",
  });
  assert.match(formatList(listSkills(root)), LIST_ROW);

  const details = await showSkill(deps, SKILL);
  assert.deepEqual(
    details.entry?.history.map(({ action, costUsd, issue, version }) => ({
      action,
      costUsd,
      issue,
      version,
    })),
    [
      { action: "install", costUsd: 0.9, issue: 3, version: "v1" },
      { action: "install", costUsd: 0.4, issue: 5, version: "v2" },
    ]
  );
  assert.deepEqual(
    details.tags.map(({ author, tag }) => ({ author, tag })),
    [
      { author: BOT, tag: "skill/text-stats@v1" },
      { author: BOT, tag: "skill/text-stats@v2" },
    ]
  );
  const tagCommits = await Promise.all(
    details.tags.map(async ({ tag }) =>
      (await git(["rev-parse", `${tag}^{commit}`])).trim()
    )
  );
  assert.deepEqual(
    details.tags.map(({ commit }) => commit),
    tagCommits
  );
  assert.ok(details.tags.every(({ date }) => !Number.isNaN(Date.parse(date))));
  const text = formatShow(details);
  assert.match(text, SHOW_HEADER);
  assert.match(text, SHOW_TAG_ROW);
});

test("disable hides the skill and run-skill refuses it; enable restores it", async () => {
  const before = skillFile(".claude/skills");
  const disabled = await disableSkill(SKILL, deps);
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  assert.ok(!existsSync(path.join(root, ".claude", "skills", SKILL)));
  assert.equal(skillFile(".claude/disabled-skills"), before);
  assert.throws(() => enabledEntry(root, SKILL), DISABLED);
  assert.deepEqual(await headCommit(), {
    author: BOT,
    subject: "chore(registry): disable text-stats",
  });
  await assertPushed();
  assert.deepEqual(
    (await git(["ls-files", ".claude"]))
      .trim()
      .split("\n")
      .map((file) => file.split("/")[1]),
    ["disabled-skills", "disabled-skills", "disabled-skills", "disabled-skills"]
  );

  const again = await disableSkill(SKILL, deps);
  assert.equal(again.ok, false);

  const enabled = await enableSkill(SKILL, deps);
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.equal(skillFile(".claude/skills"), before);
  assert.ok(!existsSync(path.join(root, ".claude", "disabled-skills", SKILL)));
  assert.equal(enabledEntry(root, SKILL).version, "v2");
  assert.deepEqual(
    readRegistry(root).skills[0]?.history.map((item) => item.action),
    ["install", "install", "disable", "enable"]
  );
  await assertPushed();
});

test("rollback restores the previous version's files after a passing test run", async () => {
  const head = (await git(["rev-parse", "HEAD"])).trim();
  tested = [];
  const result = await rollbackSkill(SKILL, {}, deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ok && result.version, "v1");

  const restored = skillFile(".claude/skills");
  assert.match(restored, V1_MARKER);
  assert.doesNotMatch(restored, V2_MARKER);
  assert.deepEqual(tested, [path.join(root, ".claude", "skills", SKILL)]);
  const [entry] = readRegistry(root).skills;
  assert.equal(entry?.version, "v1");
  assert.equal(entry?.issue, 3);
  assert.deepEqual(entry?.history.at(-1), {
    action: "rollback",
    at: "2026-10-09T12:00:00.000Z",
    commit: head,
    costUsd: 0,
    issue: 3,
    version: "v1",
  });
  assert.deepEqual(await headCommit(), {
    author: BOT,
    subject: "chore(registry): rollback text-stats to v1",
  });
  assert.equal(
    (await git(["status", "--porcelain", ".claude", "registry.json"])).trim(),
    ""
  );
  await assertPushed();
  assert.deepEqual((await git(["tag", "--list"])).trim().split("\n"), [
    "skill/text-stats@v1",
    "skill/text-stats@v2",
  ]);

  // Already at v1, and nothing older is tagged.
  const none = await rollbackSkill(SKILL, {}, deps);
  assert.equal(none.ok, false);
  const forward = await rollbackSkill(SKILL, { to: "v2" }, deps);
  assert.equal(forward.ok, true, JSON.stringify(forward));
  assert.match(skillFile(".claude/skills"), V2_MARKER);
});

test("rollback aborts and restores everything when the tests fail", async () => {
  const head = (await git(["rev-parse", "HEAD"])).trim();
  const registry = readFileSync(path.join(root, "registry.json"), "utf8");
  summary = FAIL;
  const result = await rollbackSkill(SKILL, { to: "v1" }, deps);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, ROLLBACK_FAILED);
  assert.match(skillFile(".claude/skills"), V2_MARKER);
  assert.equal(
    readFileSync(path.join(root, "registry.json"), "utf8"),
    registry
  );
  assert.equal((await git(["rev-parse", "HEAD"])).trim(), head);
  assert.equal((await git(["status", "--porcelain"])).trim(), "");
});

test("remove keeps the tags unless --delete-tags", async () => {
  const kept = await removeSkill(SKILL, { deleteTags: false }, deps);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.ok(!existsSync(path.join(root, ".claude", "skills", SKILL)));
  assert.deepEqual(readRegistry(root).skills, []);
  assert.equal((await git(["ls-files", ".claude"])).trim(), "");
  assert.equal((await git(["tag", "--list"])).trim().split("\n").length, 2);
  assert.equal((await remoteTags()).length, 4); // tags and their peeled `^{}`
  await assertPushed();
  // Removed, the tags still show.
  assert.equal((await showSkill(deps, SKILL)).entry, null);
  const again = await removeSkill(SKILL, { deleteTags: true }, deps);
  assert.match(again.ok ? "" : again.reason, NOT_INSTALLED);
});

test("remove --delete-tags deletes the tags locally and on origin, also for a disabled skill", async () => {
  assert.equal((await disableSkill(SKILL, deps)).ok, true);
  const result = await removeSkill(SKILL, { deleteTags: true }, deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.ok && result.deletedTags, [
    "skill/text-stats@v1",
    "skill/text-stats@v2",
  ]);
  assert.ok(!existsSync(path.join(root, ".claude", "disabled-skills", SKILL)));
  assert.equal((await git(["tag", "--list"])).trim(), "");
  assert.deepEqual(await remoteTags(), []);
  await assertPushed();
  await assert.rejects(showSkill(deps, SKILL), NOT_INSTALLED);
});

test("demo reset removes every skill with its tags, orphan tags too, and clears work/ and logs/", async () => {
  writeFileSync(path.join(root, "logs", "run.log"), "x\n");
  // Left by a skill removed earlier without --delete-tags; one only on origin.
  await git(["tag", "skill/old-skill@v1"]);
  await git(["tag", "skill/gone@v2"]);
  await git([
    "push",
    "--quiet",
    "origin",
    "skill/old-skill@v1",
    "skill/gone@v2",
  ]);
  await git(["tag", "-d", "skill/gone@v2"]);
  await git(["tag", "unrelated"]);
  const result = await resetDemo(deps);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.orphanTags, ["skill/gone@v2", "skill/old-skill@v1"]);
  assert.deepEqual(result.cleared, ["work", "logs"]);
  assert.deepEqual(readRegistry(root).skills, []);
  assert.deepEqual(readdirSync(path.join(root, "work")), [".gitkeep"]);
  assert.deepEqual(readdirSync(path.join(root, "logs")), [".gitkeep"]);
  assert.deepEqual(await remoteTags(), []);
  assert.equal((await git(["tag", "--list"])).trim(), "unrelated");
});

test("without the GitHub App, install, rollback and remove commit and tag as frankenstein-bot and never push", async () => {
  // The operator's repo config demands signing; the local bot never signs.
  await git(["config", "commit.gpgsign", "true"]);
  await git(["config", "tag.gpgsign", "true"]);
  const originHead = (await git(["rev-parse", "HEAD"], origin)).trim();
  const originTags = await remoteTags();
  const local: RegistryDeps = { ...deps, bot: runAsLocalBot, remote: false };
  const bot = `${LOCAL_BOT.name} <${LOCAL_BOT.email}>`;

  appendFileSync(path.join(root, "work", SKILL, "SKILL.md"), "\nv3 marker\n");
  const installed = await install(SKILL, { issue: 9, network: false }, local);
  assert.equal(installed.installed, SKILL, JSON.stringify(installed));
  assert.equal(
    (
      await git([
        "for-each-ref",
        "--format=%(taggername) %(taggeremail)",
        "refs/tags/skill/text-stats@v3",
      ])
    ).trim(),
    bot
  );
  const rolledBack = await rollbackSkill(SKILL, { to: "v2" }, local);
  assert.equal(rolledBack.ok, true, JSON.stringify(rolledBack));
  const removed = await removeSkill(SKILL, { deleteTags: true }, local);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.deepEqual(removed.ok && removed.deletedTags, [
    "skill/text-stats@v1",
    "skill/text-stats@v2",
    "skill/text-stats@v3",
  ]);

  assert.deepEqual(
    (await git(["log", "-3", "--format=%an <%ae>|%cn <%ce>|%G?|%s"]))
      .trim()
      .split("\n"),
    [
      `${bot}|${bot}|N|chore(registry): remove text-stats`,
      `${bot}|${bot}|N|chore(registry): rollback text-stats to v2`,
      `${bot}|${bot}|N|feat(skills): install text-stats v3`,
    ]
  );
  assert.equal((await git(["rev-parse", "HEAD"], origin)).trim(), originHead);
  assert.deepEqual(await remoteTags(), originTags);
});

test("entries without history are migrated on read and saved migrated", async () => {
  const legacy = {
    enabled: true,
    examplesHash: "a".repeat(64),
    installedAt: "2026-10-01T12:00:00.000Z",
    issue: 3,
    name: SKILL,
    network: false,
    version: "v2",
  };
  writeFileSync(
    path.join(root, "registry.json"),
    JSON.stringify({ skills: [legacy] })
  );
  const migrated = {
    action: "install",
    at: legacy.installedAt,
    commit: null,
    costUsd: null,
    issue: 3,
    version: "v2",
  };
  assert.deepEqual(readRegistry(root).skills, [
    { ...legacy, history: [migrated] },
  ]);
  assert.equal(listSkills(root)[0]?.totalCostUsd, null);

  assert.equal((await disableSkill(SKILL, deps)).ok, true);
  const saved = JSON.parse(
    readFileSync(path.join(root, "registry.json"), "utf8")
  );
  assert.deepEqual(
    saved.skills[0].history.map((item: { action: string }) => item.action),
    ["install", "disable"]
  );
  assert.deepEqual(saved.skills[0].history[0], migrated);

  writeFileSync(
    path.join(root, "registry.json"),
    JSON.stringify({
      skills: [{ ...legacy, history: [{ action: "explode" }] }],
    })
  );
  assert.throws(() => readRegistry(root), MALFORMED);
});
