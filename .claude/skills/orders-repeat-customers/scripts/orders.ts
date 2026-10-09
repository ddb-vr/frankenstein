export interface Customer {
  email: string;
  name: string;
  orders: number;
  total_czk: number;
}

export interface Summary {
  average_order_value_czk: number | null;
  customers: number;
  orders_cancelled: number;
  orders_counted: number;
  orders_skipped: number;
  output_file: string;
  repeat_customers: number;
  top_repeat_customers: Customer[];
}

export interface Analysis {
  repeat: Customer[];
  summary: Summary;
}

interface Totals {
  byEmail: Map<string, Customer>;
  cancelled: number;
  counted: number;
  skipped: number;
  sum: number;
}

const REQUIRED_COLUMNS = [
  "customer_email",
  "customer_name",
  "total_czk",
  "status",
] as const;
const TOP_LIMIT = 5;
const AMOUNT_PATTERN = /^-?\d+(\.\d+)?$/;
const WHITESPACE_PATTERN = /[\s  ]/g;
const BOM_PATTERN = /^﻿/;
const CSV_SPECIAL_PATTERN = /[;"\n\r]/;
const LINE_BREAK_PATTERN = /\r\n|\r|\n/;
export const OUTPUT_FILE = "repeat-customers.csv";

export const round2 = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

export const parseAmount = (raw: string): number | null => {
  const cleaned = raw.replace(WHITESPACE_PATTERN, "").replace(",", ".");
  if (!AMOUNT_PATTERN.test(cleaned)) {
    return null;
  }
  return Number(cleaned);
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
  if (a.orders !== b.orders) {
    return b.orders - a.orders;
  }
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
  index: Record<string, number>
): void => {
  const status = cell(fields, index.status).trim().toLowerCase();
  if (status === "cancelled") {
    totals.cancelled += 1;
    return;
  }
  const email = cell(fields, index.customer_email).trim().toLowerCase();
  const amount = parseAmount(cell(fields, index.total_czk));
  if (email === "" || amount === null) {
    totals.skipped += 1;
    return;
  }
  totals.counted += 1;
  totals.sum += amount;
  const existing = totals.byEmail.get(email);
  if (existing) {
    existing.orders += 1;
    existing.total_czk += amount;
    return;
  }
  totals.byEmail.set(email, {
    email,
    name: cell(fields, index.customer_name).trim(),
    orders: 1,
    total_czk: amount,
  });
};

export const analyze = (text: string): Analysis => {
  const lines = text
    .replace(BOM_PATTERN, "")
    .split(LINE_BREAK_PATTERN)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    throw new Error("The file is empty (no header).");
  }
  const header = parseLine(lines[0] ?? "").map((h) => h.trim());
  const index = findColumns(header);
  const totals: Totals = {
    byEmail: new Map(),
    cancelled: 0,
    counted: 0,
    skipped: 0,
    sum: 0,
  };
  for (const line of lines.slice(1)) {
    addRow(totals, parseLine(line), index);
  }

  const repeat = [...totals.byEmail.values()]
    .filter((c) => c.orders >= 2)
    .map((c) => ({ ...c, total_czk: round2(c.total_czk) }))
    .sort(compareCustomers);

  return {
    repeat,
    summary: {
      average_order_value_czk:
        totals.counted === 0 ? null : round2(totals.sum / totals.counted),
      customers: totals.byEmail.size,
      orders_cancelled: totals.cancelled,
      orders_counted: totals.counted,
      orders_skipped: totals.skipped,
      output_file: OUTPUT_FILE,
      repeat_customers: repeat.length,
      top_repeat_customers: repeat.slice(0, TOP_LIMIT),
    },
  };
};

const csvField = (value: string): string =>
  CSV_SPECIAL_PATTERN.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export const toCsv = (repeat: Customer[]): string => {
  const rows = ["name;email;orders;total_czk"];
  for (const c of repeat) {
    const total = String(c.total_czk).replace(".", ",");
    rows.push(`${csvField(c.name)};${csvField(c.email)};${c.orders};${total}`);
  }
  return `﻿${rows.join("\r\n")}\r\n`;
};
