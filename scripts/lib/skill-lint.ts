// Build-time repo conformance for generated skills. Biome honours .gitignore,
// so `npm run check` never sees `work/<skill>/`; `registry.ts install` then
// copies the skill into `.claude/skills/`, where `npm run check` (Biome) and
// `npm run typecheck` (tsc, tsconfig includes `.claude/**`) do see it. These
// helpers run the same tools on the skill while it is still in `work/`:
// `run-examples.ts` fails its `lint` stage on any problem, and
// `fix-skill.ts` applies the safe fixes.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Work state that `registry.ts install` does not copy (its `NOT_INSTALLED`). */
const WORK_STATE_FILES: Record<string, true> = {
  "issue.json": true,
  "progress.md": true,
  "review.json": true,
};
/** Locked by `lock.ts` (formatted there); rewriting it would break the lock hash. */
const LOCKED_EXAMPLES = "examples.json";
export const BIOME_DIAGNOSTIC = /^(?:× (?!Some errors|No files)|\s+\d+:\d+: )/u;
export const TSC_DIAGNOSTIC = /\berror TS\d+:/u;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_TOOL_OUTPUT = 10 * 1024 * 1024;
const FALLBACK_LINES = 5;

export interface LintResult {
  pass: boolean;
  /** One line per problem; empty when `pass`. */
  problems: string[];
}

interface ToolRun {
  exitCode: number;
  output: string;
}

const binPath = (root: string, name: string): string =>
  path.join(root, "node_modules", ".bin", name);

/** Biome flags shared by every call: repo config, no .gitignore filtering. */
const biomeFlags = (root: string): string[] => [
  `--config-path=${root}`,
  "--vcs-use-ignore-file=false",
  "--files-ignore-unknown=true",
  "--no-errors-on-unmatched",
  "--colors=off",
];

const runTool = async (
  file: string,
  args: string[],
  cwd: string
): Promise<ToolRun> => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd,
      maxBuffer: MAX_TOOL_OUTPUT,
      timeout: TOOL_TIMEOUT_MS,
    });
    return { exitCode: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as Error & {
      code?: unknown;
      stderr?: string;
      stdout?: string;
    };
    // `message` repeats stderr; keep it only when the tool printed nothing
    // (spawn failure, timeout).
    const printed = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      output: printed.trim() === "" ? failure.message : printed,
    };
  }
};

/** Path for tool arguments: relative to `root` when inside it (short output). */
const toolPath = (root: string, file: string): string => {
  const relative = path.relative(root, file);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? file
    : relative;
};

/**
 * Every file `registry.ts install` copies (all of `skillDir` except the
 * top-level work state), sorted, absolute.
 */
export const skillSourceFiles = (skillDir: string): string[] => {
  const root = path.resolve(skillDir);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !(entry.parentPath === root && WORK_STATE_FILES[entry.name] === true)
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
};

/** Diagnostic lines from tool output; the output's tail when none match. */
export const diagnosticLines = (output: string, pattern: RegExp): string[] => {
  const lines = output.split("\n");
  const matched = lines
    .filter((line) => pattern.test(line))
    .map((line) => line.trim());
  if (matched.length > 0) {
    return matched;
  }
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-FALLBACK_LINES);
};

const biomeCheck = async (
  root: string,
  files: string[],
  write: boolean
): Promise<ToolRun> => {
  // Without paths Biome would check the whole working directory.
  if (files.length === 0) {
    return { exitCode: 0, output: "" };
  }
  return await runTool(
    binPath(root, "biome"),
    [
      "check",
      ...(write ? ["--write"] : []),
      ...biomeFlags(root),
      "--reporter=concise",
      ...files.map((file) => toolPath(root, file)),
    ],
    root
  );
};

/** `tsc --noEmit` over the skill's `.ts` files with the repo's compiler options. */
const typecheck = async (root: string, skillDir: string): Promise<ToolRun> => {
  const configDir = mkdtempSync(path.join(tmpdir(), "skill-tsc-"));
  const configPath = path.join(configDir, "tsconfig.json");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        // Type roots resolve from the config's directory; pin the repo's.
        compilerOptions: {
          typeRoots: [path.join(root, "node_modules", "@types")],
        },
        extends: path.join(root, "tsconfig.json"),
        include: [path.join(skillDir, "**", "*.ts")],
      })
    );
    return await runTool(
      binPath(root, "tsc"),
      ["--noEmit", "--pretty", "false", "-p", configPath],
      root
    );
  } finally {
    rmSync(configDir, { force: true, recursive: true });
  }
};

/**
 * Biome (`npm run check` rules, .gitignore not applied) and tsc over the
 * files install would copy. Never writes.
 */
export const lintSkill = async (
  root: string,
  skillDir: string
): Promise<LintResult> => {
  const dir = path.resolve(skillDir);
  const files = skillSourceFiles(dir);
  const [biome, tsc] = await Promise.all([
    biomeCheck(root, files, false),
    files.some((file) => file.endsWith(".ts"))
      ? typecheck(root, dir)
      : Promise.resolve({ exitCode: 0, output: "" }),
  ]);
  const problems = [
    ...(biome.exitCode === 0
      ? []
      : diagnosticLines(biome.output, BIOME_DIAGNOSTIC)),
    ...(tsc.exitCode === 0 ? [] : diagnosticLines(tsc.output, TSC_DIAGNOSTIC)),
  ];
  return { pass: problems.length === 0, problems };
};

/**
 * Biome's safe fixes and formatting on every installable file except the
 * locked `examples.json`, then {@link lintSkill} for what is left.
 */
export const fixSkill = async (
  root: string,
  skillDir: string
): Promise<LintResult> => {
  const fixable = skillSourceFiles(skillDir).filter(
    (file) => file !== path.resolve(skillDir, LOCKED_EXAMPLES)
  );
  await biomeCheck(root, fixable, true);
  return await lintSkill(root, skillDir);
};

/**
 * Formats `examples.json` the way `npm run check` expects, before `lock.ts`
 * pins its hash (afterwards nobody may rewrite it). Throws on failure.
 */
export const formatLockedExamples = (root: string, file: string): void => {
  try {
    execFileSync(
      binPath(root, "biome"),
      ["format", "--write", ...biomeFlags(root), toolPath(root, file)],
      { cwd: root, stdio: "pipe", timeout: TOOL_TIMEOUT_MS }
    );
  } catch (error) {
    const failure = error as Error & { stderr?: Buffer; stdout?: Buffer };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    throw new Error(
      `biome format failed for ${toolPath(root, file)}: ${diagnosticLines(output, BIOME_DIAGNOSTIC).join("; ")}`,
      { cause: error }
    );
  }
};
