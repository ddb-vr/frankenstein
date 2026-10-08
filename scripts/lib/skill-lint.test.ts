import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import {
  BIOME_DIAGNOSTIC,
  diagnosticLines,
  fixSkill,
  formatLockedExamples,
  lintSkill,
  skillSourceFiles,
  TSC_DIAGNOSTIC,
} from "./skill-lint.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLEAN_TS = "export const greet = (name: string): string => name;\n";
const UNSORTED_JSON = '{"b":1,"a":[1,2]}';

const tempSkill = (t: TestContext): string => {
  const parent = mkdtempSync(path.join(tmpdir(), "skill-lint-test-"));
  t.after(() => rmSync(parent, { force: true, recursive: true }));
  // ESM like the repo, so tsc treats `export` as in work/<skill>.
  writeFileSync(path.join(parent, "package.json"), '{ "type": "module" }\n');
  const skillDir = path.join(parent, "skill");
  mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
  return skillDir;
};

test("skillSourceFiles skips top-level work state only", (t) => {
  const skillDir = tempSkill(t);
  for (const name of ["issue.json", "progress.md", "review.json", "SKILL.md"]) {
    writeFileSync(path.join(skillDir, name), "{}");
  }
  writeFileSync(path.join(skillDir, "scripts", "review.json"), "{}");
  writeFileSync(path.join(skillDir, "scripts", "main.ts"), "");
  assert.deepEqual(
    skillSourceFiles(`${skillDir}${path.sep}`).map((file) =>
      path.relative(skillDir, file).replaceAll("\\", "/")
    ),
    ["SKILL.md", "scripts/main.ts", "scripts/review.json"]
  );
});

test("diagnosticLines keeps matching lines, else the output tail", () => {
  const biome = [
    "× scripts/a.ts:3:1: lint/style/noIncrementDecrement: Unexpected use",
    "× examples.json",
    "  1:2: assist/source/useSortedKeys: not sorted",
    "Found 2 errors.",
    "  × Some errors were emitted while running checks.",
  ].join("\n");
  assert.deepEqual(diagnosticLines(biome, BIOME_DIAGNOSTIC), [
    "× scripts/a.ts:3:1: lint/style/noIncrementDecrement: Unexpected use",
    "× examples.json",
    "1:2: assist/source/useSortedKeys: not sorted",
  ]);
  assert.deepEqual(
    diagnosticLines("a.ts(1,7): error TS2322: bad\nnoise", TSC_DIAGNOSTIC),
    ["a.ts(1,7): error TS2322: bad"]
  );
  assert.deepEqual(diagnosticLines("\nspawn ENOENT\n", TSC_DIAGNOSTIC), [
    "spawn ENOENT",
  ]);
});

test("lintSkill passes a conformant skill", async (t) => {
  const skillDir = tempSkill(t);
  writeFileSync(path.join(skillDir, "scripts", "main.ts"), CLEAN_TS);
  // Work state is never linted, however it is formatted.
  writeFileSync(path.join(skillDir, "review.json"), UNSORTED_JSON);
  assert.deepEqual(await lintSkill(REPO_ROOT, skillDir), {
    pass: true,
    problems: [],
  });
});

test("lintSkill reports Biome and tsc problems", async (t) => {
  const skillDir = tempSkill(t);
  writeFileSync(
    path.join(skillDir, "scripts", "main.ts"),
    "let count = 0;\ncount++;\nexport const total: string = count;\n"
  );
  const result = await lintSkill(REPO_ROOT, skillDir);
  assert.equal(result.pass, false);
  const text = result.problems.join("\n");
  assert.ok(text.includes("lint/style/noIncrementDecrement"));
  assert.ok(text.includes("error TS2322"));
});

test("fixSkill formats installable files but never the locked examples.json", async (t) => {
  const skillDir = tempSkill(t);
  writeFileSync(path.join(skillDir, "scripts", "main.ts"), CLEAN_TS);
  writeFileSync(path.join(skillDir, "scripts", "data.json"), UNSORTED_JSON);
  writeFileSync(path.join(skillDir, "examples.json"), UNSORTED_JSON);
  const result = await fixSkill(REPO_ROOT, skillDir);
  assert.equal(
    readFileSync(path.join(skillDir, "examples.json"), "utf8"),
    UNSORTED_JSON
  );
  assert.notEqual(
    readFileSync(path.join(skillDir, "scripts", "data.json"), "utf8"),
    UNSORTED_JSON
  );
  // Only the untouched examples.json is left.
  assert.equal(result.pass, false);
  assert.ok(result.problems.every((line) => !line.includes("data.json")));
  assert.ok(result.problems.some((line) => line.includes("examples.json")));
});

test("formatLockedExamples formats examples.json in place", (t) => {
  const skillDir = tempSkill(t);
  const file = path.join(skillDir, "examples.json");
  writeFileSync(file, UNSORTED_JSON);
  formatLockedExamples(REPO_ROOT, file);
  assert.equal(readFileSync(file, "utf8"), '{ "b": 1, "a": [1, 2] }\n');
});
