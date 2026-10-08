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

import { readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { isPlainObject } from "../lib/examples.ts";

/** Repository guarded by these hooks (the one this file lives in). */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const DENY_EXIT_CODE = 2;
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:\//;
const TRAILING_SLASHES = /\/+$/;

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

/**
 * Runs a hook: reads stdin, applies `decide`, emits the decision. Any error
 * denies the call (fail closed) instead of letting the tool run unchecked.
 */
export const runHook = (decide: (input: HookInput) => Decision): void => {
  const name = path.basename(process.argv[1] ?? "hook");
  const failClosed = (error: unknown): never =>
    deny(
      `Blocked: hook ${name} failed (${error instanceof Error ? error.message : String(error)}). Do not work around it; report this to the user.`
    );
  process.on("uncaughtException", failClosed);
  let reason: Decision;
  try {
    reason = decide(readHookInput());
  } catch (error) {
    failClosed(error);
  }
  if (reason === undefined) {
    allow();
  }
  deny(reason ?? "");
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
