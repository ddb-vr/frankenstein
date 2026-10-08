import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildDockerArgs, SANDBOX_IMAGE } from "./sandbox.ts";

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
