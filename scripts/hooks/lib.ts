// Shared helpers for the Claude Code PreToolUse hooks in this directory.
//
// Hook API, verified 2026-10-08 against https://code.claude.com/docs/en/hooks
// (Claude Code 2.1.295):
// - Input: one JSON object on stdin with `session_id`, `transcript_path`,
//   `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`; inside
//   a subagent also `agent_id` and `agent_type`. File tools (`Write`, `Edit`,
//   `Read`) get an absolute `tool_input.file_path`, with backslashes on Windows.
// - Deny: exit 2 with the reason on stderr, or exit 0 with stdout JSON
//   `{ hookSpecificOutput: { hookEventName: "PreToolUse",
//   permissionDecision: "deny", permissionDecisionReason } }`. Any other
//   non-zero exit is a non-blocking error and the tool still runs, so `deny`
//   prints the JSON, the reason on stderr and exits 2.
// - Allow (no opinion): exit 0 without output; normal permissions still apply.
// - Subagent tool: `Agent` (formerly `Task`; match both), with
//   `tool_input.subagent_type` naming the agent.
// - Transcripts: `transcript_path` is the main session JSONL, also when the
//   hook fires inside a subagent. Subagent transcripts are stored at
//   `<dirname(transcript_path)>/<session_id>/subagents/agent-<agent_id>.jsonl`.
// - Shell commands: `Bash`, and `PowerShell` on Windows (match both).
// - Command hooks in exec form (`command` + `args`) spawn without a shell, so
//   `node ${CLAUDE_PROJECT_DIR}/scripts/hooks/<file>.ts` works on every OS.
//   Hooks fire the same in the CLI, IDE extensions and the Desktop app.
// - SubagentStop (`capture-review.ts`): matcher is the agent type; input adds
//   `agent_type`, `last_assistant_message` (the subagent's final text) and
//   `stop_hook_active`. Stdout JSON `{ decision: "block", reason }` keeps the
//   subagent running with `reason` as its next instruction; `systemMessage`
//   is shown to the user. In auto mode (v2.1.271+) a subagent delivers its
//   report via the `SubagentHandback` tool (`tool_input.message`) instead,
//   and `last_assistant_message` is only its closing text.

import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { isPlainObject } from "../lib/examples.ts";

/** Repository guarded by these hooks (the one this file lives in). */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Overrides `logs/hooks.log` (tests point it at a temp file). */
export const HOOK_LOG_ENV = "FRANKENSTEIN_HOOK_LOG";

const DENY_EXIT_CODE = 2;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\//;
const TRAILING_SLASHES = /\/+$/;
const MAX_LOGGED_SUBJECT = 200;
const MAX_LOGGED_REASON = 160;
const BLOCKED_PREFIX = /^Blocked:\s*/;
const FIRST_SENTENCE = /^.*?\.(?=\s|$)/s;
const LOG_CONTROL_CHARS = /[\t\r\n]/g;
const LOG_ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

export interface HookInput {
  agent_id?: string;
  agent_type?: string;
  cwd: string;
  session_id: string;
  tool_input: Record<string, unknown>;
  tool_name: string;
  transcript_path: string;
}

/** A deny reason, or `undefined` to allow. */
export type Decision = string | undefined;

export const parseHookInput = (text: string): HookInput => {
  const data: unknown = JSON.parse(text);
  if (!isPlainObject(data)) {
    throw new Error("hook input is not a JSON object");
  }
  const required = (key: string): string => {
    const value = data[key];
    if (typeof value !== "string") {
      throw new Error(`hook input is missing "${key}"`);
    }
    return value;
  };
  const toolInput = data.tool_input;
  if (!isPlainObject(toolInput)) {
    throw new Error('hook input is missing "tool_input"');
  }
  const { agent_id: agentId, agent_type: agentType } = data;
  return {
    ...(typeof agentId === "string" ? { agent_id: agentId } : {}),
    ...(typeof agentType === "string" ? { agent_type: agentType } : {}),
    cwd: required("cwd"),
    session_id: required("session_id"),
    tool_input: toolInput,
    tool_name: required("tool_name"),
    transcript_path: required("transcript_path"),
  };
};

export const readHookInput = (): HookInput =>
  parseHookInput(readFileSync(0, "utf8"));

/** Blocks the tool call; `reason` is shown to Claude. */
export const deny = (reason: string): never => {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
  // Sync writes: stdout/stderr pipes are async on macOS and process.exit
  // would drop pending output.
  writeSync(1, `${JSON.stringify(output)}\n`);
  writeSync(2, `${reason}\n`);
  process.exit(DENY_EXIT_CODE);
};

/** No opinion: the normal permission flow applies. */
export const allow = (): never => process.exit(0);

// ---------------------------------------------------------------------------
// Decision log: one line per hook decision in logs/hooks.log.

export interface LogEntry {
  decision: "allow" | "block" | "deny";
  hook: string;
  /** Full reason; shortened to its first sentence when logged. */
  reason: string;
  /** Shell command, file path or tool name the decision is about. */
  subject: string;
}

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** `reason` without the `Blocked: ` prefix, cut after its first sentence. */
export const shortReason = (reason: string): string => {
  const text = reason.replace(BLOCKED_PREFIX, "");
  return truncate(FIRST_SENTENCE.exec(text)?.[0] ?? text, MAX_LOGGED_REASON);
};

/** What a tool call is about: its command, else tool name and file path. */
export const decisionSubject = (
  toolName: string,
  toolInput: Record<string, unknown>
): string => {
  const { command, file_path: filePath } = toolInput;
  if (typeof command === "string") {
    return command;
  }
  return typeof filePath === "string" ? `${toolName} ${filePath}` : toolName;
};

const escapeLogField = (field: string): string =>
  field.replace(LOG_CONTROL_CHARS, (char) => LOG_ESCAPES[char] ?? char);

/** Tab-separated: time, hook, decision, short reason, subject (≤200 chars). */
export const formatLogLine = (entry: LogEntry, time: Date): string =>
  [
    time.toISOString(),
    entry.hook,
    entry.decision,
    shortReason(entry.reason),
    truncate(entry.subject, MAX_LOGGED_SUBJECT),
  ]
    .map(escapeLogField)
    .join("\t");

/** The subject field `formatLogLine` writes for `subject`. */
export const loggedSubject = (subject: string): string =>
  escapeLogField(truncate(subject, MAX_LOGGED_SUBJECT));

/** Appends one decision line; a broken log never changes the decision. */
export const logDecision = (entry: LogEntry): void => {
  const file =
    process.env[HOOK_LOG_ENV] || path.join(REPO_ROOT, "logs", "hooks.log");
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${formatLogLine(entry, new Date())}\n`);
  } catch (error) {
    writeSync(
      2,
      `${entry.hook}: cannot write ${file}: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
};

/**
 * Runs a hook: reads stdin, applies `decide`, logs and emits the decision.
 * Any error denies the call (fail closed) instead of letting the tool run
 * unchecked.
 */
export const runHook = (decide: (input: HookInput) => Decision): void => {
  const script = process.argv[1] ?? "hook";
  const name = path.basename(script);
  let subject = "(unreadable hook input)";
  const finish = (reason: Decision): never => {
    logDecision({
      decision: reason === undefined ? "allow" : "deny",
      hook: path.basename(script, path.extname(script)),
      reason: reason ?? "no objection",
      subject,
    });
    return reason === undefined ? allow() : deny(reason);
  };
  const failClosed = (error: unknown): never =>
    finish(
      `Blocked: hook ${name} failed (${error instanceof Error ? error.message : String(error)}). Do not work around it; report this to the user.`
    );
  process.on("uncaughtException", failClosed);
  let decision: Decision;
  try {
    const input = readHookInput();
    subject = decisionSubject(input.tool_name, input.tool_input);
    decision = decide(input);
  } catch (error) {
    failClosed(error);
  }
  finish(decision);
};

// ---------------------------------------------------------------------------
// Paths

/** Backslashes to forward slashes (Windows paths arrive with backslashes). */
export const toPosixPath = (value: string): string =>
  value.replaceAll("\\", "/");

/**
 * Repo-relative POSIX path of `filePath`, lower-cased (macOS and Windows file
 * systems are case-insensitive); `""` for the root itself and `undefined`
 * when the path is outside the repo. Relative paths resolve against `cwd`.
 */
export const repoRelative = (
  filePath: string,
  root: string,
  cwd: string = root
): string | undefined => {
  const file = toPosixPath(filePath);
  const absolute =
    file.startsWith("/") || WINDOWS_DRIVE_PATH.test(file)
      ? file
      : `${toPosixPath(cwd)}/${file}`;
  // Case-folded: macOS and Windows file systems are case-insensitive.
  const fold = (value: string): string =>
    path.posix.normalize(value).replace(TRAILING_SLASHES, "").toLowerCase();
  const normalizedFile = fold(absolute);
  const normalizedRoot = fold(toPosixPath(root));
  if (normalizedFile === normalizedRoot) {
    return "";
  }
  return normalizedFile.startsWith(`${normalizedRoot}/`)
    ? normalizedFile.slice(normalizedRoot.length + 1)
    : undefined;
};

/** `relativePath` is `entry` itself or below it (both repo-relative). */
export const isWithin = (relativePath: string, entry: string): boolean =>
  relativePath === entry || relativePath.startsWith(`${entry}/`);

// Symlink hops followed before giving up (the Linux limit).
const MAX_SYMLINK_HOPS = 40;

/**
 * `absolutePath` with every symlink resolved, also when its tail does not
 * exist yet: the nearest existing ancestor is resolved and the rest
 * appended; a dangling symlink resolves to its target (a write creates it).
 */
export const resolveSymlinks = (absolutePath: string, hops = 0): string => {
  try {
    return realpathSync.native(absolutePath);
  } catch {
    // Missing, dangling or unreadable: resolve what exists below.
  }
  try {
    if (lstatSync(absolutePath).isSymbolicLink() && hops < MAX_SYMLINK_HOPS) {
      const target = path.resolve(
        path.dirname(absolutePath),
        readlinkSync(absolutePath)
      );
      return resolveSymlinks(target, hops + 1);
    }
  } catch {
    // Does not exist: resolve the parent.
  }
  const parent = path.dirname(absolutePath);
  return parent === absolutePath
    ? absolutePath
    : path.join(resolveSymlinks(parent, hops), path.basename(absolutePath));
};
