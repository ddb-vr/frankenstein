// Wrapper around `docker run` for the `frankenstein-sandbox` image with
// isolation flags (no network, read-only root, resource limits, non-root user).
// Host environment is never forwarded. Mounted: the skill directory read-only
// at /skill, optional input files or directories read-only at
// /input/<basename> and an optional output directory read-write at /output;
// never the repo root, the home directory or an ancestor of either.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { SKILL_NAME } from "./lib/examples.ts";

export const SANDBOX_IMAGE = "frankenstein-sandbox";
export const SKILL_MOUNT = "/skill";
export const INPUT_MOUNT = "/input";
export const OUTPUT_MOUNT = "/output";
/**
 * One `mount: <host> -> <container> (ro|rw)` line of a run record. The
 * container path may contain spaces (`/input/<basename>`); a basename never
 * contains `/`, so the greedy host group still splits at the right ` -> `.
 */
export const MOUNT_RECORD = /^mount: (.+) -> (\/.*) \((ro|rw)\)$/;
/** `-v` value: host path (may contain `:` on Windows), container path, mode. */
const VOLUME_SPEC = /^(.+):(\/[^:]*):(ro|rw)$/;
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
const mountSource = (hostPath: string): string => {
  const source = path.resolve(hostPath);
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
  /**
   * Host files or directories, each mounted read-only at `/input/<basename>`
   * (basename of the path as given; symlinks are resolved for the source).
   * Two mounts with the same basename are an error.
   */
  mounts?: string[];
  /** Allow network access. Default `false` (`--network none`). */
  network?: boolean;
  /**
   * Receives one record per run, also when docker fails: container name,
   * docker argv (env values redacted), exit code, duration and mounts.
   */
  onRunLog?: (record: string) => void;
  /** Host directory mounted read-write at `/output`. */
  outputDir?: string;
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

export interface Mount {
  container: string;
  host: string;
  readOnly: boolean;
}

/**
 * Every bind mount of a run, skill directory first. Sources are absolute and
 * pass the same repo-root / home-directory refusal as the skill directory.
 */
export const sandboxMounts = (
  options: Pick<SandboxOptions, "mounts" | "outputDir" | "skillDir">
): Mount[] => {
  const mounts: Mount[] = [
    {
      container: SKILL_MOUNT,
      host: mountSource(options.skillDir),
      readOnly: true,
    },
  ];
  const byName = new Map<string, string>();
  for (const given of options.mounts ?? []) {
    const absolute = path.resolve(given);
    const name = path.basename(absolute);
    if (name === "" || name.includes(":")) {
      throw new Error(`cannot mount ${given}: no usable file name`);
    }
    const previous = byName.get(name);
    if (previous !== undefined) {
      throw new Error(
        `mount name collision: ${previous} and ${given} would both be ${INPUT_MOUNT}/${name}`
      );
    }
    byName.set(name, given);
    mounts.push({
      container: `${INPUT_MOUNT}/${name}`,
      host: mountSource(realPathOrSelf(absolute)),
      readOnly: true,
    });
  }
  if (options.outputDir !== undefined) {
    mounts.push({
      container: OUTPUT_MOUNT,
      host: mountSource(realPathOrSelf(path.resolve(options.outputDir))),
      readOnly: false,
    });
  }
  return mounts;
};

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
    ...sandboxMounts(options).flatMap(({ container, host, readOnly }) => [
      "-v",
      `${host}:${container}:${readOnly ? "ro" : "rw"}`,
    ]),
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

/** The `-v` mounts of a docker argv, one `mount:` line each. */
const mountLines = (args: readonly string[]): string[] =>
  args.flatMap((arg, index) => {
    const spec = args[index - 1] === "-v" ? VOLUME_SPEC.exec(arg) : null;
    return spec ? [`mount: ${spec[1]} -> ${spec[2]} (${spec[3]})`] : [];
  });

/**
 * Log lines proving a sandbox run: what was started, how it ended and every
 * mount (host path -> container path, ro/rw).
 */
export const formatRunRecord = (record: RunRecord): string =>
  [
    `sandbox: container=${record.containerName} exit=${
      record.exitCode ?? "none"
    } durationMs=${record.durationMs}${record.timedOut ? " TIMED OUT" : ""}`,
    `docker argv: ${JSON.stringify(["docker", ...redactDockerArgs(record.args)])}`,
    ...mountLines(record.args.slice(0, record.args.indexOf(SANDBOX_IMAGE))),
  ].join("\n");

/**
 * Docker would create a missing bind source as an empty root-owned
 * directory, so every input must exist and the output must be a directory.
 */
const assertMountSources = (
  options: Pick<SandboxOptions, "mounts" | "outputDir">
): void => {
  for (const mount of options.mounts ?? []) {
    if (statSync(mount, { throwIfNoEntry: false }) === undefined) {
      throw new Error(`mount source not found: ${mount}`);
    }
  }
  const { outputDir } = options;
  if (
    outputDir !== undefined &&
    statSync(outputDir, { throwIfNoEntry: false })?.isDirectory() !== true
  ) {
    throw new Error(`output directory not found: ${outputDir}`);
  }
};

export const runInSandbox = (
  options: SandboxOptions
): Promise<SandboxResult> => {
  assertMountSources(options);
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
