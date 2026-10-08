// PreToolUse hook (matcher `*`, runs on every tool call so it stays sync and
// incremental): caps skill-builder invocations (`MAX_BUILDER_ITERATIONS`) and
// USD spend (`BUDGET_USD_PER_RUN`) per Claude Code session.
//
// State: `work/.run/<session_id>.json` with the builder invocation count, the
// byte offset read so far per transcript file and the usage per model. Each
// call reads only the new complete lines of the main transcript and of the
// session's subagent transcripts.

import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { loadDotEnv } from "../lib/env.ts";
import { isPlainObject } from "../lib/examples.ts";
import {
  computeCost,
  LONG_PROMPT_TOKENS,
  type TokenCounts,
  type UsageEntry,
} from "../lib/pricing.ts";
import { type Decision, type HookInput, REPO_ROOT, runHook } from "./lib.ts";
import { parseCommand } from "./shell.ts";

export interface Limits {
  budgetUsd: number;
  maxBuilderIterations: number;
}

interface FileCursor {
  /** Last assistant message counted; Claude Code writes one line per content block. */
  lastMessageId?: string;
  lastUsage?: UsageEntry;
  offset: number;
}

export interface RunState {
  builderInvocations: number;
  files: Record<string, FileCursor>;
  sessionId: string;
  transcriptPath: string;
  /** Keyed by model, plus a separate long-prompt entry for tiered models. */
  usage: Record<string, UsageEntry>;
}

const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
const BUILDER_AGENT = "skill-builder";
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const NEWLINE = 0x0a;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 20;
const STALE_LOCK_MS = 30_000;
const USD_DECIMALS = 4;
const TOKEN_KEYS = ["input", "cacheWrite", "cacheRead", "output"] as const;

const errorCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;
const statePath = (root: string, sessionId: string): string => {
  if (!SESSION_ID.test(sessionId)) {
    throw new Error(`unexpected session id "${sessionId}"`);
  }
  return path.join(root, "work", ".run", `${sessionId}.json`);
};

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Serializes concurrent hook processes (parallel tool calls) per session. */
const withLock = <T>(file: string, action: () => T): T => {
  const lockDir = `${file}.lock`;
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let locked = false;
  while (!locked) {
    try {
      mkdirSync(lockDir);
      locked = true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      const lockedAt = statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs;
      if (lockedAt !== undefined && Date.now() - lockedAt > STALE_LOCK_MS) {
        rmSync(lockDir, { force: true, recursive: true });
      } else if (Date.now() > deadline) {
        throw new Error(`budget state ${path.basename(file)} stays locked`, {
          cause: error,
        });
      } else {
        sleep(LOCK_RETRY_MS);
      }
    }
  }
  try {
    return action();
  } finally {
    rmSync(lockDir, { force: true, recursive: true });
  }
};

const loadState = (
  file: string,
  sessionId: string,
  transcriptPath: string
): RunState => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return {
        builderInvocations: 0,
        files: {},
        sessionId,
        transcriptPath,
        usage: {},
      };
    }
    throw error;
  }
  // Written only by this module.
  return JSON.parse(text) as RunState;
};

const saveState = (file: string, state: RunState): void => {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`);
  renameSync(temporary, file);
};

// ---------------------------------------------------------------------------
// Transcripts

/** Complete lines appended since `offset`, and the offset after them. */
export const readNewLines = (
  file: string,
  offset: number
): { lines: string[]; offset: number } => {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { lines: [], offset };
    }
    throw error;
  }
  try {
    const { size } = fstatSync(fd);
    if (size <= offset) {
      return { lines: [], offset: Math.min(offset, size) };
    }
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    // A trailing partial line is still being written; read it next time.
    const end = buffer.lastIndexOf(NEWLINE);
    if (end === -1) {
      return { lines: [], offset };
    }
    return {
      lines: buffer.subarray(0, end).toString("utf8").split("\n"),
      offset: offset + end + 1,
    };
  } finally {
    closeSync(fd);
  }
};

const tokenCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** Usage of one assistant transcript line, with its message id. */
export const parseUsageLine = (
  line: string
): { id?: string; usage: UsageEntry } | undefined => {
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (
    !isPlainObject(entry) ||
    entry.type !== "assistant" ||
    !isPlainObject(entry.message)
  ) {
    return;
  }
  const { id, model, usage } = entry.message;
  if (typeof model !== "string" || !isPlainObject(usage)) {
    return;
  }
  const counts: TokenCounts = {
    cacheRead: tokenCount(usage.cache_read_input_tokens),
    cacheWrite: tokenCount(usage.cache_creation_input_tokens),
    input: tokenCount(usage.input_tokens),
    output: tokenCount(usage.output_tokens),
  };
  // Synthetic messages (`<synthetic>` model) carry no tokens.
  if (TOKEN_KEYS.every((key) => counts[key] === 0)) {
    return;
  }
  const prompt = counts.input + counts.cacheWrite + counts.cacheRead;
  return {
    ...(typeof id === "string" ? { id } : {}),
    usage: {
      ...counts,
      model,
      ...(prompt > LONG_PROMPT_TOKENS ? { longPrompt: true } : {}),
    },
  };
};

const addUsage = (state: RunState, usage: UsageEntry, sign: 1 | -1): void => {
  const key = usage.longPrompt ? `${usage.model} (long prompt)` : usage.model;
  const total = state.usage[key] ?? {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    model: usage.model,
    output: 0,
    ...(usage.longPrompt ? { longPrompt: true } : {}),
  };
  for (const tokenKey of TOKEN_KEYS) {
    total[tokenKey] += sign * usage[tokenKey];
  }
  state.usage[key] = total;
};

const transcriptFiles = (state: RunState): string[] => {
  const subagentDir = path.join(
    path.dirname(state.transcriptPath),
    state.sessionId,
    "subagents"
  );
  let names: string[] = [];
  try {
    names = readdirSync(subagentDir);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  return [
    state.transcriptPath,
    ...names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => path.join(subagentDir, name)),
  ];
};

/** Adds usage from transcript lines appended since the last sync. */
export const syncUsage = (state: RunState): void => {
  for (const file of transcriptFiles(state)) {
    const cursor = state.files[file] ?? { offset: 0 };
    const { lines, offset } = readNewLines(file, cursor.offset);
    for (const line of lines) {
      const parsed = parseUsageLine(line);
      if (parsed === undefined) {
        continue;
      }
      // Repeated lines of one message carry its (possibly updated) usage.
      if (
        parsed.id !== undefined &&
        parsed.id === cursor.lastMessageId &&
        cursor.lastUsage
      ) {
        addUsage(state, cursor.lastUsage, -1);
      }
      addUsage(state, parsed.usage, 1);
      cursor.lastMessageId = parsed.id;
      cursor.lastUsage = parsed.usage;
    }
    cursor.offset = offset;
    state.files[file] = cursor;
  }
};

// ---------------------------------------------------------------------------
// Decision

/** `node scripts/tracker.ts …` as one plain command, the only call allowed over budget. */
const isTrackerCall = (input: HookInput): boolean => {
  const { command } = input.tool_input;
  if (!SHELL_TOOLS.has(input.tool_name) || typeof command !== "string") {
    return false;
  }
  const { commands, substitution } = parseCommand(command);
  const [only] = commands;
  return (
    !substitution &&
    commands.length === 1 &&
    only?.redirects.length === 0 &&
    only.words[0]?.value === "node" &&
    only.words[1]?.value === "scripts/tracker.ts"
  );
};

export const checkBudget = (
  input: HookInput,
  root: string,
  limits: Limits
): Decision => {
  const file = statePath(root, input.session_id);
  return withLock(file, () => {
    const state = loadState(file, input.session_id, input.transcript_path);
    syncUsage(state);
    let reason: Decision;
    const spentUsd = computeCost(Object.values(state.usage)).totalUsd;
    const isBuilderCall =
      SUBAGENT_TOOLS.has(input.tool_name) &&
      input.tool_input.subagent_type === BUILDER_AGENT;
    if (spentUsd >= limits.budgetUsd && !isTrackerCall(input)) {
      reason = `Blocked: run budget exhausted ($${spentUsd.toFixed(USD_DECIMALS)} of $${limits.budgetUsd} spent). Stop working; only \`node scripts/tracker.ts blocked --issue <n> --reason "budget exhausted"\` may run now.`;
    } else if (
      isBuilderCall &&
      state.builderInvocations >= limits.maxBuilderIterations
    ) {
      reason = `Blocked: skill-builder cap reached (${state.builderInvocations}/${limits.maxBuilderIterations} iterations). Do not invoke it again; mark the issue blocked with \`node scripts/tracker.ts blocked --issue <n> --reason "builder iteration cap reached"\`.`;
    } else if (isBuilderCall) {
      state.builderInvocations += 1;
    }
    saveState(file, state);
    return reason;
  });
};

/** Usage of a session so far (synced from its transcripts), for cost reports. */
export const getRunUsage = (
  sessionId: string,
  root: string = REPO_ROOT
): UsageEntry[] => {
  const file = statePath(root, sessionId);
  return withLock(file, () => {
    const state = loadState(file, sessionId, "");
    if (state.transcriptPath === "") {
      throw new Error(`no budget state for session ${sessionId}`);
    }
    syncUsage(state);
    saveState(file, state);
    return Object.values(state.usage);
  });
};

const positiveNumber = (name: string): number => {
  const value = Number(process.env[name]);
  if (!(Number.isFinite(value) && value > 0)) {
    throw new Error(`${name} must be a positive number in .env`);
  }
  return value;
};

if (import.meta.main) {
  runHook((input) => {
    loadDotEnv();
    return checkBudget(input, REPO_ROOT, {
      budgetUsd: positiveNumber("BUDGET_USD_PER_RUN"),
      maxBuilderIterations: positiveNumber("MAX_BUILDER_ITERATIONS"),
    });
  });
}
