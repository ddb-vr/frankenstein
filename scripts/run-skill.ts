// Runs an installed skill in the Docker sandbox: the only way the agent uses
// a skill from `.claude/skills/`. The skill must be enabled in `registry.json`;
// network access follows its registry entry. Not in test mode.
//
//   node scripts/run-skill.ts <skill> '<json>' [--mount <path>]... [--output <dir>]
//   node scripts/run-skill.ts <skill> --input-file <file> [--mount <path>]... [--output <dir>]
//
// The JSON input is a CLI argument or a file; stdin is not read, so a pipe
// into this script fails with the missing-input error. Exactly one of the two
// must be given.
//
// `--mount` (repeatable) mounts a file or directory read-only at
// `/input/<basename>`; `--output` mounts a directory inside `out/` read-write at
// `/output`. Both pass the path policy in `lib/mount-policy.ts` before
// anything starts; the skill gets only the paths, in its JSON input.
//
// stdout: the skill's JSON output (exit code passed through). Errors before
// the skill runs print `{ "error": … }` and exit 1. Full stderr goes to
// `logs/<name>/run-<timestamp>.log`.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SKILL_ENTRY, SKILL_NAME } from "./lib/examples.ts";
import { repoMountPolicy, resolveMounts } from "./lib/mount-policy.ts";
import { type RegistryEntry, readRegistry } from "./lib/registry.ts";
import { runInSandbox, type SandboxResult, SKILL_MOUNT } from "./sandbox.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const INPUT_FILE_FLAG = "--input-file";
const MOUNT_FLAG = "--mount";
const OUTPUT_FLAG = "--output";
const VALUE_FLAGS = [INPUT_FILE_FLAG, MOUNT_FLAG, OUTPUT_FLAG] as const;
const USAGE =
  "usage: node scripts/run-skill.ts <skill> '<json>' | --input-file <file> [--mount <path>]... [--output <dir>]";

export interface Invocation {
  input: unknown;
  /** `--mount` paths as given, in order. */
  mounts: string[];
  name: string;
  /** `--output` directory as given. */
  output?: string;
}

type ValueFlag = (typeof VALUE_FLAGS)[number];

/** Values of `--flag <v>` / `--flag=<v>` options; other words are inline. */
const splitArgs = (
  args: readonly string[]
): { inline: string[]; values: Record<ValueFlag, string[]> } => {
  const inline: string[] = [];
  const values: Record<ValueFlag, string[]> = {
    [INPUT_FILE_FLAG]: [],
    [MOUNT_FLAG]: [],
    [OUTPUT_FLAG]: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const flag = VALUE_FLAGS.find(
      (candidate) => arg === candidate || arg.startsWith(`${candidate}=`)
    );
    if (flag === undefined) {
      inline.push(arg);
      continue;
    }
    const value = arg === flag ? args[index + 1] : arg.slice(flag.length + 1);
    if (value === undefined || value === "") {
      throw new Error(`${flag} needs a path`);
    }
    values[flag].push(value);
    index += arg === flag ? 1 : 0;
  }
  return { inline, values };
};

/**
 * Skill name, parsed JSON input, mounts and output from the CLI arguments
 * (after the script path). Hand-parsed so an inline value like `-1` stays a
 * JSON argument.
 */
export const parseInvocation = (
  args: readonly string[],
  readText: (file: string) => string = (file) => readFileSync(file, "utf8")
): Invocation => {
  const [name, ...rest] = args;
  if (name === undefined) {
    throw new Error(USAGE);
  }
  const { inline, values } = splitArgs(rest);
  const files = values[INPUT_FILE_FLAG];
  const outputs = values[OUTPUT_FLAG];
  if (outputs.length > 1) {
    throw new Error(`pass ${OUTPUT_FLAG} at most once`);
  }
  if (inline.length + files.length !== 1) {
    throw new Error(
      `pass the JSON input exactly once: as one argument '<json>' or with ${INPUT_FILE_FLAG} <path> (${USAGE})`
    );
  }
  const [file] = files;
  let text: string;
  if (file === undefined) {
    text = inline[0] ?? "";
  } else {
    try {
      text = readText(file);
    } catch (error) {
      throw new Error(`cannot read input file ${file}`, { cause: error });
    }
  }
  let input: unknown;
  try {
    // The parse error is not echoed: it would quote the file's content.
    input = JSON.parse(text);
  } catch (error) {
    throw new Error(
      file === undefined
        ? "input must be one JSON value"
        : `input file ${file} must contain one JSON value`,
      { cause: error }
    );
  }
  const [output] = outputs;
  return {
    input,
    mounts: values[MOUNT_FLAG],
    name,
    ...(output === undefined ? {} : { output }),
  };
};

const writeLog = (name: string, lines: string[]): string => {
  const dir = path.join(REPO_ROOT, "logs", name);
  mkdirSync(dir, { recursive: true });
  // Milliseconds: two runs in the same second must not share a log.
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const file = path.join(dir, `run-${stamp}.log`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return path.relative(REPO_ROOT, file).replaceAll("\\", "/");
};

/** The skill's registry entry; throws unless it is installed and enabled. */
export const enabledEntry = (root: string, name: string): RegistryEntry => {
  if (!SKILL_NAME.test(name)) {
    throw new Error(`invalid skill name "${name}"`);
  }
  const entry = readRegistry(root).skills.find((skill) => skill.name === name);
  if (!entry) {
    throw new Error(`skill "${name}" is not installed`);
  }
  if (!entry.enabled) {
    throw new Error(`skill "${name}" is disabled`);
  }
  return entry;
};

const run = async ({
  input,
  mounts,
  name,
  output,
}: Invocation): Promise<number> => {
  const entry = enabledEntry(REPO_ROOT, name);
  // Before the sandbox and the run log: a denied path starts nothing.
  const resolved = resolveMounts(
    { mounts, output },
    repoMountPolicy(REPO_ROOT, process.cwd())
  );
  const header = [
    `skill: ${name} ${entry.version}`,
    `network: ${entry.network}`,
    `input: ${JSON.stringify(input)}`,
  ];
  const runRecords: string[] = [];
  let result: SandboxResult;
  try {
    result = await runInSandbox({
      command: [`${SKILL_MOUNT}/${SKILL_ENTRY}`],
      ...resolved,
      network: entry.network,
      onRunLog: (record) => runRecords.push(record),
      skillDir: path.join(REPO_ROOT, ".claude", "skills", name),
      stdin: JSON.stringify(input),
      testMode: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const log = writeLog(name, [...header, ...runRecords, `error: ${message}`]);
    throw new Error(`${message} (log: ${log})`, { cause: error });
  }
  const log = writeLog(name, [
    ...header,
    ...runRecords,
    `exit: ${result.exitCode}, ${result.durationMs}ms${result.timedOut ? ", TIMED OUT" : ""}`,
    "stdout:",
    result.stdout,
    "stderr:",
    result.stderr,
  ]);
  if (result.timedOut) {
    throw new Error(`skill "${name}" timed out (log: ${log})`);
  }
  process.stdout.write(
    result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`
  );
  return result.exitCode;
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = await run(parseInvocation(args));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
