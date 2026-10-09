import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { countLines, decode, parseInput, splitLines } from "../scripts/main.ts";

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

test("countLines writes numbered decoded lines to the output directory", (t) => {
  const outputDir = mkdtempSync(path.join(tmpdir(), "line-count-"));
  t.after(() => rmSync(outputDir, { force: true, recursive: true }));
  const summary = countLines(
    { encoding: "windows-1250", file: CP1250_FILE },
    outputDir
  );
  assert.deepEqual(summary, {
    file: "vypis-cp1250.csv",
    firstLine: "Datum;Objem;Měna;Zpráva pro příjemce",
    lines: 3,
    output: "vypis-cp1250.csv.lines.txt",
  });
  assert.deepEqual(readdirSync(outputDir), ["vypis-cp1250.csv.lines.txt"]);
  assert.equal(
    readFileSync(path.join(outputDir, "vypis-cp1250.csv.lines.txt"), "utf8"),
    "1\tDatum;Objem;Měna;Zpráva pro příjemce\n" +
      "2\t01.10.2026;1500,00;CZK;Faktura 2026-014 – Žluťoučký kůň s.r.o.\n" +
      "3\t03.10.2026;-250,00;CZK;Poplatek\n"
  );
});

test("countLines without an output directory writes nothing", () => {
  const inputDir = path.dirname(CP1250_FILE);
  const before = readdirSync(inputDir);
  const summary = countLines(
    { encoding: "windows-1250", file: CP1250_FILE },
    null
  );
  assert.deepEqual(summary, {
    file: "vypis-cp1250.csv",
    firstLine: "Datum;Objem;Měna;Zpráva pro příjemce",
    lines: 3,
    output: null,
  });
  assert.deepEqual(readdirSync(inputDir), before);
});
