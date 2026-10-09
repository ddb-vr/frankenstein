import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
  flaggedRows,
  parseInvoices,
  parseStatement,
  reconcile,
  statusRows,
  summarize,
} from "./check.ts";
import { toCsv } from "./csv.ts";

const OUTPUT_DIR = "/output";

interface Input {
  invoices?: unknown;
  invoicesEncoding?: unknown;
  statement?: unknown;
  statementEncoding?: unknown;
}

function readText(path: string, encoding: unknown, label: string): string {
  const enc = encoding === undefined ? "utf-8" : encoding;
  if (typeof enc !== "string") {
    throw new Error(`${label}Encoding must be a string`);
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(enc, { fatal: true });
  } catch (error) {
    throw new Error(`Unsupported encoding: ${enc}`, { cause: error });
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new Error(`Cannot read ${label} file: ${path}`, { cause: error });
  }
  try {
    return decoder.decode(bytes);
  } catch (error) {
    throw new Error(`Cannot decode ${label} file as ${enc}`, { cause: error });
  }
}

export function run(input: Input): Record<string, unknown> {
  const { invoices, statement } = input;
  if (typeof statement !== "string" || statement === "") {
    throw new Error("statement must be a path string");
  }
  if (typeof invoices !== "string" || invoices === "") {
    throw new Error("invoices must be a path string");
  }
  const statementText = readText(
    statement,
    input.statementEncoding,
    "statement"
  );
  const invoicesText = readText(invoices, input.invoicesEncoding, "invoices");
  const payments = parseStatement(statementText);
  if (payments.length === 0) {
    throw new Error("The statement has no rows");
  }
  const result = reconcile(parseInvoices(invoicesText), payments);
  const summary: Record<string, unknown> = { ...summarize(result) };
  if (existsSync(OUTPUT_DIR) && statSync(OUTPUT_DIR).isDirectory()) {
    const files: Record<string, string[][]> = {
      "invoice-status.csv": statusRows(result),
      "to-check.csv": flaggedRows(result.toCheck, true),
      "unmatched-payments.csv": flaggedRows(result.unmatched, false),
    };
    for (const [name, rows] of Object.entries(files)) {
      writeFileSync(`${OUTPUT_DIR}/${name}`, toCsv(rows), "utf-8");
    }
    summary.files = Object.keys(files);
  }
  return summary;
}

function main(): void {
  try {
    const raw = readFileSync(0, "utf-8");
    const input = JSON.parse(raw) as Input;
    process.stdout.write(`${JSON.stringify(run(input))}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("main.ts")) {
  main();
}
