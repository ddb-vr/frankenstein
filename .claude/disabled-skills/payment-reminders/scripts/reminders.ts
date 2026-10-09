const BOM = "﻿";
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CZ_DATE_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
const AMOUNT_RE = /^-?\d+(,\d+)?$/;
const NEWLINE_RE = /\r?\n/;
const SPACES_RE = /[\s ]/g;
const DIACRITICS_RE = /[̀-ͯ]/g;
const NON_ALNUM_RE = /[^a-z0-9]+/g;
const EDGE_DASH_RE = /^-+|-+$/g;
const CSV_SPECIAL_RE = /[;"\n]/;
const QUOTE_RE = /"/g;
const MS_PER_DAY = 86_400_000;

export const STATUS_COLUMNS = [
  "Číslo faktury",
  "Odběratel",
  "Datum splatnosti",
  "Částka",
  "Stav",
  "Po splatnosti",
  "Zaplaceno",
  "Chybí / přeplatek",
  "Spárované platby",
] as const;

export const CHECK_COLUMNS = [
  "Datum",
  "Částka",
  "Měna",
  "Plátce",
  "VS",
  "Zpráva",
  "Důvod",
  "Kandidátní faktura",
] as const;

export type Row = Record<string, string>;

export interface Invoice {
  customer: string;
  dueDate: string;
  missingCents: number;
  number: string;
  status: string;
}

export interface LateInvoice extends Invoice {
  daysLate: number;
}

export interface CheckItem {
  amount: string;
  candidate: string;
  customer: string;
  date: string;
  reason: string;
}

export interface Options {
  asOf?: string;
  bankAccount?: string;
  contact?: string;
  currency: string;
  senderCompany?: string;
  senderName?: string;
}

export interface CustomerReminder {
  customer: string;
  daysLate: number;
  invoices: LateInvoice[];
  missingCents: number;
}

function parseLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  while (i < line.length) {
    const ch = line.charAt(i);
    if (quoted && ch === '"' && line.charAt(i + 1) === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ";" && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
    i += 1;
  }
  cells.push(cell);
  return cells;
}

export function parseCsv(text: string): string[][] {
  const clean = text.startsWith(BOM) ? text.slice(1) : text;
  return clean
    .split(NEWLINE_RE)
    .filter((line) => line.trim() !== "")
    .map(parseLine);
}

export function readTable(
  text: string,
  required: readonly string[],
  label: string
): Row[] {
  const [header, ...body] = parseCsv(text);
  if (!header) {
    throw new Error(`${label} is empty`);
  }
  const names = header.map((h) => h.trim());
  for (const col of required) {
    if (!names.includes(col)) {
      throw new Error(`${label} lacks required column "${col}"`);
    }
  }
  return body.map((cells) => {
    const row: Row = {};
    names.forEach((name, idx) => {
      row[name] = (cells[idx] ?? "").trim();
    });
    return row;
  });
}

export function parseIsoDate(value: unknown, label: string): number {
  const m = typeof value === "string" ? ISO_RE.exec(value) : null;
  if (!m) {
    throw new Error(`${label} must be an ISO date YYYY-MM-DD`);
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d
  ) {
    throw new Error(`${label} is not a valid date`);
  }
  return ms;
}

export function parseCzDate(value: string): number {
  const m = CZ_DATE_RE.exec(value);
  if (!m) {
    throw new Error(`Cannot parse date "${value}"`);
  }
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  if (new Date(ms).getUTCDate() !== d) {
    throw new Error(`Cannot parse date "${value}"`);
  }
  return ms;
}

export function parseAmountCents(value: string): number {
  const v = value.replace(SPACES_RE, "");
  if (!AMOUNT_RE.test(v)) {
    throw new Error(`Cannot parse amount "${value}"`);
  }
  return Math.round(Number(v.replace(",", ".")) * 100);
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

function groupThousands(intPart: string): string {
  const sep = " ";
  let out = "";
  for (let i = 0; i < intPart.length; i += 1) {
    if (i > 0 && (intPart.length - i) % 3 === 0) {
      out += sep; // thousands separator is nbsp:" ";
    }
    out += intPart.charAt(i);
  }
  return out;
}

export function money(cents: number, currency: string): string {
  const [int, dec] = formatCents(cents).split(",");
  const unit = currency === "CZK" ? "Kč" : currency;
  return `${groupThousands(int ?? "0")},${dec} ${unit}`;
}

export function formatCzDate(ms: number): string {
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(DIACRITICS_RE, "")
    .toLowerCase()
    .replace(NON_ALNUM_RE, "-")
    .replace(EDGE_DASH_RE, "");
  return slug === "" ? "zakaznik" : slug;
}

export function readInvoices(rows: Row[]): Invoice[] {
  return rows.map((r) => {
    parseCzDate(r["Datum splatnosti"] ?? "");
    return {
      customer: r.Odběratel ?? "",
      dueDate: r["Datum splatnosti"] ?? "",
      missingCents: parseAmountCents(r["Chybí / přeplatek"] ?? ""),
      number: r["Číslo faktury"] ?? "",
      status: r.Stav ?? "",
    };
  });
}

export function readCheckItems(rows: Row[], invoices: Invoice[]): CheckItem[] {
  return rows.map((r) => {
    parseCzDate(r.Datum ?? "");
    parseAmountCents(r.Částka ?? "");
    const candidate = r["Kandidátní faktura"] ?? "";
    const payer = r.Plátce ?? "";
    const byInvoice = invoices.find((i) => i.number === candidate);
    const byName = invoices.find(
      (i) => payer !== "" && slugify(i.customer) === slugify(payer)
    );
    return {
      amount: r.Částka ?? "",
      candidate,
      customer: byInvoice?.customer ?? byName?.customer ?? payer,
      date: r.Datum ?? "",
      reason: r.Důvod ?? "",
    };
  });
}

export function findLate(
  invoices: Invoice[],
  todayMs: number,
  minDaysLate: number,
  heldBack: Set<string>
): CustomerReminder[] {
  const byCustomer = new Map<string, CustomerReminder>();
  for (const inv of invoices) {
    if (inv.status !== "unpaid" && inv.status !== "partly_paid") {
      continue;
    }
    if (heldBack.has(inv.customer)) {
      continue;
    }
    const daysLate = Math.round(
      (todayMs - parseCzDate(inv.dueDate)) / MS_PER_DAY
    );
    if (daysLate <= minDaysLate || inv.missingCents <= 0) {
      continue;
    }
    const entry = byCustomer.get(inv.customer) ?? {
      customer: inv.customer,
      daysLate: 0,
      invoices: [],
      missingCents: 0,
    };
    entry.invoices.push({ ...inv, daysLate });
    entry.missingCents += inv.missingCents;
    entry.daysLate = Math.max(entry.daysLate, daysLate);
    byCustomer.set(inv.customer, entry);
  }
  const list = [...byCustomer.values()];
  for (const c of list) {
    c.invoices.sort((a, b) => b.daysLate - a.daysLate);
  }
  return list.sort(
    (a, b) => b.daysLate - a.daysLate || a.customer.localeCompare(b.customer)
  );
}

export function buildReminder(c: CustomerReminder, o: Options): string {
  const cur = o.currency;
  const lines = [
    "Věc: Upomínka k neuhrazeným fakturám",
    "",
    "Dobrý den,",
    "",
    `dovolujeme si Vás upozornit, že u společnosti ${c.customer} evidujeme následující faktury po splatnosti:`,
    "",
  ];
  for (const i of c.invoices) {
    lines.push(
      `- faktura ${i.number}, splatnost ${i.dueDate}, po splatnosti ${i.daysLate} dní, chybí uhradit ${money(i.missingCents, cur)}`
    );
  }
  lines.push(
    "",
    `Celkem k úhradě: ${money(c.missingCents, cur)}`,
    "",
    "Prosíme o úhradu pouze chybějící částky; již zaplacené částky není třeba platit znovu.",
    `Platbu prosím zašlete na účet ${o.bankAccount ?? "[číslo účtu]"}.`
  );
  if (o.asOf) {
    lines.push(
      `Platby přijaté po ${formatCzDate(parseIsoDate(o.asOf, "asOf"))} nejsou v tomto přehledu zahrnuty.`
    );
  }
  lines.push(
    "",
    "Pokud jste platbu již odeslali, považujte prosím tuto upomínku za bezpředmětnou.",
    "",
    "S pozdravem",
    o.senderName ?? "[Vaše jméno]"
  );
  if (o.senderCompany) {
    lines.push(o.senderCompany);
  }
  lines.push(o.contact ?? "[kontakt]", "");
  return lines.join("\n");
}

function csvCell(v: string): string {
  return CSV_SPECIAL_RE.test(v) ? `"${v.replace(QUOTE_RE, '""')}"` : v;
}

function toCsv(rows: string[][]): string {
  return `${BOM}${rows.map((r) => r.map(csvCell).join(";")).join("\r\n")}\r\n`;
}

export function buildOverview(list: CustomerReminder[]): string {
  return toCsv([
    ["Odběratel", "Počet faktur", "Chybí", "Dnů po splatnosti"],
    ...list.map((c) => [
      c.customer,
      String(c.invoices.length),
      formatCents(c.missingCents),
      String(c.daysLate),
    ]),
  ]);
}

export function buildManualCheck(items: CheckItem[]): string {
  return toCsv([
    ["Odběratel", "Kandidátní faktura", "Datum platby", "Částka", "Důvod"],
    ...items.map((i) => [i.customer, i.candidate, i.date, i.amount, i.reason]),
  ]);
}
