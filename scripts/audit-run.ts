// Deterministic sandbox audit of one Claude Code session (no LLM involved).
//
//   node scripts/audit-run.ts [--session <id>]
//
// Reads the session's main and subagent transcripts, located through its
// budget state `work/.run/<id>.json` (default session: the one in
// `work/.run/current.json`), and cross-checks them with `logs/hooks.log` and
// the sandbox run logs `logs/<skill>/*.log` written during the session.
//
// stdout: one JSON line
//   { session, bashCommands, sandboxRuns, hostExecutions, denials, violations: [{ command, reason }] }
// - bashCommands: Bash/PowerShell tool calls, denied ones included.
// - sandboxRuns: `sandbox: container=…` records in the session's run logs.
// - hostExecutions: shell calls that ran (not denied) and executed code from
//   work/ or .claude/skills/ other than through `node scripts/run-examples.ts`
//   or `node scripts/run-skill.ts` from the repo root. Expected: 0.
// - denials: tool calls rejected by a hook, a permission rule or the user.
// - violations: every host execution, plus each disagreement between the
//   transcripts and the logs.
// Exit 1 when hostExecutions > 0; exit 2 with `{ error }` on stderr when the
// audit cannot run.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { currentSessionId, sessionTranscripts } from "./hooks/budget.ts";
import { commandNames, expand, isEntryPoint } from "./hooks/guard-bash.ts";
import {
  decisionSubject,
  isWithin,
  loggedSubject,
  REPO_ROOT,
  repoRelative,
  toPosixPath,
} from "./hooks/lib.ts";
import { parseCommand, type SimpleCommand, type Word } from "./hooks/shell.ts";
import { isPlainObject } from "./lib/examples.ts";

export interface Violation {
  command: string;
  reason: string;
}

export interface AuditReport {
  bashCommands: number;
  denials: number;
  hostExecutions: number;
  sandboxRuns: number;
  session: string;
  violations: Violation[];
}

const SHELL_TOOLS: Record<string, true> = { Bash: true, PowerShell: true };
const RUN_EXAMPLES = "scripts/run-examples.ts";
const RUN_SKILL = "scripts/run-skill.ts";
const SKILL_CODE_DIRS = ["work", ".claude/skills"];
const SKILL_CODE_REF = /(^|[\s/=:<>])(work|\.claude\/skills)(\/|$)/;
const CHANGE_DIR: Record<string, true> = {
  cd: true,
  chdir: true,
  pushd: true,
  "set-location": true,
  sl: true,
};
// Anything that runs code it is given: runtimes, package managers, shells,
// `source`, container CLIs.
const EXECUTOR =
  /^(node|nodejs|npx|npm|pnpm|pnpx|yarn|corepack|tsx|ts-node(-esm)?|deno|bun|bunx|python[\d.]*|py|pypy[\d.]*|perl|ruby|php|sh|bash|zsh|dash|ksh|fish|pwsh|powershell|source|\.|docker|podman)$/;
const WINDOWS_SUFFIX = /\.(exe|cmd|bat)$/;
const DYNAMIC_NAME = /[$`*?[{}%]/;
const TRAILING_SLASHES = /\/+$/;
const HOOK_DENIAL = /^(Error: )?PreToolUse:\S+ hook error:/;
const OTHER_DENIAL =
  /^(Error: )?(This command requires approval|Permission to use .* has been denied|The user doesn't want to proceed)/s;
const RUN_RECORD = /^sandbox: container=\S+ exit=/gm;
const EXAMPLES_LOG = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.log$/;
const SKILL_LOG =
  /^run-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(\.\d+)?Z\.log$/;
const LOG_LINK = /\(log: [^)]+\)/;
// Logs and hook decisions written up to this long before the first or after
// the last transcript line still belong to the session.
const WINDOW_SLACK_MS = 60_000;
const HOOK_LOG_FIELDS = 5;

const errorCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

// ---------------------------------------------------------------------------
// Transcripts

interface ToolCall {
  cwd: string;
  id: string;
  input: Record<string, unknown>;
  name: string;
}

interface ToolResult {
  /** `hook`: a PreToolUse hook; `other`: a permission rule or the user. */
  denial?: "hook" | "other";
  text: string;
}

export interface SessionTranscripts {
  /** By tool_use id, in transcript order. */
  calls: Map<string, ToolCall>;
  /** Latest transcript timestamp (ms); `-Infinity` without any. */
  end: number;
  results: Map<string, ToolResult>;
  /** Earliest transcript timestamp (ms); `Infinity` without any. */
  start: number;
}

const resultText = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) =>
      isPlainObject(block) && typeof block.text === "string" ? block.text : ""
    )
    .join("\n");
};

/**
 * `permissionDecision` on the result line (Claude Code 2.1.x) is
 * authoritative; older transcripts only have the error text.
 */
const denialOf = (
  text: string,
  isError: boolean,
  permission: unknown
): ToolResult["denial"] => {
  if (isPlainObject(permission)) {
    if (permission.decision !== "reject") {
      return;
    }
    return permission.source === "hook" ? "hook" : "other";
  }
  if (!isError) {
    return;
  }
  if (HOOK_DENIAL.test(text)) {
    return "hook";
  }
  return OTHER_DENIAL.test(text) ? "other" : undefined;
};

const addBlock = (
  transcripts: SessionTranscripts,
  entry: Record<string, unknown>,
  block: Record<string, unknown>
): void => {
  const { id, input, name, type } = block;
  if (
    type === "tool_use" &&
    typeof id === "string" &&
    typeof name === "string" &&
    isPlainObject(input) &&
    !transcripts.calls.has(id)
  ) {
    transcripts.calls.set(id, {
      cwd: typeof entry.cwd === "string" ? entry.cwd : "",
      id,
      input,
      name,
    });
  } else if (type === "tool_result" && typeof block.tool_use_id === "string") {
    const text = resultText(block.content);
    const denial = denialOf(
      text,
      block.is_error === true,
      entry.permissionDecision
    );
    transcripts.results.set(block.tool_use_id, {
      ...(denial ? { denial } : {}),
      text,
    });
  }
};

const addLine = (transcripts: SessionTranscripts, line: string): void => {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    // Blank or partially written line.
    return;
  }
  if (!isPlainObject(entry)) {
    return;
  }
  if (typeof entry.timestamp === "string") {
    const time = Date.parse(entry.timestamp);
    if (Number.isFinite(time)) {
      transcripts.start = Math.min(transcripts.start, time);
      transcripts.end = Math.max(transcripts.end, time);
    }
  }
  const content = isPlainObject(entry.message)
    ? entry.message.content
    : undefined;
  if (!Array.isArray(content)) {
    return;
  }
  for (const block of content) {
    if (isPlainObject(block)) {
      addBlock(transcripts, entry, block);
    }
  }
};

/** Tool calls and results of the given transcript files (first is main). */
export const readTranscripts = (
  files: readonly string[]
): SessionTranscripts => {
  const transcripts: SessionTranscripts = {
    calls: new Map(),
    end: Number.NEGATIVE_INFINITY,
    results: new Map(),
    start: Number.POSITIVE_INFINITY,
  };
  for (const [index, file] of files.entries()) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT" && index > 0) {
        continue;
      }
      throw new Error(`cannot read transcript ${file}`, { cause: error });
    }
    for (const line of text.split("\n")) {
      addLine(transcripts, line);
    }
  }
  return transcripts;
};

// ---------------------------------------------------------------------------
// Shell command classification

export interface ShellAnalysis {
  /** Why the command executed skill code on the host, if it did. */
  hostExecution?: string;
  /** Sandbox runner calls trusted as such (`node scripts/run-….ts …`). */
  runners: SimpleCommand[];
}

/** `cwd`-relative path inside work/ or .claude/skills/. */
const inSkillCodeDir = (target: string, root: string, cwd: string): boolean => {
  const relative = repoRelative(target, root, cwd);
  return (
    relative !== undefined &&
    SKILL_CODE_DIRS.some((dir) => isWithin(relative, dir))
  );
};

/** The first name in `commands` that runs code, if any. */
const executorName = (
  commands: readonly SimpleCommand[],
  inSkillDir: boolean,
  refersToSkillCode: (word: Word) => boolean
): string | undefined => {
  for (const { words } of commands) {
    for (const { name, placeholder } of commandNames(words)) {
      if (name === undefined) {
        continue;
      }
      const value = toPosixPath(name.value);
      const base = path.posix
        .basename(value.toLowerCase())
        .replace(WINDOWS_SUFFIX, "");
      const unverifiable =
        DYNAMIC_NAME.test(value) ||
        (placeholder !== undefined &&
          placeholder !== "" &&
          value.includes(placeholder));
      const runsPath =
        value.includes("/") && (inSkillDir || refersToSkillCode(name));
      if (EXECUTOR.test(base) || unverifiable || runsPath) {
        return name.value;
      }
    }
  }
};

/**
 * Classifies one shell command line as it ran in `cwd`. Allowed entry points
 * (exact, from the repo root, no substitution or directory change) never
 * run skill code on the host: the two sandbox runners execute it only in
 * Docker and the other scripts do not execute it. Any other command that
 * runs an executor (runtime, package manager, shell, container CLI, a path
 * or an unverifiable name) while the line references skill code or runs
 * inside a skill directory is a host execution.
 */
export const analyzeShellCommand = (
  command: string,
  cwd: string,
  root: string
): ShellAnalysis => {
  const parsed = parseCommand(command);
  const changesDir = parsed.commands.some(
    ({ words }) => CHANGE_DIR[words[0]?.value.toLowerCase() ?? ""] === true
  );
  const entriesTrusted =
    repoRelative(cwd, root) === "" && !(parsed.substitution || changesDir);
  const runners: SimpleCommand[] = [];
  const untrusted: SimpleCommand[] = [];
  for (const simple of parsed.commands) {
    const values = simple.words.map((word) => word.value);
    if (!(entriesTrusted && isEntryPoint(values))) {
      untrusted.push(simple);
    } else if (values[1] === RUN_EXAMPLES || values[1] === RUN_SKILL) {
      runners.push(simple);
    }
  }

  const rootPrefix = `${toPosixPath(root).toLowerCase().replace(TRAILING_SLASHES, "")}/`;
  const refersToSkillCode = (word: Word): boolean =>
    [word.value, word.raw].some((text) =>
      SKILL_CODE_REF.test(
        toPosixPath(text).toLowerCase().replaceAll(rootPrefix, "")
      )
    );
  const { commands, tooDeep } = expand(untrusted);
  const inSkillDir =
    inSkillCodeDir(cwd, root, root) ||
    commands.some(({ words }) => {
      const target = words.slice(1).find((word) => !word.value.startsWith("-"));
      return (
        CHANGE_DIR[words[0]?.value.toLowerCase() ?? ""] === true &&
        target !== undefined &&
        inSkillCodeDir(target.value, root, cwd)
      );
    });
  const referencesSkillCode =
    inSkillDir ||
    commands.some(
      ({ words, redirects }) =>
        words.some(refersToSkillCode) || redirects.some(refersToSkillCode)
    );
  if (!referencesSkillCode) {
    return { runners };
  }
  const where = inSkillDir
    ? "inside work/ or .claude/skills/"
    : "on code from work/ or .claude/skills/";
  if (tooDeep) {
    return {
      hostExecution: `host execution: command nested too deeply to verify, ${where}`,
      runners,
    };
  }
  const executor = executorName(commands, inSkillDir, refersToSkillCode);
  return executor === undefined
    ? { runners }
    : {
        hostExecution: `host execution: \`${executor}\` ran ${where} outside ${RUN_EXAMPLES} and ${RUN_SKILL}`,
        runners,
      };
};

// ---------------------------------------------------------------------------
// Logs

interface HookLogLine {
  decision: string;
  hook: string;
  subject: string;
}

/** Decisions logged within `[from, to]`; `undefined` when there is no log. */
const readHookLog = (
  root: string,
  from: number,
  to: number
): HookLogLine[] | undefined => {
  let text: string;
  try {
    text = readFileSync(path.join(root, "logs", "hooks.log"), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  const lines: HookLogLine[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split("\t");
    if (fields.length !== HOOK_LOG_FIELDS) {
      continue;
    }
    const [time = "", hook = "", decision = "", , subject = ""] = fields;
    const at = Date.parse(time);
    if (at >= from && at <= to) {
      lines.push({ decision, hook, subject });
    }
  }
  return lines;
};

interface RunLog {
  kind: "examples" | "skill";
  records: number;
  /** Repo-relative POSIX path, as the runners report it. */
  relative: string;
  skill: string;
}

/** Start time encoded in a run log name (UTC). */
const logStart = (
  name: string
): { kind: RunLog["kind"]; time: number } | undefined => {
  const examples = EXAMPLES_LOG.exec(name);
  if (examples) {
    const [, day, hour, minute, second] = examples;
    return {
      kind: "examples",
      time: Date.parse(`${day}T${hour}:${minute}:${second}Z`),
    };
  }
  const skill = SKILL_LOG.exec(name);
  if (skill) {
    const [, day, hour, minute, second, fraction = ""] = skill;
    return {
      kind: "skill",
      time: Date.parse(`${day}T${hour}:${minute}:${second}${fraction}Z`),
    };
  }
};

/** Sandbox run logs (`logs/<skill>/…`) started within `[from, to]`. */
const readRunLogs = (root: string, from: number, to: number): RunLog[] => {
  const logsDir = path.join(root, "logs");
  let skills: string[];
  try {
    skills = readdirSync(logsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const logs: RunLog[] = [];
  for (const skill of skills.sort()) {
    for (const name of readdirSync(path.join(logsDir, skill)).sort()) {
      const start = logStart(name);
      if (start === undefined || start.time < from || start.time > to) {
        continue;
      }
      const text = readFileSync(path.join(logsDir, skill, name), "utf8");
      logs.push({
        kind: start.kind,
        records: text.match(RUN_RECORD)?.length ?? 0,
        relative: `logs/${skill}/${name}`,
        skill,
      });
    }
  }
  return logs;
};

/** JSON objects printed one per line in a tool result. */
const jsonLines = (text: string): Record<string, unknown>[] =>
  text.split("\n").flatMap((line) => {
    if (!line.startsWith("{")) {
      return [];
    }
    try {
      const value: unknown = JSON.parse(line);
      return isPlainObject(value) ? [value] : [];
    } catch {
      return [];
    }
  });

// ---------------------------------------------------------------------------
// Cross-checks

interface AuditedCall {
  call: ToolCall;
  result?: ToolResult;
}

interface RunnerCall {
  command: string;
  result?: ToolResult;
  runners: SimpleCommand[];
}

/** Multiset of strings; `take` removes one occurrence if there is one. */
class Tally {
  readonly #counts = new Map<string, number>();

  add(key: string): void {
    this.#counts.set(key, this.count(key) + 1);
  }

  count(key: string): number {
    return this.#counts.get(key) ?? 0;
  }

  take(key: string): boolean {
    const count = this.count(key);
    if (count > 0) {
      this.#counts.set(key, count - 1);
    }
    return count > 0;
  }
}

const tallyHookLog = (hookLog: readonly HookLogLine[]) => {
  const tallies = {
    denies: new Tally(),
    guardAllows: new Tally(),
    guardDenies: new Tally(),
  };
  for (const { decision, hook, subject } of hookLog) {
    if (decision === "deny") {
      tallies.denies.add(subject);
    }
    if (hook === "guard-bash") {
      (decision === "allow" ? tallies.guardAllows : tallies.guardDenies).add(
        subject
      );
    }
  }
  return tallies;
};

/** Checks that every hook decision in the transcripts is in hooks.log. */
const crossCheckHookLog = (
  calls: readonly AuditedCall[],
  hookLog: readonly HookLogLine[] | undefined,
  violations: Violation[]
): void => {
  const checked = calls.filter(
    ({ call, result }) =>
      SHELL_TOOLS[call.name] === true || result?.denial === "hook"
  );
  if (checked.length === 0) {
    return;
  }
  if (hookLog === undefined || hookLog.length === 0) {
    violations.push({
      command: "logs/hooks.log",
      reason:
        "no hook decisions logged during the session; tool calls cannot be cross-checked",
    });
    return;
  }
  const { denies, guardAllows, guardDenies } = tallyHookLog(hookLog);
  for (const { call, result } of checked) {
    const subject = decisionSubject(call.name, call.input);
    const logged = loggedSubject(subject);
    if (result?.denial === "hook") {
      if (!denies.take(logged)) {
        violations.push({
          command: subject,
          reason: "hook denial missing from logs/hooks.log",
        });
      }
    } else if (result?.denial === undefined && !guardAllows.take(logged)) {
      violations.push({
        command: subject,
        reason:
          guardDenies.count(logged) > 0
            ? "logs/hooks.log has a guard-bash deny for it, yet the transcript shows it ran"
            : "no guard-bash allow for it in logs/hooks.log",
      });
    }
  }
};

/** `run-examples` summaries must name a session log holding their runs. */
const checkExamplesSummaries = (
  { command, result }: RunnerCall,
  runLogs: readonly RunLog[],
  violations: Violation[]
): void => {
  for (const summary of jsonLines(result?.text ?? "")) {
    if (typeof summary.log !== "string") {
      continue;
    }
    const log = runLogs.find((entry) => entry.relative === summary.log);
    const total = isPlainObject(summary.examples)
      ? summary.examples.total
      : undefined;
    const expected =
      summary.status === "PASS" && typeof total === "number" ? total : 0;
    if (log === undefined) {
      violations.push({
        command,
        reason: `run log ${summary.log} not found among the session's logs`,
      });
    } else if (log.records < expected) {
      violations.push({
        command,
        reason: `${summary.log} has ${log.records} sandbox run records for ${expected} passed examples`,
      });
    }
  }
};

/** Checks runner calls against the run logs they must have written. */
const crossCheckRunLogs = (
  runnerCalls: readonly RunnerCall[],
  runLogs: readonly RunLog[],
  violations: Violation[]
): void => {
  const skillLogs = new Tally();
  for (const log of runLogs.filter(({ kind }) => kind === "skill")) {
    skillLogs.add(log.skill);
    if (log.records === 0) {
      violations.push({
        command: log.relative,
        reason: "run-skill log without a sandbox run record",
      });
    }
  }
  for (const runnerCall of runnerCalls) {
    const { command, result, runners } = runnerCall;
    // run-skill writes no log when it rejects the call before the sandbox.
    const rejectedEarly = jsonLines(result?.text ?? "").some(
      ({ error }) => typeof error === "string" && !LOG_LINK.test(error)
    );
    for (const { words } of runners) {
      const skill = words[2]?.value ?? "";
      if (
        words[1]?.value === RUN_SKILL &&
        result !== undefined &&
        !rejectedEarly &&
        !skillLogs.take(skill)
      ) {
        violations.push({
          command,
          reason: `no sandbox run log logs/${skill}/run-*.log for this run-skill call`,
        });
      }
    }
    if (runners.some(({ words }) => words[1]?.value === RUN_EXAMPLES)) {
      checkExamplesSummaries(runnerCall, runLogs, violations);
    }
  }
};

// ---------------------------------------------------------------------------
// Audit

export const auditRun = (
  sessionId: string,
  root: string = REPO_ROOT
): AuditReport => {
  const transcripts = readTranscripts(sessionTranscripts(sessionId, root));
  const from = transcripts.start - WINDOW_SLACK_MS;
  const to = transcripts.end + WINDOW_SLACK_MS;
  const calls: AuditedCall[] = [...transcripts.calls.values()].map((call) => {
    const result = transcripts.results.get(call.id);
    return result ? { call, result } : { call };
  });

  const violations: Violation[] = [];
  const runnerCalls: RunnerCall[] = [];
  let bashCommands = 0;
  let hostExecutions = 0;
  for (const { call, result } of calls) {
    const { command } = call.input;
    if (SHELL_TOOLS[call.name] !== true || typeof command !== "string") {
      continue;
    }
    bashCommands += 1;
    if (result?.denial !== undefined) {
      continue;
    }
    const analysis = analyzeShellCommand(command, call.cwd || root, root);
    if (analysis.hostExecution !== undefined) {
      hostExecutions += 1;
      violations.push({
        command,
        reason: result
          ? analysis.hostExecution
          : `${analysis.hostExecution} (no tool result recorded)`,
      });
    }
    if (analysis.runners.length > 0) {
      runnerCalls.push({
        command,
        ...(result ? { result } : {}),
        runners: analysis.runners,
      });
    }
  }

  crossCheckHookLog(calls, readHookLog(root, from, to), violations);
  const runLogs = readRunLogs(root, from, to);
  crossCheckRunLogs(runnerCalls, runLogs, violations);

  // biome-ignore assist/source/useSortedKeys: documented output field order.
  return {
    session: sessionId,
    bashCommands,
    sandboxRuns: runLogs.reduce((sum, log) => sum + log.records, 0),
    hostExecutions,
    denials: calls.filter(({ result }) => result?.denial !== undefined).length,
    violations,
  };
};

const main = (): void => {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { session: { type: "string" } },
      strict: true,
    });
    const report = auditRun(values.session ?? currentSessionId(REPO_ROOT));
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.hostExecutions > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 2;
  }
};

if (import.meta.main) {
  main();
}
