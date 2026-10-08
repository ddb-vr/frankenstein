// PreToolUse hook (matcher `Write|Edit|MultiEdit|NotebookEdit`): blocks file
// tool writes to locked acceptance examples, written review verdicts, lock
// files, installed skills, Claude settings, repo scripts and the registry.

import { existsSync } from "node:fs";
import path from "node:path";
import {
  type Decision,
  type HookInput,
  isWithin,
  REPO_ROOT,
  repoRelative,
  runHook,
} from "./lib.ts";

export interface FileGuardContext {
  /** Whether a repo-relative path exists. */
  exists: (relativePath: string) => boolean;
  root: string;
}

const LOCKED_BY_SCRIPT =
  "lock files are written only by `node scripts/lock.ts <skill>`";
const INSTALLED_BY_SCRIPT =
  "skills are installed only by `node scripts/registry.ts install <skill>`";
const USER_OWNED = "it is maintained by the user; ask them to change it";

// Repo-relative, lower-case (see `repoRelative`).
const PROTECTED: readonly { entry: string; reason: string }[] = [
  { entry: "work/.locks", reason: LOCKED_BY_SCRIPT },
  { entry: ".claude/skills", reason: INSTALLED_BY_SCRIPT },
  { entry: ".claude/settings.json", reason: USER_OWNED },
  { entry: ".claude/settings.local.json", reason: USER_OWNED },
  { entry: "scripts", reason: USER_OWNED },
  {
    entry: "registry.json",
    reason: "the registry is updated only by `node scripts/registry.ts`",
  },
];

const WORK_JSON = /^work\/([^/]+)\/(examples|review)\.json$/;

export const checkFileWrite = (
  input: HookInput,
  context: FileGuardContext
): Decision => {
  const { file_path: filePath, notebook_path: notebookPath } = input.tool_input;
  const target = filePath ?? notebookPath;
  if (typeof target !== "string") {
    return `Blocked: ${input.tool_name} call without a file path.`;
  }
  const relative = repoRelative(target, context.root, input.cwd);
  if (relative === undefined) {
    return;
  }
  for (const { entry, reason } of PROTECTED) {
    if (isWithin(relative, entry)) {
      return `Blocked: ${entry} is protected; ${reason}.`;
    }
  }
  const [, skill, kind] = WORK_JSON.exec(relative) ?? [];
  if (kind === "examples" && context.exists(`work/.locks/${skill}.json`)) {
    return `Blocked: work/${skill}/examples.json is locked (the user confirmed it as the source of truth). Build against it unchanged; report a wrong example to the main agent instead.`;
  }
  if (kind === "review" && context.exists(relative)) {
    return `Blocked: work/${skill}/review.json is already written; a review verdict is final.`;
  }
};

if (import.meta.main) {
  runHook((input) =>
    checkFileWrite(input, {
      exists: (relativePath) => existsSync(path.join(REPO_ROOT, relativePath)),
      root: REPO_ROOT,
    })
  );
}
