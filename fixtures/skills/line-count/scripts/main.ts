// Entry point: reads `{ "file": string, "encoding"?: string }` from stdin,
// counts the lines of the file at that path (as given: `/input/…` at runtime,
// `/skill/fixtures/input/…` in tests) and writes a compact summary to stdout.
// When `/output` exists, the decoded lines also go to `/output/<name>.lines.txt`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface LineCountInput {
  encoding: string;
  file: string;
}

export interface LineCount {
  file: string;
  firstLine: string;
  lines: number;
  output: string | null;
}

const OUTPUT_DIR = "/output";
const NEWLINE = /\r?\n/;
const DEFAULT_ENCODING = "utf-8";

export const parseInput = (input: unknown): LineCountInput => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("file" in input) ||
    typeof input.file !== "string" ||
    input.file === ""
  ) {
    throw new Error("file must be a non-empty path");
  }
  const encoding =
    "encoding" in input && input.encoding !== undefined
      ? input.encoding
      : DEFAULT_ENCODING;
  if (typeof encoding !== "string") {
    throw new Error("encoding must be a string");
  }
  return { encoding, file: input.file };
};

/**
 * Decodes strictly: bytes invalid in `encoding` (e.g. non-UTF-8 input read
 * as UTF-8) are an error. Single-byte encodings such as windows-1250 map
 * every byte, so a wrong one of those still yields mojibake, not an error.
 */
export const decode = (bytes: Uint8Array, encoding: string): string => {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch (error) {
    throw new Error(`unsupported encoding ${encoding}`, { cause: error });
  }
  return decoder.decode(bytes);
};

/** Lines of `text`; a trailing newline does not start another line. */
export const splitLines = (text: string): string[] => {
  if (text === "") {
    return [];
  }
  const lines = text.split(NEWLINE);
  return lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

export const countLines = (
  { encoding, file }: LineCountInput,
  outputDir: string | null
): LineCount => {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    throw new Error(`cannot read ${file}`, { cause: error });
  }
  const lines = splitLines(decode(bytes, encoding));
  const name = path.basename(file);
  let output: string | null = null;
  if (outputDir !== null) {
    output = `${name}.lines.txt`;
    const numbered = lines.map((line, index) => `${index + 1}\t${line}\n`);
    writeFileSync(path.join(outputDir, output), numbered.join(""));
  }
  return { file: name, firstLine: lines[0] ?? "", lines: lines.length, output };
};

const main = async (): Promise<void> => {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  try {
    const outputDir = existsSync(OUTPUT_DIR) ? OUTPUT_DIR : null;
    const summary = countLines(parseInput(JSON.parse(raw)), outputDir);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ error: (error as Error).message })}\n`
    );
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
