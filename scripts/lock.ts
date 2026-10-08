// Locks a skill's acceptance examples once the user confirms the source of
// truth: `work/.locks/<skill>.json` pins the sha256 of `work/<skill>/examples.json`.
// While the lock exists, `scripts/hooks/guard-files.ts` blocks edits to the
// examples and `scripts/registry.ts install` refuses a mismatching hash.
//
//   node scripts/lock.ts <skill>
//
// Output: one JSON line; errors print `{ "error": … }` and exit 1.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPlainObject, SKILL_NAME, validateExamples } from "./lib/examples.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface SkillLock {
  lockedAt: string;
  sha256: string;
  skill: string;
}

export const lockFilePath = (root: string, skill: string): string =>
  path.join(root, "work", ".locks", `${skill}.json`);

export const examplesPath = (root: string, skill: string): string =>
  path.join(root, "work", skill, "examples.json");

export const sha256File = (filePath: string): string =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");

const assertSkillName = (skill: string): void => {
  if (!SKILL_NAME.test(skill)) {
    throw new Error(`invalid skill name "${skill}"`);
  }
};

/** The skill's lock, or `undefined` when it is not locked. */
export const readLock = (
  root: string,
  skill: string
): SkillLock | undefined => {
  assertSkillName(skill);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(lockFilePath(root, skill), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    !isPlainObject(data) ||
    typeof data.sha256 !== "string" ||
    !SHA256_HEX.test(data.sha256) ||
    typeof data.lockedAt !== "string" ||
    data.skill !== skill
  ) {
    throw new Error(`work/.locks/${skill}.json is malformed`);
  }
  return { lockedAt: data.lockedAt, sha256: data.sha256, skill };
};

export const lockSkill = (
  root: string,
  skill: string,
  now: Date = new Date()
): SkillLock => {
  assertSkillName(skill);
  const existing = readLock(root, skill);
  if (existing) {
    throw new Error(
      `${skill} is already locked since ${existing.lockedAt}; locked examples never change`
    );
  }
  const file = examplesPath(root, skill);
  const text = readFileSync(file, "utf8");
  const result = validateExamples(JSON.parse(text));
  if (!result.ok) {
    throw new Error(`work/${skill}/examples.json: ${result.error}`);
  }
  if (result.value.skill !== skill) {
    throw new Error(
      `work/${skill}/examples.json declares skill "${result.value.skill}"`
    );
  }
  const lock: SkillLock = {
    lockedAt: now.toISOString(),
    sha256: sha256File(file),
    skill,
  };
  mkdirSync(path.dirname(lockFilePath(root, skill)), { recursive: true });
  // `wx`: never overwrite a lock created concurrently.
  writeFileSync(
    lockFilePath(root, skill),
    `${JSON.stringify(lock, null, 2)}\n`,
    {
      flag: "wx",
    }
  );
  return lock;
};

const main = (): void => {
  const [, , skill] = process.argv;
  if (skill === undefined) {
    process.stderr.write("usage: node scripts/lock.ts <skill>\n");
    process.exitCode = 2;
    return;
  }
  try {
    const lock = lockSkill(REPO_ROOT, skill);
    process.stdout.write(`${JSON.stringify({ locked: skill, ...lock })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  main();
}
