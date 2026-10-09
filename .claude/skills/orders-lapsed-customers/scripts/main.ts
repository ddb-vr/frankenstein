import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, OUTPUT_FILE, parseIsoDate, toCsv } from "./orders.ts";

const OUTPUT_DIR = "/output";
const DEFAULT_DAYS = 60;

interface Params {
  days: number;
  encoding: string;
  file: string;
  referenceDate: string;
}

function fail(message: string): never {
  process.stdout.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function parseDays(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return DEFAULT_DAYS;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    fail("days must be a positive integer.");
  }
  return raw;
}

function parseInput(): Params {
  let input: Record<string, unknown> | null;
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
  const referenceDate =
    typeof input.reference_date === "string"
      ? parseIsoDate(input.reference_date)
      : null;
  if (referenceDate === null) {
    fail("reference_date is required and must be a valid YYYY-MM-DD date.");
  }
  const encoding =
    typeof input.encoding === "string" && input.encoding !== ""
      ? input.encoding
      : "utf-8";
  return {
    days: parseDays(input.days),
    encoding,
    file: input.file,
    referenceDate,
  };
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
  const { days, encoding, file, referenceDate } = parseInput();
  const text = readText(file, encoding);
  try {
    const { lapsed, summary } = analyze(text, referenceDate, days);
    if (lapsed.length > 0 && existsSync(OUTPUT_DIR)) {
      mkdirSync(OUTPUT_DIR, { recursive: true });
      writeFileSync(join(OUTPUT_DIR, OUTPUT_FILE), toCsv(lapsed), "utf8");
    }
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

run();
