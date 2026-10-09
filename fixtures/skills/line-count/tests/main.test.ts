import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { decode, parseInput, splitLines } from "../scripts/main.ts";

const CP1250_FILE = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "input",
  "vypis-cp1250.csv"
);

test("windows-1250 bytes decode to Czech diacritics", () => {
  const text = decode(readFileSync(CP1250_FILE), "windows-1250");
  assert.ok(text.includes("Zpráva pro příjemce"));
  assert.ok(text.includes("Žluťoučký kůň"));
});

test("strict decoding rejects bytes invalid in the encoding", () => {
  assert.throws(() => decode(readFileSync(CP1250_FILE), "utf-8"));
  assert.throws(() => decode(new Uint8Array(), "no-such-encoding"), {
    message: "unsupported encoding no-such-encoding",
  });
});

test("a trailing newline does not add a line; CRLF is one break", () => {
  assert.deepEqual(splitLines("a\r\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\n\nb"), ["a", "", "b"]);
  assert.deepEqual(splitLines(""), []);
});

test("input needs a file path; encoding defaults to utf-8", () => {
  assert.deepEqual(parseInput({ file: "/input/a.csv" }), {
    encoding: "utf-8",
    file: "/input/a.csv",
  });
  assert.throws(() => parseInput({}), {
    message: "file must be a non-empty path",
  });
  assert.throws(() => parseInput({ encoding: 1, file: "/input/a.csv" }), {
    message: "encoding must be a string",
  });
});
