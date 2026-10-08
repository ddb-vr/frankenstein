// Demo reset (operator only, `npm run demo:reset [-- --yes]`): removes every
// registry skill with its local and remote version tags (`registry.ts remove
// <name> --delete-tags`, one bot commit each), then clears `work/` and `logs/`
// except their `.gitkeep`. GitHub issues are never touched. Asks for
// confirmation unless `--yes`. Prints one JSON line `{ removed, failed,
// cleared }`; a failed remove leaves `work/` and `logs/` as they are (exit 1).

import { readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { loadDotEnv } from "./lib/env.ts";
import { type OperatorResult, removeSkill } from "./lib/operator.ts";
import { type RegistryDeps, readRegistry, realDeps } from "./lib/registry.ts";

const CLEARED_DIRS = ["work", "logs"] as const;
const KEEP = ".gitkeep";
const YES = /^y(es)?$/i;

export interface ResetResult {
  cleared: string[];
  failed: OperatorResult[];
  removed: OperatorResult[];
}

export const resetDemo = async (deps: RegistryDeps): Promise<ResetResult> => {
  const result: ResetResult = { cleared: [], failed: [], removed: [] };
  for (const { name } of readRegistry(deps.root).skills) {
    // biome-ignore lint/performance/noAwaitInLoops: each remove commits and pushes on top of the previous one.
    const removed = await removeSkill(name, { deleteTags: true }, deps);
    (removed.ok ? result.removed : result.failed).push(removed);
  }
  if (result.failed.length > 0) {
    return result;
  }
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
      `Remove ${skills.length === 0 ? "no skills" : skills.join(", ")} with all their tags (local and origin), and clear work/ and logs/? [y/N] `
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
  const result = await resetDemo(realDeps);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.failed.length > 0 ? 1 : 0;
};

if (import.meta.main) {
  await main();
}
