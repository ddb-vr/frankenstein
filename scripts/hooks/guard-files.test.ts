import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFileWrite, type FileGuardContext } from "./guard-files.ts";
import { REPO_ROOT } from "./lib.ts";
import { hookInput, recordedInput, runHookProcess } from "./testing.ts";

const ROOT = "/repo";
const WINDOWS_ROOT = "C:\\Users\\dev\\frankenstein";
const LOCKED = /examples\.json is locked/;
const REVIEW_BY_HOOK = /written only by the capture-review hook/;
const SKILLS_PROTECTED = /\.claude\/skills is protected/;
const HOOK_FAILED = /hook guard-files\.ts failed/;

const context = (
  existing: string[] = [],
  root: string = ROOT
): FileGuardContext => ({
  exists: (relativePath) => existing.includes(relativePath),
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

test("lock files, installed skills, settings, scripts and registry are protected", () => {
  for (const file of [
    "/repo/work/.locks/csv-sum.json",
    "/repo/.claude/skills/csv-sum/SKILL.md",
    "/repo/.claude/skills",
    "/repo/.claude/settings.json",
    "/repo/.claude/settings.local.json",
    "/repo/scripts/hooks/budget.ts",
    "/repo/registry.json",
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
