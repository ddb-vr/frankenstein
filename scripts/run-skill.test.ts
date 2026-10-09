import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { enabledEntry, parseInvocation } from "./run-skill.ts";

const execFileAsync = promisify(execFile);
const RUN_SKILL = path.join(import.meta.dirname, "run-skill.ts");
const EXACTLY_ONCE = /pass the JSON input exactly once/;
const NOT_JSON_FILE = /input file .*input\.json must contain one JSON value/;
const CANNOT_READ = /cannot read input file/;
const NEEDS_PATH = /--input-file needs a path/;
const MOUNT_NEEDS_PATH = /--mount needs a path/;
const ONE_OUTPUT = /pass --output at most once/;
const SECRET = "GITHUB_APP_PRIVATE_KEY_PATH";
const NOT_JSON_INLINE = /^input must be one JSON value$/;
const DISABLED = /skill "csv-sum" is disabled/;
const NOT_INSTALLED = /skill "other" is not installed/;
const INVALID_NAME = /invalid skill name/;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "run-skill-test-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

test("JSON input as the argument", () => {
  assert.deepEqual(parseInvocation(["ico-check", '{"ico":"27074358"}']), {
    input: { ico: "27074358" },
    mounts: [],
    name: "ico-check",
  });
  // A negative number is a JSON value, not an option.
  assert.deepEqual(parseInvocation(["calc", "-1"]), {
    input: -1,
    mounts: [],
    name: "calc",
  });
});

test("JSON input from --input-file, in both spellings", () => {
  const file = path.join(dir, "input.json");
  writeFileSync(file, JSON.stringify({ icos: ["27074358", "00006947"] }));
  const expected = {
    input: { icos: ["27074358", "00006947"] },
    mounts: [],
    name: "ico-check",
  };
  assert.deepEqual(
    parseInvocation(["ico-check", "--input-file", file]),
    expected
  );
  assert.deepEqual(
    parseInvocation(["ico-check", `--input-file=${file}`]),
    expected
  );
});

test("--mount repeats and --output is optional, in both spellings and any position", () => {
  const file = path.join(dir, "input.json");
  writeFileSync(file, '{"statement":"/input/bank.csv"}');
  assert.deepEqual(
    parseInvocation([
      "bank-match",
      "--mount",
      "demo/data/bank.csv",
      '{"statement":"/input/bank.csv"}',
      "--mount=inputs/invoices",
      "--output",
      "out/session-1",
    ]),
    {
      input: { statement: "/input/bank.csv" },
      mounts: ["demo/data/bank.csv", "inputs/invoices"],
      name: "bank-match",
      output: "out/session-1",
    }
  );
  assert.deepEqual(
    parseInvocation([
      "bank-match",
      "--input-file",
      file,
      "--mount",
      "demo/data/bank.csv",
      "--output=out/x",
    ]),
    {
      input: { statement: "/input/bank.csv" },
      mounts: ["demo/data/bank.csv"],
      name: "bank-match",
      output: "out/x",
    }
  );
  // A flag value is never taken as the JSON input.
  assert.throws(
    () => parseInvocation(["bank-match", "--mount", "{}"]),
    EXACTLY_ONCE
  );
  for (const args of [
    ["bank-match", "{}", "--mount"],
    ["bank-match", "{}", "--mount="],
  ]) {
    assert.throws(() => parseInvocation(args), MOUNT_NEEDS_PATH);
  }
  assert.throws(
    () =>
      parseInvocation(["bank-match", "{}", "--output", "out/a", "--output=b"]),
    ONE_OUTPUT
  );
});

test("exactly one input source is required", () => {
  const file = path.join(dir, "input.json");
  writeFileSync(file, "{}");
  for (const args of [
    ["ico-check"],
    ["ico-check", "{}", "--input-file", file],
    ["ico-check", "{}", "[]"],
    ["ico-check", "--input-file", file, "--input-file", file],
  ]) {
    assert.throws(() => parseInvocation(args), EXACTLY_ONCE, args.join(" "));
  }
  assert.throws(
    () => parseInvocation(["ico-check", "--input-file"]),
    NEEDS_PATH
  );
});

test("a bad input file is reported without echoing its content", () => {
  const file = path.join(dir, "input.json");
  writeFileSync(file, `${SECRET}=/keys/app.pem\n`);
  assert.throws(
    () => parseInvocation(["ico-check", "--input-file", file]),
    (error: Error) => {
      assert.match(error.message, NOT_JSON_FILE);
      assert.ok(!error.message.includes(SECRET));
      return true;
    }
  );
  assert.throws(
    () =>
      parseInvocation([
        "ico-check",
        "--input-file",
        path.join(dir, "missing.json"),
      ]),
    CANNOT_READ
  );
});

test("inline input that is not JSON is rejected without echoing it", () => {
  // The exact message proves the input is not quoted back.
  for (const input of [`{${SECRET}: 1}`, "not json"]) {
    assert.throws(() => parseInvocation(["ico-check", input]), {
      message: NOT_JSON_INLINE,
    });
  }
});

test("only installed, enabled skills run", () => {
  const entry = {
    enabled: true,
    examplesHash: "a".repeat(64),
    installedAt: "2026-10-08T12:00:00.000Z",
    issue: 7,
    name: "csv-sum",
    network: false,
    version: "v1",
  };
  const registry = (enabled: boolean) =>
    writeFileSync(
      path.join(dir, "registry.json"),
      JSON.stringify({ skills: [{ ...entry, enabled }] })
    );
  registry(true);
  // Entries from before `history` existed are migrated on read.
  assert.deepEqual(enabledEntry(dir, "csv-sum"), {
    ...entry,
    history: [
      {
        action: "install",
        at: entry.installedAt,
        commit: null,
        costUsd: null,
        issue: 7,
        version: "v1",
      },
    ],
  });
  assert.throws(() => enabledEntry(dir, "other"), NOT_INSTALLED);
  assert.throws(() => enabledEntry(dir, "../csv-sum"), INVALID_NAME);
  registry(false);
  assert.throws(() => enabledEntry(dir, "csv-sum"), DISABLED);
});

test("CLI exits 1 with a JSON error when the input source is ambiguous", async () => {
  const cases = [["ico-check"], ["ico-check", "{}", "--input-file", "x.json"]];
  await Promise.all(
    cases.map((args) =>
      assert.rejects(
        execFileAsync(process.execPath, [RUN_SKILL, ...args], { cwd: dir }),
        (error: { code?: number; stdout?: string }) => {
          assert.equal(error.code, 1);
          assert.match(JSON.parse(error.stdout ?? "").error, EXACTLY_ONCE);
          return true;
        }
      )
    )
  );
});
