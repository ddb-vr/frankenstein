export interface Customer {
  email: string;
  last_purchase: string;
  name: string;
  orders: number;
  total_czk: number;
}

export interface Summary {
  lapsed_customers: number;
  orders_skipped: number;
  output_file: string | null;
  top_lapsed_customers: Customer[];
  total_spend_czk: number;
}

export interface Analysis {
  lapsed: Customer[];
  summary: Summary;
}

interface Totals {
  byEmail: Map<string, Customer>;
  skipped: number;
}

const REQUIRED_COLUMNS = [
  "customer_email",
  "customer_name",
  "date",
  "status",
  "total_czk",
] as const;
const TOP_LIMIT = 5;
const MS_PER_DAY = 86_400_000;
const AMOUNT_PATTERN = /^-?\d+(\.\d+)?$/;
const WHITESPACE_PATTERN = /[\s  ]/g;
const BOM_PATTERN = /^﻿/;
const CSV_SPECIAL_PATTERN = /[;"\n\r]/;
const LINE_BREAK_PATTERN = /\r\n|\r|\n/;
const CZ_DATE_PATTERN = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const OUTPUT_FILE = "lapsed-customers.csv";

export const round2 = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

export const parseAmount = (raw: string): number | null => {
  const cleaned = raw.replace(WHITESPACE_PATTERN, "").replace(",", ".");
  if (!AMOUNT_PATTERN.test(cleaned)) {
    return null;
  }
  return Number(cleaned);
};

const buildIso = (year: number, month: number, day: number): string | null => {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d.toISOString().slice(0, 10);
};

export const parseCzDate = (raw: string): string | null => {
  const m = CZ_DATE_PATTERN.exec(raw.trim());
  if (!m) {
    return null;
  }
  return buildIso(Number(m[3]), Number(m[2]), Number(m[1]));
};

export const parseIsoDate = (raw: string): string | null => {
  const m = ISO_DATE_PATTERN.exec(raw.trim());
  if (!m) {
    return null;
  }
  return buildIso(Number(m[1]), Number(m[2]), Number(m[3]));
};

export const windowStart = (referenceIso: string, days: number): string => {
  const ms = Date.parse(`${referenceIso}T00:00:00Z`) - days * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
};

export const isoToCz = (iso: string): string => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

export const parseLine = (line: string, separator = ";"): string[] => {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (quoted) {
      if (ch === '"' && line.charAt(i + 1) === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === separator) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
};

const compareCustomers = (a: Customer, b: Customer): number => {
  if (a.total_czk !== b.total_czk) {
    return b.total_czk - a.total_czk;
  }
  if (a.email < b.email) {
    return -1;
  }
  return a.email > b.email ? 1 : 0;
};

const cell = (fields: string[], position: number): string =>
  fields.at(position) ?? "";

const findColumns = (header: string[]): Record<string, number> => {
  const index: Record<string, number> = {};
  for (const column of REQUIRED_COLUMNS) {
    const position = header.indexOf(column);
    if (position === -1) {
      throw new Error(`Missing required column: ${column}`);
    }
    index[column] = position;
  }
  return index;
};

const addRow = (
  totals: Totals,
  fields: string[],
  index: Record<string, number>,
  referenceIso: string
): void => {
  const status = cell(fields, index.status).trim().toLowerCase();
  if (status !== "completed") {
    return;
  }
  const email = cell(fields, index.customer_email).trim().toLowerCase();
  const amount = parseAmount(cell(fields, index.total_czk));
  const date = parseCzDate(cell(fields, index.date));
  if (email === "" || amount === null || date === null) {
    totals.skipped += 1;
    return;
  }
  if (date > referenceIso) {
    return;
  }
  const existing = totals.byEmail.get(email);
  if (existing) {
    existing.orders += 1;
    existing.total_czk += amount;
    if (date > existing.last_purchase) {
      existing.last_purchase = date;
    }
    return;
  }
  totals.byEmail.set(email, {
    email,
    last_purchase: date,
    name: cell(fields, index.customer_name).trim(),
    orders: 1,
    total_czk: amount,
  });
};

export const analyze = (
  text: string,
  referenceIso: string,
  days: number
): Analysis => {
  const lines = text
    .replace(BOM_PATTERN, "")
    .split(LINE_BREAK_PATTERN)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error("The file is empty (no header).");
  }
  const header = parseLine(lines[0] ?? "").map((h) => h.trim());
  const index = findColumns(header);
  const totals: Totals = { byEmail: new Map(), skipped: 0 };
  for (const line of lines.slice(1)) {
    addRow(totals, parseLine(line), index, referenceIso);
  }

  const start = windowStart(referenceIso, days);
  const lapsed = [...totals.byEmail.values()]
    .filter((c) => c.last_purchase < start)
    .map((c) => ({ ...c, total_czk: round2(c.total_czk) }))
    .sort(compareCustomers);
  const spend = lapsed.reduce((sum, c) => sum + c.total_czk, 0);

  return {
    lapsed,
    summary: {
      lapsed_customers: lapsed.length,
      orders_skipped: totals.skipped,
      output_file: lapsed.length === 0 ? null : OUTPUT_FILE,
      top_lapsed_customers: lapsed.slice(0, TOP_LIMIT),
      total_spend_czk: round2(spend),
    },
  };
};

const csvField = (value: string): string =>
  CSV_SPECIAL_PATTERN.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export const toCsv = (lapsed: Customer[]): string => {
  const rows = ["name;email;last_purchase;orders;total_czk"];
  for (const c of lapsed) {
    const total = String(c.total_czk).replace(".", ",");
    rows.push(
      `${csvField(c.name)};${csvField(c.email)};${isoToCz(c.last_purchase)};${c.orders};${total}`
    );
  }
  return `﻿${rows.join("\r\n")}\r\n`;
};
