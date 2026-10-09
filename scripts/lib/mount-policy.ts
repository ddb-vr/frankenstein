// Path policy for `run-skill.ts --mount <path>` (read-only at
// /input/<basename>) and `--output <dir>` (read-write at /output). Enforced
// here, in code; the hooks are only a second layer.
//
// - A mount must exist and resolve (symlinks resolved) inside one of the
//   allowed roots: `INPUT_ALLOWED_ROOTS` from `.env` (comma-separated,
//   repo-relative or absolute), default `demo/data,inputs`.
// - Always denied, even inside an allowed root: `.env*`, `*.pem`, `.git`,
//   `.claude` (anywhere in the path or inside a mounted directory), the repo's
//   `scripts/` and `work/.locks/`, and the home directory (or an ancestor).
// - The output must resolve inside the repo's `out/` (created on demand).

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

export const ALLOWED_ROOTS_ENV = "INPUT_ALLOWED_ROOTS";
export const DEFAULT_ALLOWED_ROOTS: readonly string[] = ["demo/data", "inputs"];
export const OUTPUT_ROOT = "out";
/** Prefix of every policy error, so the audit can recognize them. */
export const MOUNT_DENIED = /^(mount|output) denied: /;
// File and directory names never mounted (matched case-insensitively).
const DENIED_NAME = /^\.env|\.pem$|^\.git$|^\.claude$/i;
// Repo paths never mounted, nor any directory containing them.
const DENIED_REPO_PATHS: readonly string[] = [
  "scripts",
  path.join("work", ".locks"),
  ".git",
  ".claude",
];
const PATH_SEPARATORS = /[\\/]/;

export interface MountPolicy {
  /** Absolute allowed roots for mounts. */
  allowedRoots: readonly string[];
  /** Relative mount and output paths resolve against it. */
  cwd: string;
  home: string;
  /** Repo root; `out/` and the denied repo paths are relative to it. */
  root: string;
}

export interface MountRequest {
  mounts: readonly string[];
  output?: string;
}

export interface ResolvedMounts {
  /** Absolute paths as given (the sandbox names them by basename). */
  mounts: string[];
  /** Real path of the output directory, created on demand. */
  outputDir?: string;
}

/** Absolute allowed roots from the env value; blank means the default. */
export const allowedRootsFrom = (
  value: string | undefined,
  root: string
): string[] => {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return (entries.length > 0 ? entries : DEFAULT_ALLOWED_ROOTS).map((entry) =>
    path.resolve(root, entry)
  );
};

/**
 * `INPUT_ALLOWED_ROOTS` from `<root>/.env` only: a value set in the shell
 * (`INPUT_ALLOWED_ROOTS=/ node scripts/run-skill.ts …`) cannot widen it.
 */
export const loadAllowedRoots = (root: string): string[] => {
  let content = "";
  try {
    content = readFileSync(path.join(root, ".env"), "utf8");
  } catch (error) {
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) {
      throw error;
    }
  }
  return allowedRootsFrom(parseEnv(content)[ALLOWED_ROOTS_ENV], root);
};

const realPathOrSelf = (file: string): string => {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
};

/** `child` is `parent` or below it. */
const isWithin = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

/** Case-insensitive `isWithin`: over-denies rather than misses on macOS/Windows. */
const isWithinFolded = (child: string, parent: string): boolean =>
  isWithin(child.toLowerCase(), parent.toLowerCase());

/** Home directory and repo paths: denied wherever the allowed roots are. */
const protectedPathReason = (
  real: string,
  policy: MountPolicy
): string | undefined => {
  if (isWithinFolded(realPathOrSelf(policy.home), real)) {
    return "it is or contains the home directory";
  }
  const root = realPathOrSelf(policy.root);
  for (const entry of DENIED_REPO_PATHS) {
    const denied = realPathOrSelf(path.join(root, entry));
    if (isWithinFolded(real, denied) || isWithinFolded(denied, real)) {
      return `it is, is inside or contains the repo's ${entry.replaceAll("\\", "/")}`;
    }
  }
};

/** A denied name below `allowedRoot` or anywhere inside a directory mount. */
const deniedNameReason = (
  real: string,
  allowedRoot: string
): string | undefined => {
  const candidates = [path.relative(allowedRoot, real)];
  if (statSync(real).isDirectory()) {
    candidates.push(...readdirSync(real, { recursive: true }).map(String));
  }
  for (const [index, candidate] of candidates.entries()) {
    const segment = candidate
      .split(PATH_SEPARATORS)
      .find((part) => DENIED_NAME.test(part));
    if (segment !== undefined) {
      const what =
        index === 0
          ? `${segment} is`
          : `the directory contains ${candidate.replaceAll("\\", "/")}, which is`;
      return `${what} never mounted (.env*, *.pem, .git, .claude)`;
    }
  }
};

/** Absolute path of one `--mount`; throws `mount denied: …` otherwise. */
export const checkMount = (given: string, policy: MountPolicy): string => {
  const deny = (why: string, cause?: unknown): Error =>
    new Error(`mount denied: ${given}: ${why}`, { cause });
  const absolute = path.resolve(policy.cwd, given);
  if (DENIED_NAME.test(path.basename(absolute))) {
    throw deny(
      `${path.basename(absolute)} is never mounted (.env*, *.pem, .git, .claude)`
    );
  }
  let real: string;
  try {
    real = realpathSync.native(absolute);
  } catch (error) {
    throw deny("it does not exist", error);
  }
  const protectedReason = protectedPathReason(real, policy);
  if (protectedReason !== undefined) {
    throw deny(protectedReason);
  }
  const allowedRoot = policy.allowedRoots
    .map(realPathOrSelf)
    .find((allowed) => isWithin(real, allowed));
  if (allowedRoot === undefined) {
    const roots = policy.allowedRoots
      .map((allowed) =>
        path.relative(policy.root, allowed).replaceAll("\\", "/")
      )
      .join(", ");
    throw deny(
      `it is outside the allowed roots (${roots}; ${ALLOWED_ROOTS_ENV} in .env)${real === absolute ? "" : ` after resolving symlinks to ${real}`}`
    );
  }
  const nameReason = deniedNameReason(real, allowedRoot);
  if (nameReason !== undefined) {
    throw deny(nameReason);
  }
  return absolute;
};

/** Nearest existing ancestor of `file` (itself included). */
const existingAncestor = (file: string): string => {
  let current = file;
  while (statSync(current, { throwIfNoEntry: false }) === undefined) {
    current = path.dirname(current);
  }
  return current;
};

/**
 * Real path of the `--output` directory inside `out/`, created on demand
 * only once the target is known to stay inside it; throws
 * `output denied: …` otherwise.
 */
export const resolveOutput = (given: string, policy: MountPolicy): string => {
  const deny = (reason: string): Error =>
    new Error(`output denied: ${given}: ${reason}`);
  const absolute = path.resolve(policy.cwd, given);
  const lexicalOut = path.join(policy.root, OUTPUT_ROOT);
  const realOut = path.join(realPathOrSelf(policy.root), OUTPUT_ROOT);
  if (!(isWithin(absolute, lexicalOut) || isWithin(absolute, realOut))) {
    throw deny(`it must be inside ${OUTPUT_ROOT}/`);
  }
  mkdirSync(lexicalOut, { recursive: true });
  if (realPathOrSelf(lexicalOut) !== realOut) {
    throw deny(`${OUTPUT_ROOT}/ must be a real directory, not a symlink`);
  }
  // Checked before creating anything, so mkdir cannot follow a symlink out.
  if (!isWithin(realPathOrSelf(existingAncestor(absolute)), realOut)) {
    throw deny(`it resolves outside ${OUTPUT_ROOT}/ through a symlink`);
  }
  const existing = statSync(absolute, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isDirectory()) {
    throw deny("it is not a directory");
  }
  mkdirSync(absolute, { recursive: true });
  return realpathSync.native(absolute);
};

/**
 * Applies the policy to every mount, then the output. Two mounts with the
 * same basename (both `/input/<name>`) are refused here too, so the sandbox
 * never starts with them.
 */
export const resolveMounts = (
  request: MountRequest,
  policy: MountPolicy
): ResolvedMounts => {
  const mounts = request.mounts.map((given) => checkMount(given, policy));
  const byName = new Map<string, string>();
  for (const [index, mount] of mounts.entries()) {
    const given = request.mounts[index] ?? mount;
    const name = path.basename(mount);
    const previous = byName.get(name);
    if (previous !== undefined) {
      throw new Error(
        `mount denied: ${given}: same name as ${previous}, both would be /input/${name}`
      );
    }
    byName.set(name, given);
  }
  return request.output === undefined
    ? { mounts }
    : { mounts, outputDir: resolveOutput(request.output, policy) };
};

/** The policy for this repo: allowed roots from `.env`, the real home. */
export const repoMountPolicy = (root: string, cwd: string): MountPolicy => ({
  allowedRoots: loadAllowedRoots(root),
  cwd,
  home: homedir(),
  root,
});
