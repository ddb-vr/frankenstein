// Demo reset (operator only, `npm run demo:reset [-- --yes]`): removes every
// registry skill with its local and remote version tags (`registry.ts remove
// <name> --delete-tags`, one bot commit each), deletes the `skill/*@vN` tags
// left by skills removed earlier without `--delete-tags`, then clears `work/`
// and `logs/` except their `.gitkeep`. GitHub issues are never touched. Asks
// for confirmation unless `--yes`. Prints one JSON line `{ removed, failed,
// orphanTags, cleared }`; a failed remove leaves the rest as it is (exit 1).

import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadDotEnv } from "./lib/env.ts";
import {
  type OperatorResult,
  remoteVersionTags,
  removeSkill,
  SKILL_TAG,
} from "./lib/operator.ts";
import {
  message,
  pushChange,
  type RegistryDeps,
  readRegistry,
  realDeps,
} from "./lib/registry.ts";

const CLEARED_DIRS = ["work", "logs"] as const;
const KEEP = ".gitkeep";
const YES = /^y(es)?$/i;

export interface ResetResult {
  cleared: string[];
  failed: OperatorResult[];
  /** Version tags of skills no longer in the registry, deleted everywhere. */
  orphanTags: string[];
  removed: OperatorResult[];
}

/** Deletes every remaining `skill/<name>@vN` tag on origin, then locally. */
const deleteOrphanTags = async (deps: RegistryDeps): Promise<string[]> => {
  await deps.credentials();
  const remote = await remoteVersionTags(deps);
  const local = (await deps.git(["-C", deps.root, "tag", "--list", "skill/*"]))
    .split("\n")
    .map((tag) => tag.trim())
    .filter((tag) => SKILL_TAG.test(tag));
  if (remote.length > 0) {
    await pushChange(
      deps,
      remote.map((tag) => `:refs/tags/${tag}`)
    );
  }
  if (local.length > 0) {
    await deps.bot("git", ["-C", deps.root, "tag", "-d", ...local]);
  }
  return [...new Set([...local, ...remote])].sort();
};

export const resetDemo = async (deps: RegistryDeps): Promise<ResetResult> => {
  const result: ResetResult = {
    cleared: [],
    failed: [],
    orphanTags: [],
    removed: [],
  };
  for (const { name } of readRegistry(deps.root).skills) {
    // biome-ignore lint/performance/noAwaitInLoops: each remove commits and pushes on top of the previous one.
    const removed = await removeSkill(name, { deleteTags: true }, deps);
    (removed.ok ? result.removed : result.failed).push(removed);
  }
  if (result.failed.length > 0) {
    return result;
  }
  result.orphanTags = await deleteOrphanTags(deps);
  for (const dir of CLEARED_DIRS) {
    const absolute = path.join(deps.root, dir);
    for (const name of readdirSync(absolute)) {
      if (name !== KEEP) {
        rmSync(path.join(absolute, name), { force: true, recursive: true });
      }
    }
    result.cleared.push(dir);
  }
  return result;
};

const confirmed = async (skills: readonly string[]): Promise<boolean> => {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await prompt.question(
      `Remove ${
        skills.length === 0 ? "no skills" : skills.join(", ")
      } with all their tags (local and origin), and clear work/ and logs/? [y/N] `
    );
    return YES.test(answer.trim());
  } finally {
    prompt.close();
  }
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    options: { yes: { default: false, type: "boolean" } },
    strict: true,
  });
  const skills = readRegistry(realDeps.root).skills.map(({ name }) => name);
  if (!(values.yes || (await confirmed(skills)))) {
    process.stderr.write("Aborted; nothing changed.\n");
    process.exitCode = 1;
    return;
  }
  loadDotEnv();
  try {
    const result = await resetDemo(realDeps);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.failed.length > 0 ? 1 : 0;
  } catch (error) {
    // Orphan tag deletion failed after every remove succeeded.
    process.stdout.write(`${JSON.stringify({ error: message(error) })}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
