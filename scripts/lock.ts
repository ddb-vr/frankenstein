// Locks a skill's acceptance examples once the user confirms the source of
// truth: `work/.locks/<skill>.json` pins one sha256 (`hashExamples`) over
// `work/<skill>/examples.json` and every file under `work/<skill>/fixtures/input/`
// (the examples' input files). While the lock exists,
// `scripts/hooks/guard-files.ts` blocks edits to both and
// `scripts/registry.ts install` refuses a mismatching hash.
//
//   node scripts/lock.ts <skill>
//
// The CLI Biome-formats the examples once before hashing, since the installed
// copy is linted and a locked file can never be reformatted.
//
// Output: one JSON line on stdout; errors print `{ "error": … }` on stderr and
// exit 1.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isPlainObject, SKILL_NAME, validateExamples } from "./lib/examples.ts";
import { formatLockedExamples } from "./lib/skill-lint.ts";

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

const FIXTURE_INPUTS = path.join("fixtures", "input");

/**
 * One sha256 over a skill directory's `examples.json` and every file under
 * `fixtures/input/` (symlinks by their target), in sorted posix-path order.
 * Each entry feeds `path NUL length NUL bytes`, so no two trees collide.
 */
export const hashExamples = (skillDir: string): string => {
  const entries: [string, Buffer][] = [
    ["examples.json", readFileSync(path.join(skillDir, "examples.json"))],
  ];
  const inputs = path.join(skillDir, FIXTURE_INPUTS);
  if (existsSync(inputs)) {
    for (const entry of readdirSync(inputs, {
      recursive: true,
      withFileTypes: true,
    })) {
      const absolute = path.join(entry.parentPath, entry.name);
      const relative = path
        .relative(skillDir, absolute)
        .split(path.sep)
        .join("/");
      if (entry.isFile()) {
        entries.push([relative, readFileSync(absolute)]);
      } else if (entry.isSymbolicLink()) {
        entries.push([
          `${relative} -> symlink`,
          Buffer.from(readlinkSync(absolute)),
        ]);
      }
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
  const hash = createHash("sha256");
  for (const [relative, bytes] of entries) {
    hash.update(`${relative}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest("hex");
};

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
    sha256: hashExamples(path.dirname(file)),
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
    if (readLock(REPO_ROOT, skill) === undefined) {
      // The installed examples.json is linted, and a locked file can never be
      // reformatted (its hash is pinned), so format it once before hashing.
      formatLockedExamples(REPO_ROOT, examplesPath(REPO_ROOT, skill));
    }
    const lock = lockSkill(REPO_ROOT, skill);
    process.stdout.write(`${JSON.stringify({ locked: skill, ...lock })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  main();
}
