// PreToolUse hook (matcher `Write|Edit|MultiEdit|NotebookEdit`): blocks file
// tool writes to locked acceptance examples, review verdicts (written only by
// `capture-review.ts`), lock files, run state, installed and disabled skills, Claude
// settings, repo scripts and the registry. The target is matched both as
// given and with symlinks resolved, so a link (`work/x/self -> .`) cannot
// redirect a write into a protected path.

import { existsSync } from "node:fs";
import path from "node:path";
import {
  type Decision,
  type HookInput,
  isWithin,
  REPO_ROOT,
  repoRelative,
  resolveSymlinks,
  runHook,
} from "./lib.ts";

export interface FileGuardContext {
  /** Whether a repo-relative path exists. */
  exists: (relativePath: string) => boolean;
  /** Absolute path of `filePath` (relative to `cwd`) with symlinks resolved. */
  realPath: (filePath: string, cwd: string) => string;
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
  {
    entry: "work/.run",
    reason: "run state is written only by the hooks (budget, capture-review)",
  },
  { entry: ".claude/skills", reason: INSTALLED_BY_SCRIPT },
  {
    entry: ".claude/disabled-skills",
    reason:
      "skills are disabled and enabled only by the user (`npm run skills -- disable|enable <name>` in a terminal)",
  },
  { entry: ".claude/settings.json", reason: USER_OWNED },
  { entry: ".claude/settings.local.json", reason: USER_OWNED },
  { entry: "scripts", reason: USER_OWNED },
  {
    entry: "registry.json",
    reason: "the registry is updated only by `node scripts/registry.ts`",
  },
];

const WORK_JSON = /^work\/([^/]+)\/(examples|review)\.json$/;

/** Why a write to repo-relative `relative` is denied, if it is. */
const protectedReason = (
  relative: string,
  context: FileGuardContext
): Decision => {
  for (const { entry, reason } of PROTECTED) {
    if (isWithin(relative, entry)) {
      return `Blocked: ${entry} is protected; ${reason}.`;
    }
  }
  const [, skill, kind] = WORK_JSON.exec(relative) ?? [];
  if (kind === "examples" && context.exists(`work/.locks/${skill}.json`)) {
    return `Blocked: work/${skill}/examples.json is locked (the user confirmed it as the source of truth). Build against it unchanged; report a wrong example to the main agent instead.`;
  }
  if (kind === "review") {
    return `Blocked: work/${skill}/review.json is written only by the capture-review hook from the skill-reviewer's final \`verdict\` block. Invoke the skill-reviewer instead.`;
  }
};

export const checkFileWrite = (
  input: HookInput,
  context: FileGuardContext
): Decision => {
  const { file_path: filePath, notebook_path: notebookPath } = input.tool_input;
  const target = filePath ?? notebookPath;
  if (typeof target !== "string") {
    return `Blocked: ${input.tool_name} call without a file path.`;
  }
  const lexical = repoRelative(target, context.root, input.cwd);
  const resolved = repoRelative(
    context.realPath(target, input.cwd),
    context.realPath(context.root, context.root)
  );
  for (const relative of [lexical, resolved]) {
    const reason =
      relative === undefined ? undefined : protectedReason(relative, context);
    if (reason !== undefined) {
      return relative === lexical
        ? reason
        : `${reason} (${target} resolves to ${relative} through a symlink)`;
    }
  }
};

if (import.meta.main) {
  runHook((input) =>
    checkFileWrite(input, {
      exists: (relativePath) => existsSync(path.join(REPO_ROOT, relativePath)),
      realPath: (filePath, cwd) => resolveSymlinks(path.resolve(cwd, filePath)),
      root: REPO_ROOT,
    })
  );
}
