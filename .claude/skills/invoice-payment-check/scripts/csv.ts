const BOM = "﻿";
const SPACES_RE = /[\s ]/g;
const AMOUNT_RE = /^-?\d+(\.\d+)?$/;
const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/;
const SPECIAL_RE = /[;"\n\r]/;
const CENTS = 100;
const MAX_MONTH = 12;

export interface Table {
  header: string[];
  rows: string[][];
}

export function parseCsv(text: string, separator = ";"): string[][] {
  const src = text.startsWith(BOM) ? text.slice(1) : text;
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRecord = () => {
    row.push(field);
    field = "";
    if (row.length > 1 || row[0].trim() !== "") {
      records.push(row);
    }
    row = [];
  };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === separator) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      endRecord();
    } else if (ch !== "\r") {
      field += ch;
    }
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    endRecord();
  }
  return records;
}

export function toTable(text: string): Table {
  const records = parseCsv(text);
  const [header = [], ...rows] = records;
  return { header: header.map((h) => h.trim()), rows };
}

export function columnIndex(
  table: Table,
  required: string[],
  label: string
): Record<string, number> {
  const out: Record<string, number> = {};
  const missing: string[] = [];
  for (const name of required) {
    const idx = table.header.indexOf(name);
    if (idx < 0) {
      missing.push(name);
    }
    out[name] = idx;
  }
  if (missing.length > 0) {
    throw new Error(`${label}: missing column(s) ${missing.join(", ")}`);
  }
  return out;
}

/** Parses a Czech amount ("18 150,00") into integer cents. */
export function parseAmount(raw: string, what: string): number {
  const cleaned = raw.replace(SPACES_RE, "").replace(",", ".");
  if (!AMOUNT_RE.test(cleaned)) {
    throw new Error(`Cannot parse amount "${raw}" (${what})`);
  }
  return Math.round(Number(cleaned) * CENTS);
}

/** Parses DD.MM.YYYY into ISO YYYY-MM-DD. */
export function parseDate(raw: string, what: string): string {
  const m = DATE_RE.exec(raw.trim());
  if (!m) {
    throw new Error(`Cannot parse date "${raw}" (${what})`);
  }
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  const valid =
    day >= 1 &&
    month >= 1 &&
    month <= MAX_MONTH &&
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day;
  if (!valid) {
    throw new Error(`Cannot parse date "${raw}" (${what})`);
  }
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

export function formatAmount(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / CENTS);
  const frac = String(abs % CENTS).padStart(2, "0");
  return `${sign}${whole},${frac}`;
}

export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export function csvCell(value: string): string {
  if (SPECIAL_RE.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

export function toCsv(rows: string[][]): string {
  return `${BOM}${rows.map((r) => r.map(csvCell).join(";")).join("\r\n")}\r\n`;
}
