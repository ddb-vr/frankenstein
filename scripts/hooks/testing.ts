// Test helpers: recorded-shape PreToolUse inputs and hook process runs.

import { execFile } from "node:child_process";
import path from "node:path";
import { type HookInput, parseHookInput, REPO_ROOT } from "./lib.ts";

/** Raw PreToolUse stdin payload, shaped like Claude Code 2.1.x sends it. */
export const recordedInput = (
  toolName: string,
  toolInput: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  cwd: REPO_ROOT,
  hook_event_name: "PreToolUse",
  permission_mode: "default",
  session_id: "6f1c2a7e-0b8d-4d6b-9a51-2f4e8c1d3b90",
  tool_input: toolInput,
  tool_name: toolName,
  tool_use_id: "toolu_01AbCdEfGhIjKlMnOpQrStUv",
  transcript_path: path.join(
    REPO_ROOT,
    "work",
    ".run",
    "missing-transcript.jsonl"
  ),
  ...overrides,
});

/** Parsed like the hook does it from stdin. */
export const hookInput = (
  toolName: string,
  toolInput: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): HookInput =>
  parseHookInput(JSON.stringify(recordedInput(toolName, toolInput, overrides)));

export interface HookRun {
  exitCode: number;
  /** `permissionDecisionReason` when the hook denied via JSON. */
  reason?: string;
  stderr: string;
  stdout: string;
}

/** Runs `scripts/hooks/<file>` as Claude Code would, feeding `stdin`. */
export const runHookProcess = (
  file: string,
  stdin: string,
  env: Record<string, string> = {}
): Promise<HookRun> => {
  const { promise, resolve } = Promise.withResolvers<HookRun>();
  const child = execFile(
    process.execPath,
    [path.join(import.meta.dirname, file)],
    { encoding: "utf8", env: { ...process.env, ...env } },
    (_error, stdout, stderr) => {
      const reason =
        stdout.trim() === ""
          ? undefined
          : JSON.parse(stdout).hookSpecificOutput?.permissionDecisionReason;
      resolve({ exitCode: child.exitCode ?? -1, reason, stderr, stdout });
    }
  );
  child.stdin?.end(stdin);
  return promise;
};
