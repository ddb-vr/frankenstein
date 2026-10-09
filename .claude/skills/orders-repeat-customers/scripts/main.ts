import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, OUTPUT_FILE, toCsv } from "./orders.ts";

const OUTPUT_DIR = "/output";

function fail(message: string): never {
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function parseInput(): { encoding: string; file: string } {
  let input: { encoding?: unknown; file?: unknown } | null;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    fail("Input must be valid JSON.");
  }
  if (typeof input !== "object" || input === null) {
    fail("Input must be a JSON object.");
  }
  if (typeof input.file !== "string" || input.file === "") {
    fail("Missing required input: file.");
  }
  const encoding =
    typeof input.encoding === "string" && input.encoding !== ""
      ? input.encoding
      : "utf-8";
  return { encoding, file: input.file };
}

function readText(file: string, encoding: string): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch {
    fail(`Unsupported encoding: ${encoding}`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    fail(`Cannot read file: ${file}`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    fail(`File is not valid ${encoding}.`);
  }
}

function run(): void {
  const { encoding, file } = parseInput();
  const text = readText(file, encoding);
  try {
    const { repeat, summary } = analyze(text);
    if (existsSync(OUTPUT_DIR)) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
      writeFileSync(join(OUTPUT_DIR, OUTPUT_FILE), toCsv(repeat), "utf8");
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

run();
