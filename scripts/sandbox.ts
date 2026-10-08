// Wrapper around `docker run` for the `frankenstein-sandbox` image with
// isolation flags (no network, read-only root, resource limits, non-root user).
// Host environment is never forwarded; only the skill directory is mounted.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";

export const SANDBOX_IMAGE = "frankenstein-sandbox";
export const SKILL_MOUNT = "/skill";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SandboxOptions {
  /** Arguments to the image ENTRYPOINT (`node`). */
  command: string[];
  /** Extra env vars; the only ones besides `FRANKENSTEIN_MODE=test`. */
  env?: Record<string, string>;
  /** Allow network access. Default `false` (`--network none`). */
  network?: boolean;
  skillDir: string;
  stdin?: string;
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
  const envArgs = ["-e", "FRANKENSTEIN_MODE=test"];
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
    `${path.resolve(options.skillDir)}:${SKILL_MOUNT}:ro`,
    ...envArgs,
    SANDBOX_IMAGE,
    ...options.command,
  ];
};

// Killing the docker CLI alone leaves the container running.
const killContainer = (containerName: string, onDone: () => void): void => {
  execFile("docker", ["kill", containerName], { windowsHide: true }, onDone);
};

export const runInSandbox = (
  options: SandboxOptions
): Promise<SandboxResult> => {
  const containerName = newContainerName();
  const args = buildDockerArgs(options, containerName);
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
      const code = error && "code" in error ? error.code : undefined;
      if (code === "ENOENT") {
        reject(new Error("docker CLI not found on PATH"));
        return;
      }
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        killContainer(containerName, () => undefined);
      }
      resolve({
        durationMs: Math.round(performance.now() - startedAt),
        exitCode: child.exitCode ?? -1,
        stderr,
        stdout,
        timedOut,
      });
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
