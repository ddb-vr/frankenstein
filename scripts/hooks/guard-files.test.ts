import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkFileWrite, type FileGuardContext } from "./guard-files.ts";
import { REPO_ROOT, resolveSymlinks } from "./lib.ts";
import { hookInput, recordedInput, runHookProcess } from "./testing.ts";

const ROOT = "/repo";
const WINDOWS_ROOT = "C:\\Users\\dev\\frankenstein";
const LOCKED = /examples\.json is locked/;
const REVIEW_BY_HOOK = /written only by the capture-review hook/;
const SKILLS_PROTECTED = /\.claude\/skills is protected/;
const DISABLED_PROTECTED =
  /\.claude\/disabled-skills is protected; skills are disabled and enabled only by the user/;
const HOOK_FAILED = /hook guard-files\.ts failed/;
const THROUGH_SYMLINK = /resolves to .* through a symlink/;

/** Without symlinks: paths resolve to themselves. */
const context = (
  existing: string[] = [],
  root: string = ROOT
): FileGuardContext => ({
  exists: (relativePath) => existing.includes(relativePath),
  realPath: (filePath) => filePath,
  root,
});

const write = (filePath: string, cwd: string = ROOT) =>
  hookInput("Write", { content: "{}", file_path: filePath }, { cwd });

test("examples.json is writable until the skill is locked", () => {
  const input = hookInput(
    "Edit",
    {
      file_path: "/repo/work/csv-sum/examples.json",
      new_string: "b",
      old_string: "a",
    },
    { cwd: ROOT }
  );
  assert.equal(checkFileWrite(input, context()), undefined);
  assert.match(
    checkFileWrite(input, context(["work/.locks/csv-sum.json"])) ?? "",
    LOCKED
  );
  // Another skill's lock does not lock this one.
  assert.equal(
    checkFileWrite(input, context(["work/.locks/other.json"])),
    undefined
  );
});

test("disabled skills are the operator's: agent writes are denied", () => {
  for (const file of [
    "/repo/.claude/disabled-skills/csv-sum/SKILL.md",
    "/repo/.claude/disabled-skills/new-skill/scripts/main.ts",
    "work/csv-sum/../../.claude/Disabled-Skills/x/SKILL.md",
  ]) {
    assert.match(
      checkFileWrite(write(file), context()) ?? "allowed",
      DISABLED_PROTECTED,
      file
    );
  }
});

test("lock files, installed skills, settings, scripts and registry are protected", () => {
  for (const file of [
    "/repo/work/.locks/csv-sum.json",
    "/repo/.claude/skills/csv-sum/SKILL.md",
    "/repo/.claude/skills",
    "/repo/.claude/settings.json",
    "/repo/.claude/settings.local.json",
    "/repo/scripts/hooks/budget.ts",
    "/repo/registry.json",
    "/repo/work/.run/6f1c2a7e-0b8d-4d6b-9a51-2f4e8c1d3b90.json",
    "/repo/work/.run/current.json",
    // Relative traversal and case variants resolve to the same files.
    "work/csv-sum/../../.claude/skills/x/SKILL.md",
    "/repo/.Claude/Skills/x/SKILL.md",
  ]) {
    assert.ok(checkFileWrite(write(file), context()), file);
  }
  for (const file of [
    "/repo/work/csv-sum/scripts/main.ts",
    "/repo/work/csv-sum/progress.md",
    "/repo/.claude/agents/prd.md",
    "/repo/README.md",
    "/tmp/scripts/x.ts",
  ]) {
    assert.equal(checkFileWrite(write(file), context()), undefined, file);
  }
});

test("review.json is never written by file tools", () => {
  const input = write("/repo/work/csv-sum/review.json");
  assert.match(checkFileWrite(input, context()) ?? "", REVIEW_BY_HOOK);
  assert.match(
    checkFileWrite(
      write("C:\\repo\\Work\\csv-sum\\Review.json", "C:\\repo"),
      context([], "C:\\repo")
    ) ?? "",
    REVIEW_BY_HOOK
  );
});

test("Windows-style paths are normalized before matching", () => {
  const windows = (file: string, existing: string[] = []) =>
    checkFileWrite(write(file, WINDOWS_ROOT), context(existing, WINDOWS_ROOT));
  assert.ok(
    windows("C:\\Users\\dev\\frankenstein\\.claude\\skills\\x\\SKILL.md")
  );
  assert.ok(windows("c:\\users\\dev\\Frankenstein\\registry.json"));
  assert.ok(
    windows("C:\\Users\\dev\\frankenstein\\work\\csv-sum\\examples.json", [
      "work/.locks/csv-sum.json",
    ])
  );
  assert.equal(
    windows("C:\\Users\\dev\\frankenstein\\work\\csv-sum\\scripts\\main.ts"),
    undefined
  );
});

test("NotebookEdit paths and calls without a path", () => {
  assert.ok(
    checkFileWrite(
      hookInput("NotebookEdit", { notebook_path: "/repo/scripts/a.ipynb" }),
      context()
    )
  );
  assert.ok(checkFileWrite(hookInput("Write", { content: "x" }), context()));
});

test("symlinks cannot redirect a write into a protected path", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "guard-files-test-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const skill = path.join(root, "work", "csv-sum");
  mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
  mkdirSync(skill, { recursive: true });
  symlinkSync(".", path.join(skill, "self"));
  symlinkSync("../..", path.join(skill, "up"));
  // Dangling: a write through it would create the registry.
  symlinkSync("../../registry.json", path.join(skill, "reg"));
  const real: FileGuardContext = {
    exists: () => false,
    realPath: (filePath, cwd) => resolveSymlinks(path.resolve(cwd, filePath)),
    root,
  };
  const check = (file: string) =>
    checkFileWrite(write(path.join(skill, file), root), real);
  assert.match(check("self/review.json") ?? "", REVIEW_BY_HOOK);
  assert.match(check("self/review.json") ?? "", THROUGH_SYMLINK);
  assert.match(check("up/.claude/skills/x/SKILL.md") ?? "", SKILLS_PROTECTED);
  assert.ok(check("up/scripts/new-dir/x.ts"));
  assert.ok(check("reg"));
  assert.equal(check("self/scripts/main.ts"), undefined);
  assert.equal(check("notes.md"), undefined);
});

test("hook process denies via JSON + exit 2, allows silently, fails closed", async () => {
  const denied = await runHookProcess(
    "guard-files.ts",
    JSON.stringify(
      recordedInput("Write", {
        content: "---\n",
        file_path: `${REPO_ROOT}/.claude/skills/x/SKILL.md`,
      })
    )
  );
  assert.equal(denied.exitCode, 2);
  assert.match(denied.reason ?? "", SKILLS_PROTECTED);
  assert.match(denied.stderr, SKILLS_PROTECTED);

  const allowed = await runHookProcess(
    "guard-files.ts",
    JSON.stringify(
      recordedInput("Write", {
        content: "x",
        file_path: `${REPO_ROOT}/work/x/notes.md`,
      })
    )
  );
  assert.deepEqual(
    { exitCode: allowed.exitCode, stdout: allowed.stdout },
    { exitCode: 0, stdout: "" }
  );

  const broken = await runHookProcess("guard-files.ts", "not json");
  assert.equal(broken.exitCode, 2);
  assert.match(broken.reason ?? "", HOOK_FAILED);
});
