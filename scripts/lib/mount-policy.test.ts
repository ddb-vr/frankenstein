import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  allowedRootsFrom,
  checkMount,
  loadAllowedRoots,
  type MountPolicy,
  resolveMounts,
  resolveOutput,
} from "./mount-policy.ts";

// `assert.throws` matches a RegExp against `Error: <message>`: no `^` anchor.
const OUTSIDE_ROOTS =
  /mount denied: .+: it is outside the allowed roots \(demo\/data, inputs; INPUT_ALLOWED_ROOTS in \.env\)/;
const AFTER_SYMLINKS = /after resolving symlinks to /;
const NEVER_MOUNTED =
  /mount denied: .+ never mounted \(\.env\*, \*\.pem, \.git, \.claude\)$/;
const CONTAINS = /the directory contains (\.env|nested\/\.git)/;
const REPO_PATH = /mount denied: .+: it is, is inside or contains the repo's /;
const HOME = /mount denied: .+: it is or contains the home directory$/;
const MISSING = /mount denied: inputs\/missing\.csv: it does not exist$/;
const OUTPUT_OUTSIDE = /output denied: .+: it must be inside out\/$/;
const OUTPUT_SYMLINK =
  /output denied: .+: it resolves outside out\/ through a symlink$/;
const OUTPUT_FILE = /output denied: .+: it is not a directory$/;
const COLLISION =
  /mount denied: inputs\/bank\.csv: same name as demo\/data\/bank\.csv, both would be \/input\/bank\.csv$/;

/** A scratch repo: allowed roots demo/data and inputs, home under inputs. */
const scratchRepo = (t: { after: (fn: () => void) => void }) => {
  // Real path: on macOS tmpdir() itself is behind a symlink.
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), "mount-policy-test-"))
  );
  t.after(() => rmSync(root, { force: true, recursive: true }));
  const file = (relative: string, content = "x"): string => {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    return full;
  };
  file("demo/data/bank.csv");
  file("inputs/invoices/2026-10.csv");
  file("inputs/home/notes.txt");
  file("scripts/run-skill.ts");
  file("work/.locks/x.json");
  file(".claude/settings.json");
  file(".git/config");
  file(".env", "SECRET=1");
  file("secret.csv");
  const policy: MountPolicy = {
    allowedRoots: allowedRootsFrom(undefined, root),
    cwd: root,
    home: path.join(root, "inputs", "home"),
    root,
  };
  return { file, policy, root };
};

test("a mount inside an allowed root resolves to its absolute path", (t) => {
  const { policy, root } = scratchRepo(t);
  assert.equal(
    checkMount("demo/data/bank.csv", policy),
    path.join(root, "demo", "data", "bank.csv")
  );
  assert.equal(
    checkMount("inputs/invoices", policy),
    path.join(root, "inputs", "invoices")
  );
  assert.throws(() => checkMount("inputs/missing.csv", policy), MISSING);
});

test("a mount outside the allowed roots is denied, also through a symlink", (t) => {
  const { policy, root } = scratchRepo(t);
  assert.throws(() => checkMount("secret.csv", policy), OUTSIDE_ROOTS);
  assert.throws(() => checkMount("demo", policy), OUTSIDE_ROOTS);
  symlinkSync(
    path.join(root, "secret.csv"),
    path.join(root, "inputs", "statement.csv"),
    "file"
  );
  assert.throws(
    () => checkMount("inputs/statement.csv", policy),
    (error: Error) => {
      assert.match(error.message, OUTSIDE_ROOTS);
      assert.match(error.message, AFTER_SYMLINKS);
      return true;
    }
  );
});

test(".env*, *.pem, .git and .claude are denied inside allowed roots", (t) => {
  const { file, policy } = scratchRepo(t);
  file("inputs/.env.local");
  file("inputs/keys/app.pem");
  file("inputs/clone/.git/config");
  file("inputs/proj/.claude/settings.json");
  for (const given of [
    ".env",
    "inputs/.env.local",
    "inputs/keys/app.pem",
    "inputs/clone/.git",
    "inputs/clone/.git/config",
    "inputs/proj/.claude/settings.json",
  ]) {
    assert.throws(() => checkMount(given, policy), NEVER_MOUNTED, given);
  }
  // A directory is denied when anything inside it is.
  file("inputs/batch/.env", "TOKEN=1");
  file("inputs/repo/nested/.git/HEAD");
  for (const given of ["inputs/batch", "inputs/repo"]) {
    assert.throws(() => checkMount(given, policy), CONTAINS, given);
  }
});

test("the repo's scripts, work/.locks, .git and .claude and the home directory are denied even when a root allows them", (t) => {
  const { policy, root } = scratchRepo(t);
  // The home directory elsewhere, so `.` is denied for the repo paths alone.
  const wide = {
    ...policy,
    allowedRoots: [root],
    home: path.join(tmpdir(), "no-such-home"),
  };
  for (const given of [
    "scripts/run-skill.ts",
    "scripts",
    "work/.locks/x.json",
    ".claude/settings.json",
    "work",
    ".",
  ]) {
    assert.throws(() => checkMount(given, wide), REPO_PATH, given);
  }
  for (const given of ["inputs/home", "inputs"]) {
    assert.throws(() => checkMount(given, policy), HOME, given);
  }
  // Below the home directory is fine when a root allows it.
  assert.ok(checkMount("inputs/home/notes.txt", policy));
});

test("the output must resolve inside out/ and is created on demand", (t) => {
  const { file, policy, root } = scratchRepo(t);
  const out = path.join(root, "out", "test");
  assert.equal(resolveOutput("out/test", policy), out);
  assert.ok(existsSync(out));
  for (const given of ["logs", "out/../logs", "/tmp/x", root]) {
    assert.throws(() => resolveOutput(given, policy), OUTPUT_OUTSIDE, given);
  }
  mkdirSync(path.join(root, "elsewhere"));
  symlinkSync(
    path.join(root, "elsewhere"),
    path.join(root, "out", "link"),
    "junction"
  );
  assert.throws(() => resolveOutput("out/link/x", policy), OUTPUT_SYMLINK);
  assert.ok(!existsSync(path.join(root, "elsewhere", "x")));
  file("out/report.csv");
  assert.throws(() => resolveOutput("out/report.csv", policy), OUTPUT_FILE);
});

test("a denied mount or a name collision stops before the output directory is created", (t) => {
  const { file, policy, root } = scratchRepo(t);
  file("inputs/bank.csv");
  for (const mounts of [[".env"], ["demo/data/bank.csv", "inputs/bank.csv"]]) {
    assert.throws(
      () => resolveMounts({ mounts, output: "out/run" }, policy),
      mounts.length === 1 ? NEVER_MOUNTED : COLLISION
    );
  }
  assert.ok(!existsSync(path.join(root, "out", "run")));
  assert.deepEqual(
    resolveMounts(
      { mounts: ["demo/data/bank.csv"], output: "out/run" },
      policy
    ),
    {
      mounts: [path.join(root, "demo", "data", "bank.csv")],
      outputDir: path.join(root, "out", "run"),
    }
  );
});

test("allowed roots come from INPUT_ALLOWED_ROOTS in .env only", (t) => {
  const { root } = scratchRepo(t);
  assert.deepEqual(allowedRootsFrom(" , ", root), [
    path.join(root, "demo", "data"),
    path.join(root, "inputs"),
  ]);
  assert.deepEqual(allowedRootsFrom("data, /srv/exports", root), [
    path.join(root, "data"),
    path.resolve("/srv/exports"),
  ]);
  process.env.INPUT_ALLOWED_ROOTS = "/";
  t.after(() => {
    delete process.env.INPUT_ALLOWED_ROOTS;
  });
  writeFileSync(path.join(root, ".env"), "INPUT_ALLOWED_ROOTS=exports\n");
  assert.deepEqual(loadAllowedRoots(root), [path.join(root, "exports")]);
  rmSync(path.join(root, ".env"));
  assert.deepEqual(loadAllowedRoots(root), allowedRootsFrom(undefined, root));
});
