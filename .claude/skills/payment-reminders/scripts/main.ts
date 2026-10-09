import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildManualCheck,
  buildOverview,
  buildReminder,
  CHECK_COLUMNS,
  findLate,
  type Options,
  parseIsoDate,
  readCheckItems,
  readInvoices,
  readTable,
  STATUS_COLUMNS,
  slugify,
} from "./reminders.ts";

const OUTPUT_DIR = "/output";
const DEFAULT_MIN_DAYS = 30;

type Input = Record<string, unknown>;

function str(input: Input, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v !== "" ? v : undefined;
}

function readFile(path: unknown, label: string, encoding: string): string {
  if (typeof path !== "string" || path === "") {
    throw new Error(`${label} is required`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (cause) {
    throw new Error(`${label} cannot be read: ${path}`, { cause });
  }
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
    bytes
  );
}

function writeOutputs(
  late: ReturnType<typeof findLate>,
  checks: ReturnType<typeof readCheckItems>,
  options: Options
): string[] {
  const files: string[] = [];
  if (late.length > 0) {
    mkdirSync(join(OUTPUT_DIR, "reminders"), { recursive: true });
  }
  const used = new Set<string>();
  for (const c of late) {
    let slug = slugify(c.customer);
    while (used.has(slug)) {
      slug = `${slug}-2`;
    }
    used.add(slug);
    const name = `reminders/${slug}.txt`;
    writeFileSync(join(OUTPUT_DIR, name), buildReminder(c, options));
    files.push(name);
  }
  writeFileSync(join(OUTPUT_DIR, "overview.csv"), buildOverview(late));
  writeFileSync(join(OUTPUT_DIR, "manual-check.csv"), buildManualCheck(checks));
  files.push("overview.csv", "manual-check.csv");
  return files;
}

function run(input: Input): Record<string, unknown> {
  const todayMs = parseIsoDate(input.today, "today");
  if (input.asOf !== undefined && input.asOf !== null) {
    parseIsoDate(input.asOf, "asOf");
  }
  const minDays = input.minDaysLate ?? DEFAULT_MIN_DAYS;
  if (typeof minDays !== "number" || !Number.isFinite(minDays) || minDays < 0) {
    throw new Error("minDaysLate must be a non-negative number");
  }
  const encoding = str(input, "encoding") ?? "utf-8";
  const currency = str(input, "currency") ?? "CZK";
  const invoices = readInvoices(
    readTable(
      readFile(input.invoiceStatus, "invoiceStatus", encoding),
      STATUS_COLUMNS,
      "invoiceStatus"
    )
  );
  const checks = readCheckItems(
    readTable(
      readFile(input.toCheck, "toCheck", encoding),
      CHECK_COLUMNS,
      "toCheck"
    ),
    invoices
  );
  const heldBack = new Set(checks.map((c) => c.customer));
  const late = findLate(invoices, todayMs, minDays, heldBack);
  const options: Options = {
    asOf: str(input, "asOf"),
    bankAccount: str(input, "bankAccount"),
    contact: str(input, "contact"),
    currency,
    senderCompany: str(input, "senderCompany"),
    senderName: str(input, "senderName"),
  };
  const files = existsSync(OUTPUT_DIR)
    ? writeOutputs(late, checks, options)
    : [];
  const totalCents = late.reduce((s, c) => s + c.missingCents, 0);
  return {
    currency,
    customersToRemind: late.length,
    files,
    invoicesToRemind: late.reduce((s, c) => s + c.invoices.length, 0),
    manualCheck: heldBack.size,
    today: input.today,
    totalMissing: totalCents / 100,
  };
}

function main(): void {
  try {
    const input: unknown = JSON.parse(readFileSync(0, "utf-8"));
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("Input must be a JSON object");
    }
    process.stdout.write(`${JSON.stringify(run(input as Input))}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
}

main();
