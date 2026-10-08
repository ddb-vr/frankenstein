// Makes a skill under construction repo-conformant before install: applies
// Biome's safe fixes and formatting to everything in `work/<skill>/` that
// `registry.ts install` copies, except the locked `examples.json`, then runs the
// build-time lint (Biome with the `npm run check` rules, tsc with the repo's
// compiler options) that `run-examples.ts` enforces in its `lint` stage.
//
//   node scripts/fix-skill.ts <skill>
//
// Output: one JSON line `{ "skill", "pass": true }`, or
// `{ "skill", "pass": false, "problems": [...] }` (exit 1) listing what is left
// to fix by hand. Bad arguments print `{ "error": … }` on stderr (exit 2).

import { statSync } from "node:fs";
import path from "node:path";
import { SKILL_NAME } from "./lib/examples.ts";
import { fixSkill } from "./lib/skill-lint.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const main = async (): Promise<void> => {
  const [, , skill] = process.argv;
  if (skill === undefined || !SKILL_NAME.test(skill)) {
    process.stderr.write(
      `${JSON.stringify({ error: "usage: node scripts/fix-skill.ts <skill> (kebab-case skill name)" })}\n`
    );
    process.exitCode = 2;
    return;
  }
  const skillDir = path.join(REPO_ROOT, "work", skill);
  if (!statSync(skillDir, { throwIfNoEntry: false })?.isDirectory()) {
    process.stderr.write(
      `${JSON.stringify({ error: `work/${skill} not found` })}\n`
    );
    process.exitCode = 2;
    return;
  }
  const result = await fixSkill(REPO_ROOT, skillDir);
  process.stdout.write(
    `${JSON.stringify(result.pass ? { pass: true, skill } : { pass: false, problems: result.problems, skill })}\n`
  );
  process.exitCode = result.pass ? 0 : 1;
};

if (import.meta.main) {
  await main();
}
