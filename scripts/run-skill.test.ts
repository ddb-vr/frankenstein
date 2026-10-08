import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { parseInvocation } from "./run-skill.ts";

const execFileAsync = promisify(execFile);
const RUN_SKILL = path.join(import.meta.dirname, "run-skill.ts");
const EXACTLY_ONCE = /pass the JSON input exactly once/;
const NOT_JSON_FILE = /input file .*input\.json must contain one JSON value/;
const CANNOT_READ = /cannot read input file/;
const NEEDS_PATH = /--input-file needs a path/;
const SECRET = "GITHUB_APP_PRIVATE_KEY_PATH";

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
    name: "ico-check",
  });
  // A negative number is a JSON value, not an option.
  assert.deepEqual(parseInvocation(["calc", "-1"]), {
    input: -1,
    name: "calc",
  });
});

test("JSON input from --input-file, in both spellings", () => {
  const file = path.join(dir, "input.json");
  writeFileSync(file, JSON.stringify({ icos: ["27074358", "00006947"] }));
  const expected = {
    input: { icos: ["27074358", "00006947"] },
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
