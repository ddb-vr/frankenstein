// Runs an installed skill in the Docker sandbox: the only way the agent uses
// a skill from `.claude/skills/`. The skill must be enabled in `registry.json`;
// network access follows its registry entry. Not in test mode.
//
//   node scripts/run-skill.ts <name> '<json input>'
//
// stdout: the skill's JSON output (exit code passed through). Errors before
// the skill runs print `{ "error": … }` and exit 1. Full stderr goes to
// `logs/<name>/run-<timestamp>.log`.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SKILL_NAME } from "./lib/examples.ts";
import { readRegistry } from "./registry.ts";
import { runInSandbox, SKILL_MOUNT } from "./sandbox.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const ENTRY = "scripts/main.ts";

const writeLog = (name: string, lines: string[]): string => {
  const dir = path.join(REPO_ROOT, "logs", name);
  mkdirSync(dir, { recursive: true });
  // Milliseconds: two runs in the same second must not share a log.
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const file = path.join(dir, `run-${stamp}.log`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return path.relative(REPO_ROOT, file).replaceAll("\\", "/");
};

const run = async (name: string, inputText: string): Promise<number> => {
  if (!SKILL_NAME.test(name)) {
    throw new Error(`invalid skill name "${name}"`);
  }
  let input: unknown;
  try {
    input = JSON.parse(inputText);
  } catch (error) {
    throw new Error("input must be one JSON value", { cause: error });
  }
  const entry = readRegistry(REPO_ROOT).skills.find(
    (skill) => skill.name === name
  );
  if (!entry) {
    throw new Error(`skill "${name}" is not installed`);
  }
  if (!entry.enabled) {
    throw new Error(`skill "${name}" is disabled`);
  }
  const result = await runInSandbox({
    command: [`${SKILL_MOUNT}/${ENTRY}`],
    network: entry.network,
    skillDir: path.join(REPO_ROOT, ".claude", "skills", name),
    stdin: JSON.stringify(input),
    testMode: false,
  });
  const log = writeLog(name, [
    `skill: ${name} ${entry.version}`,
    `network: ${entry.network}`,
    `input: ${JSON.stringify(input)}`,
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
  const [, , name, inputText] = process.argv;
  if (name === undefined || inputText === undefined) {
    process.stderr.write(
      "usage: node scripts/run-skill.ts <name> '<json input>'\n"
    );
    process.exitCode = 2;
    return;
  }
  try {
    process.exitCode = await run(name, inputText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
