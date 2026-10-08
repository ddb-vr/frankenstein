// Wrapper around `docker run` for the `frankenstein-sandbox` image with
// isolation flags (no network, read-only root, resource limits, non-root user).
// Host environment is never forwarded; only the skill directory is mounted,
// never the repo root, the home directory or an ancestor of either.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { SKILL_NAME } from "./lib/examples.ts";

export const SANDBOX_IMAGE = "frankenstein-sandbox";
export const SKILL_MOUNT = "/skill";
const REPO_ROOT = path.resolve(import.meta.dirname, "..");
/** Repo-relative directories whose direct children are skill directories. */
const SKILL_ROOTS: readonly string[] = [
  "work",
  path.join("fixtures", "skills"),
  path.join(".claude", "skills"),
];
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOCKER_FAILURE_EXIT_CODES: readonly number[] = [125, 126, 127];
// Env values may hold secrets; only this one is logged verbatim.
const LOGGED_ENV = "FRANKENSTEIN_MODE=test";

/**
 * Real path of `skillDir`, which must be a skill directory: a direct child of
 * `work/`, `fixtures/skills/` or `.claude/skills/` in the repo, named like a
 * skill. Symlinks are resolved first, so a link cannot point elsewhere.
 * Throws otherwise (also when it does not exist).
 */
export const resolveSkillDir = (
  skillDir: string,
  repoRoot: string = REPO_ROOT
): string => {
  let real: string;
  try {
    real = realpathSync.native(path.resolve(skillDir));
  } catch (error) {
    throw new Error(`skill directory not found: ${skillDir}`, { cause: error });
  }
  const root = realpathSync.native(repoRoot);
  const parent = path.dirname(real);
  const isSkillDir =
    SKILL_ROOTS.some((skillRoot) => path.join(root, skillRoot) === parent) &&
    SKILL_NAME.test(path.basename(real));
  if (!isSkillDir) {
    throw new Error(
      `not a skill directory: ${skillDir} (must be work/<skill>, fixtures/skills/<skill> or .claude/skills/<skill>)`
    );
  }
  return real;
};

const realPathOrSelf = (dir: string): string => {
  try {
    return realpathSync.native(dir);
  } catch {
    return dir;
  }
};

/** Refuses the repo root, the home directory and any ancestor of either. */
const mountSource = (skillDir: string): string => {
  const source = path.resolve(skillDir);
  for (const dir of [REPO_ROOT, homedir()]) {
    for (const protectedDir of [dir, realPathOrSelf(dir)]) {
      const relative = path.relative(source, protectedDir);
      const isInside =
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
      if (isInside) {
        throw new Error(
          `refusing to mount ${source}: it is or contains the repo root or the home directory`
        );
      }
    }
  }
  return source;
};

export interface SandboxOptions {
  /** Arguments to the image ENTRYPOINT (`node`). */
  command: string[];
  /** Extra env vars; the only ones besides `FRANKENSTEIN_MODE` (`testMode`). */
  env?: Record<string, string>;
  /** Allow network access. Default `false` (`--network none`). */
  network?: boolean;
  /**
   * Receives one record per run, also when docker fails: container name,
   * docker argv (env values redacted), exit code and duration.
   */
  onRunLog?: (record: string) => void;
  skillDir: string;
  stdin?: string;
  /**
   * Set `FRANKENSTEIN_MODE=test` (no network, recorded fixtures). Default
   * `true`; `false` only for real runs of installed skills.
   */
  testMode?: boolean;
  timeoutMs?: number;
}

export interface SandboxResult {
  durationMs: number;
  exitCode: number;
  stderr: string;
  stdout: string;
  timedOut: boolean;
}

export const newContainerName = (): string =>
  `frk-${randomBytes(6).toString("hex")}`;

export const buildDockerArgs = (
  options: SandboxOptions,
  containerName: string = newContainerName()
): string[] => {
  const envArgs =
    options.testMode === false ? [] : ["-e", "FRANKENSTEIN_MODE=test"];
  for (const [key, value] of Object.entries(options.env ?? {})) {
    // A bare `-e KEY` would make Docker copy the host value, so names are strict
    // and every var is always passed as KEY=value.
    if (!ENV_NAME.test(key)) {
      throw new Error(`invalid env var name: ${JSON.stringify(key)}`);
    }
    envArgs.push("-e", `${key}=${value}`);
  }
  return [
    "run",
    "--rm",
    "-i",
    "--name",
    containerName,
    ...(options.network === true ? [] : ["--network", "none"]),
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--cpus",
    "1",
    "--memory",
    "512m",
    "--user",
    "node",
    "-v",
    `${mountSource(options.skillDir)}:${SKILL_MOUNT}:ro`,
    ...envArgs,
    SANDBOX_IMAGE,
    ...options.command,
  ];
};

// Killing the docker CLI alone leaves the container running.
const killContainer = (containerName: string, onDone: () => void): void => {
  execFile("docker", ["kill", containerName], { windowsHide: true }, onDone);
};

/** Docker argv for logs: `-e KEY=value` before the image keeps only KEY. */
export const redactDockerArgs = (args: readonly string[]): string[] => {
  const imageIndex = args.indexOf(SANDBOX_IMAGE);
  return args.map((arg, index) =>
    index < imageIndex && args[index - 1] === "-e" && arg !== LOGGED_ENV
      ? `${arg.slice(0, arg.indexOf("=") + 1)}<redacted>`
      : arg
  );
};

export interface RunRecord {
  args: readonly string[];
  containerName: string;
  durationMs: number;
  /** `undefined` when docker could not be started. */
  exitCode: number | undefined;
  timedOut: boolean;
}

/** Two log lines proving a sandbox run: what was started and how it ended. */
export const formatRunRecord = (record: RunRecord): string =>
  [
    `sandbox: container=${record.containerName} exit=${record.exitCode ?? "none"} durationMs=${record.durationMs}${record.timedOut ? " TIMED OUT" : ""}`,
    `docker argv: ${JSON.stringify(["docker", ...redactDockerArgs(record.args)])}`,
  ].join("\n");

export const runInSandbox = (
  options: SandboxOptions
): Promise<SandboxResult> => {
  const containerName = newContainerName();
  const args = buildDockerArgs(
    { ...options, skillDir: resolveSkillDir(options.skillDir) },
    containerName
  );
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = performance.now();
  const { promise, resolve, reject } = Promise.withResolvers<SandboxResult>();
  let timedOut = false;

  const child = execFile(
    "docker",
    args,
    { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
    (error, stdout, stderr) => {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - startedAt);
      const code = error && "code" in error ? error.code : undefined;
      const exitCode = code === "ENOENT" ? undefined : (child.exitCode ?? -1);
      options.onRunLog?.(
        formatRunRecord({ args, containerName, durationMs, exitCode, timedOut })
      );
      if (exitCode === undefined) {
        reject(new Error("docker CLI not found on PATH"));
        return;
      }
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        killContainer(containerName, () => undefined);
      }
      // 125: docker itself failed (daemon down, image missing); 126/127: command
      // could not be invoked. Docker CLI errors never write stdout, so a skill
      // exiting with these codes but printing output is still its own result.
      if (
        !timedOut &&
        stdout === "" &&
        DOCKER_FAILURE_EXIT_CODES.includes(exitCode)
      ) {
        reject(
          new Error(`docker run failed (exit ${exitCode}): ${stderr.trim()}`)
        );
        return;
      }
      resolve({ durationMs, exitCode, stderr, stdout, timedOut });
    }
  );

  const timer = setTimeout(() => {
    timedOut = true;
    killContainer(containerName, () => child.kill());
  }, timeoutMs);

  // The process may exit before reading stdin; ignore EPIPE.
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(options.stdin ?? "");
  return promise;
};
