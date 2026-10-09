import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildDockerArgs,
  formatRunRecord,
  resolveSkillDir,
  runInSandbox,
  SANDBOX_IMAGE,
} from "./sandbox.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const NOT_SKILL_DIR = /not a skill directory/;
const NOT_FOUND = /skill directory not found/;
const REFUSED_MOUNT = /refusing to mount/;
const MOUNT_COLLISION =
  /mount name collision: demo\/data\/bank\.csv and inputs\/bank\.csv would both be \/input\/bank\.csv/;
const NO_FILE_NAME = /cannot mount demo\/a:b: no usable file name/;
const SOURCE_NOT_FOUND = /mount source not found: /;
const OUTPUT_NOT_FOUND = /output directory not found: /;

const base = {
  command: ["/skill/x.ts"],
  skillDir: "fixtures/skills/text-stats",
};

const flagValues = (args: string[], flag: string): string[] =>
  args.flatMap((arg, index) => (arg === flag ? [args[index + 1] ?? ""] : []));

test("offline by default, network only when requested", () => {
  assert.deepEqual(flagValues(buildDockerArgs(base, "frk-t"), "--network"), [
    "none",
  ]);
  assert.deepEqual(
    flagValues(
      buildDockerArgs({ ...base, network: false }, "frk-t"),
      "--network"
    ),
    ["none"]
  );
  assert.deepEqual(
    flagValues(
      buildDockerArgs({ ...base, network: true }, "frk-t"),
      "--network"
    ),
    []
  );
});

test("only FRANKENSTEIN_MODE and explicit env vars are passed, always as KEY=value", (t) => {
  process.env.HOST_SECRET = "leak";
  t.after(() => {
    delete process.env.HOST_SECRET;
  });
  const args = buildDockerArgs(
    { ...base, env: { API_URL: "http://x" } },
    "frk-t"
  );
  assert.deepEqual(flagValues(args, "-e"), [
    "FRANKENSTEIN_MODE=test",
    "API_URL=http://x",
  ]);
  assert.ok(!args.some((arg) => arg.includes("HOST_SECRET")));
  assert.ok(!args.some((arg) => arg.startsWith("--env")));
});

test("real runs (testMode false) drop FRANKENSTEIN_MODE but keep explicit env", () => {
  const args = buildDockerArgs(
    { ...base, env: { API_URL: "http://x" }, testMode: false },
    "frk-t"
  );
  assert.deepEqual(flagValues(args, "-e"), ["API_URL=http://x"]);
});

test("rejects env names that could forward host values or inject flags", () => {
  for (const key of ["A B", "X=Y", "", "-e"]) {
    assert.throws(() =>
      buildDockerArgs({ ...base, env: { [key]: "v" } }, "frk-t")
    );
  }
});

test("mounts only the absolute skill dir, read-only, at /skill", () => {
  const args = buildDockerArgs(base, "frk-t");
  assert.deepEqual(flagValues(args, "-v"), [
    `${path.resolve(base.skillDir)}:/skill:ro`,
  ]);
  assert.ok(
    path.isAbsolute(flagValues(args, "-v")[0]?.split(":/skill")[0] ?? "")
  );
});

test("inputs mount read-only at /input/<basename>, the output read-write at /output", (t) => {
  const dir = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "sandbox-mounts-"))
  );
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const data = path.join(dir, "data");
  mkdirSync(path.join(data, "invoices"), { recursive: true });
  writeFileSync(path.join(data, "bank-2026-10.csv"), "");
  // The container name comes from the path as given, the source is real.
  symlinkSync(
    path.join(data, "bank-2026-10.csv"),
    path.join(data, "bank.csv"),
    "file"
  );
  const args = buildDockerArgs(
    {
      ...base,
      mounts: [path.join(data, "bank.csv"), path.join(data, "invoices")],
      outputDir: path.join(dir, "out"),
    },
    "frk-t"
  );
  assert.deepEqual(flagValues(args, "-v"), [
    `${path.resolve(base.skillDir)}:/skill:ro`,
    `${path.join(data, "bank-2026-10.csv")}:/input/bank.csv:ro`,
    `${path.join(data, "invoices")}:/input/invoices:ro`,
    `${path.join(dir, "out")}:/output:rw`,
  ]);
  // Mounts precede the image: nothing reaches the command.
  assert.ok(args.lastIndexOf("-v") < args.indexOf(SANDBOX_IMAGE));
});

test("two inputs with the same basename are an error", () => {
  assert.throws(
    () =>
      buildDockerArgs(
        { ...base, mounts: ["demo/data/bank.csv", "inputs/bank.csv"] },
        "frk-t"
      ),
    MOUNT_COLLISION
  );
});

test("an input whose basename contains a colon is refused", () => {
  // `:` would split the `-v host:container:mode` spec.
  assert.throws(
    () => buildDockerArgs({ ...base, mounts: ["demo/a:b"] }, "frk-t"),
    NO_FILE_NAME
  );
});

test("runInSandbox refuses a missing input or a non-directory output before docker", (t) => {
  const dir = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "sandbox-sources-"))
  );
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const file = path.join(dir, "out.txt");
  writeFileSync(file, "");
  // Synchronous throws: no promise, so no docker process was started.
  assert.throws(
    () => runInSandbox({ ...base, mounts: [path.join(dir, "missing.csv")] }),
    SOURCE_NOT_FOUND
  );
  assert.throws(
    () => runInSandbox({ ...base, outputDir: file }),
    OUTPUT_NOT_FOUND
  );
  assert.throws(
    () => runInSandbox({ ...base, outputDir: path.join(dir, "missing") }),
    OUTPUT_NOT_FOUND
  );
});

test("inputs and output never mount the repo root or the home directory", () => {
  for (const mounts of [[REPO_ROOT], [homedir()], [path.dirname(homedir())]]) {
    assert.throws(
      () => buildDockerArgs({ ...base, mounts }, "frk-t"),
      REFUSED_MOUNT
    );
  }
  assert.throws(
    () => buildDockerArgs({ ...base, outputDir: homedir() }, "frk-t"),
    REFUSED_MOUNT
  );
});

test("never mounts the repo root, the home directory or their ancestors", () => {
  for (const skillDir of [
    REPO_ROOT,
    path.dirname(REPO_ROOT),
    homedir(),
    path.dirname(homedir()),
    path.parse(REPO_ROOT).root,
  ]) {
    assert.throws(
      () => buildDockerArgs({ ...base, skillDir }, "frk-t"),
      REFUSED_MOUNT,
      skillDir
    );
  }
});

test("resolveSkillDir accepts only direct children of the skill roots", (t) => {
  // Real path: on macOS tmpdir() itself is behind a symlink.
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "sandbox-test-"))
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const dir = (...parts: string[]): string => {
    const full = path.join(root, ...parts);
    mkdirSync(full, { recursive: true });
    return full;
  };
  for (const skill of [
    dir("work", "csv-sum"),
    dir("fixtures", "skills", "text-stats"),
    dir(".claude", "skills", "ico-validator"),
  ]) {
    assert.equal(resolveSkillDir(skill, root), skill);
  }

  // `junction` needs no privileges on Windows and is ignored elsewhere.
  symlinkSync(root, path.join(root, "work", "to-root"), "junction");
  symlinkSync(
    dir("work", "csv-sum"),
    path.join(root, "work", "csv-sum-link"),
    "junction"
  );
  for (const notSkill of [
    root,
    dir("work"),
    dir("fixtures"),
    dir("fixtures", "skills"),
    dir("other", "csv-sum"),
    dir("work", "csv-sum", "scripts"),
    dir("work", ".locks"),
    path.join(root, "work", "to-root"),
    path.join(root, "work", "csv-sum", ".."),
  ]) {
    assert.throws(
      () => resolveSkillDir(notSkill, root),
      NOT_SKILL_DIR,
      notSkill
    );
  }
  // A link inside a skill root resolves to its real target.
  assert.equal(
    resolveSkillDir(path.join(root, "work", "csv-sum-link"), root),
    path.join(root, "work", "csv-sum")
  );
  assert.throws(
    () => resolveSkillDir(path.join(root, "work", "missing"), root),
    NOT_FOUND
  );
});

test("resolveSkillDir accepts the repo's fixture skill", () => {
  const fixture = path.join(REPO_ROOT, "fixtures", "skills", "text-stats");
  assert.equal(resolveSkillDir(fixture), realpathSync.native(fixture));
  assert.throws(() => resolveSkillDir(REPO_ROOT), NOT_SKILL_DIR);
});

test("hardening flags, container name and command placement", () => {
  const args = buildDockerArgs(
    { ...base, command: ["--test", "/skill/t/"] },
    "frk-abc"
  );
  assert.deepEqual(args.slice(0, 5), [
    "run",
    "--rm",
    "-i",
    "--name",
    "frk-abc",
  ]);
  for (const flag of [
    "--read-only",
    "--cap-drop",
    "--security-opt",
    "--pids-limit",
    "--memory",
    "--user",
  ]) {
    assert.ok(args.includes(flag), flag);
  }
  assert.deepEqual(flagValues(args, "--user"), ["node"]);
  assert.deepEqual(args.slice(-3), [SANDBOX_IMAGE, "--test", "/skill/t/"]);
});

test("the run record names the container and redacts env values", () => {
  const args = buildDockerArgs(
    {
      ...base,
      command: ["-e", "/skill/x.ts"],
      env: { API_TOKEN: "s3cret=value" },
    },
    "frk-abc"
  );
  const record = formatRunRecord({
    args,
    containerName: "frk-abc",
    durationMs: 812,
    exitCode: 3,
    timedOut: false,
  });
  const [status = "", argv = ""] = record.split("\n");
  assert.equal(status, "sandbox: container=frk-abc exit=3 durationMs=812");
  assert.ok(!record.includes("s3cret"));
  const logged: string[] = JSON.parse(argv.replace("docker argv: ", ""));
  assert.deepEqual(
    flagValues(logged.slice(0, logged.indexOf(SANDBOX_IMAGE)), "-e"),
    ["FRANKENSTEIN_MODE=test", "API_TOKEN=<redacted>"]
  );
  // Only env flags before the image are redacted; the command is kept.
  assert.deepEqual(logged.slice(0, 2), ["docker", "run"]);
  assert.deepEqual(logged.slice(-3), [SANDBOX_IMAGE, "-e", "/skill/x.ts"]);
  const [timedOutStatus] = formatRunRecord({
    args,
    containerName: "frk-abc",
    durationMs: 5,
    exitCode: undefined,
    timedOut: true,
  }).split("\n");
  assert.equal(
    timedOutStatus,
    "sandbox: container=frk-abc exit=none durationMs=5 TIMED OUT"
  );
});

test("the run record lists every mount with host path, container path and mode", () => {
  const windowsHost = "C:\\Users\\dev\\frankenstein\\out\\x";
  const record = formatRunRecord({
    args: [
      "run",
      "-v",
      "/repo/fixtures/skills/a:/skill:ro",
      "-v",
      "/repo/demo/data/bank.csv:/input/bank.csv:ro",
      "-v",
      `${windowsHost}:/output:rw`,
      SANDBOX_IMAGE,
      // After the image: the skill's arguments, never a mount.
      "-v",
      "/etc:/input/etc:ro",
    ],
    containerName: "frk-abc",
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
  });
  assert.deepEqual(record.split("\n").slice(2), [
    "mount: /repo/fixtures/skills/a -> /skill (ro)",
    "mount: /repo/demo/data/bank.csv -> /input/bank.csv (ro)",
    `mount: ${windowsHost} -> /output (rw)`,
  ]);
});
