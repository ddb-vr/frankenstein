// Integration test runner: executes a skill against every case in its
// `examples.json` inside the Docker sandbox and reports pass/fail.
//
// stdout: exactly one JSON summary line (exit 0 on PASS, 1 on FAIL).
// Full output: logs/<skill>/<timestamp>.log; one line per result: logs/<skill>/latest.log.

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type ExamplesFile,
  type MatchResult,
  matchExample,
  validateExamples,
} from "./lib/examples.ts";
import { runInSandbox, type SandboxResult, SKILL_MOUNT } from "./sandbox.ts";

export const MAX_REASON_LENGTH = 500;
const UNIT_TIMEOUT_MS = 120_000;
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const FAILED_TEST_LINE = /^\s*✖\s+(.*?)(?:\s+\(\d[\d.]*m?s\))?$/u;
const ISO_FRACTION = /\.\d+Z$/;

export type Stage = "validate" | "unit" | "examples" | "sandbox";

export type Summary =
  | {
      status: "PASS";
      unit: "pass" | "skipped";
      examples: { passed: number; total: number };
      log: string;
    }
  | {
      status: "FAIL";
      stage: Stage;
      example?: string;
      reason: string;
      log: string;
    };

export const truncateReason = (
  reason: string,
  max: number = MAX_REASON_LENGTH
): string => (reason.length <= max ? reason : `${reason.slice(0, max - 1)}…`);

/** Single JSON line; `reason` is always truncated. */
export const formatSummary = (summary: Summary): string =>
  JSON.stringify(
    summary.status === "FAIL"
      ? { ...summary, reason: truncateReason(summary.reason) }
      : summary
  );

/** `logs/x/2026-10-08T21-30-00.log` style, filesystem-safe on Windows. */
export const logTimestamp = (date: Date): string =>
  date.toISOString().replace(ISO_FRACTION, "").replaceAll(":", "-");

/** Names of failed tests from `node --test` spec reporter output. */
export const failedTestNames = (output: string): string[] => {
  const names = new Set<string>();
  for (const line of output.split("\n")) {
    const name = FAILED_TEST_LINE.exec(line)?.[1];
    if (name !== undefined && name !== "failing tests:") {
      names.add(name);
    }
  }
  return [...names];
};

interface Logger {
  /** Full log only. */
  detail: (text: string) => void;
  relativePath: string;
  /** Full log and one line in latest.log. */
  result: (line: string) => void;
}

const createLogger = (skillName: string): Logger => {
  const dir = path.join(REPO_ROOT, "logs", skillName);
  mkdirSync(dir, { recursive: true });
  const fullPath = path.join(dir, `${logTimestamp(new Date())}.log`);
  const latestPath = path.join(dir, "latest.log");
  writeFileSync(latestPath, "");
  const detail = (text: string): void => {
    appendFileSync(fullPath, text.endsWith("\n") ? text : `${text}\n`);
  };
  return {
    detail,
    relativePath: path.relative(REPO_ROOT, fullPath).replaceAll("\\", "/"),
    result: (line) => {
      detail(line);
      appendFileSync(latestPath, `${line}\n`);
    },
  };
};

const isFile = (filePath: string): boolean =>
  statSync(filePath, { throwIfNoEntry: false })?.isFile() ?? false;

const loadSkill = (
  skillDir: string
): { ok: true; value: ExamplesFile } | { ok: false; error: string } => {
  const examplesPath = path.join(skillDir, "examples.json");
  if (!isFile(path.join(skillDir, "SKILL.md"))) {
    return { error: "SKILL.md not found", ok: false };
  }
  if (!isFile(examplesPath)) {
    return { error: "examples.json not found", ok: false };
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(examplesPath, "utf8"));
  } catch (error) {
    return {
      error: `examples.json is not valid JSON: ${(error as Error).message}`,
      ok: false,
    };
  }
  const result = validateExamples(data);
  if (!result.ok) {
    return { error: `examples.json: ${result.error}`, ok: false };
  }
  if (!isFile(path.join(skillDir, result.value.entry))) {
    return { error: `entry ${result.value.entry} not found`, ok: false };
  }
  return result;
};

const sandboxSection = (title: string, result: SandboxResult): string =>
  [
    `--- ${title} (exit ${result.exitCode}, ${result.durationMs}ms${result.timedOut ? ", TIMED OUT" : ""})`,
    "stdout:",
    result.stdout,
    "stderr:",
    result.stderr,
  ].join("\n");

const runUnitTests = async (
  skillDir: string,
  log: Logger
): Promise<{ pass: boolean; reason: string }> => {
  log.detail("=== unit tests");
  const result = await runInSandbox({
    command: [
      "--test",
      "--test-reporter=spec",
      `${SKILL_MOUNT}/tests/**/*.test.ts`,
    ],
    skillDir,
    timeoutMs: UNIT_TIMEOUT_MS,
  });
  log.detail(sandboxSection("node --test", result));
  const pass = result.exitCode === 0 && !result.timedOut;
  log.result(`${pass ? "PASS" : "FAIL"} unit tests (${result.durationMs}ms)`);
  if (pass) {
    return { pass, reason: "" };
  }
  if (result.timedOut) {
    return { pass, reason: `unit tests timed out after ${UNIT_TIMEOUT_MS}ms` };
  }
  const failed = failedTestNames(`${result.stdout}\n${result.stderr}`);
  return {
    pass,
    reason:
      failed.length > 0
        ? `failed tests: ${failed.join("; ")}`
        : `node --test exited ${result.exitCode}: ${result.stderr.trim()}`,
  };
};

const run = async (skillDir: string, log: Logger): Promise<Summary> => {
  const loaded = loadSkill(skillDir);
  if (!loaded.ok) {
    log.result(`FAIL validate: ${loaded.error}`);
    return {
      log: log.relativePath,
      reason: loaded.error,
      stage: "validate",
      status: "FAIL",
    };
  }
  const { entry, examples } = loaded.value;
  log.result(`PASS validate (${examples.length} examples)`);

  let firstFailure: Summary | undefined;
  const fail = (stage: Stage, reason: string, example?: string): void => {
    firstFailure ??= {
      stage,
      status: "FAIL",
      ...(example === undefined ? {} : { example }),
      log: log.relativePath,
      reason,
    };
  };

  const hasTests = statSync(path.join(skillDir, "tests"), {
    throwIfNoEntry: false,
  })?.isDirectory();
  if (hasTests) {
    const unit = await runUnitTests(skillDir, log);
    if (!unit.pass) {
      fail("unit", unit.reason);
    }
  } else {
    log.result("SKIP unit tests (no tests/ directory)");
  }

  let passed = 0;
  for (const example of examples) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential keeps the live log ordered and bounds sandbox load.
    const result = await runInSandbox({
      command: [`${SKILL_MOUNT}/${entry}`],
      skillDir,
      stdin: JSON.stringify(example.input),
    });
    const match: MatchResult = result.timedOut
      ? { actual: result.stdout, pass: false, reason: "timed out" }
      : matchExample(example, result);
    log.detail(
      [
        `=== example: ${example.name}`,
        `match: ${example.match}`,
        `input: ${JSON.stringify(example.input)}`,
        `expected: ${JSON.stringify(example.expected)}`,
        `actual: ${JSON.stringify(match.actual)}`,
        sandboxSection("sandbox", result),
      ].join("\n")
    );
    log.result(
      `${match.pass ? "PASS" : "FAIL"} example "${example.name}" (${result.durationMs}ms)${match.pass ? "" : `: ${match.reason}`}`
    );
    if (match.pass) {
      passed += 1;
    } else {
      fail("examples", match.reason, example.name);
    }
  }

  return (
    firstFailure ?? {
      examples: { passed, total: examples.length },
      log: log.relativePath,
      status: "PASS",
      unit: hasTests ? "pass" : "skipped",
    }
  );
};

const main = async (): Promise<void> => {
  const [, , skillDir] = process.argv;
  if (skillDir === undefined) {
    process.stderr.write("usage: node scripts/run-examples.ts <skillDir>\n");
    process.exitCode = 2;
    return;
  }
  const resolvedDir = path.resolve(skillDir);
  const log = createLogger(path.basename(resolvedDir));
  log.detail(`skill: ${resolvedDir}\nstarted: ${new Date().toISOString()}`);
  let summary: Summary;
  try {
    summary = await run(resolvedDir, log);
  } catch (error) {
    const reason = (error as Error).message;
    log.result(`FAIL sandbox: ${reason}`);
    summary = {
      log: log.relativePath,
      reason,
      stage: "sandbox",
      status: "FAIL",
    };
  }
  process.stdout.write(`${formatSummary(summary)}\n`);
  process.exitCode = summary.status === "PASS" ? 0 : 1;
};

if (import.meta.main) {
  await main();
}
