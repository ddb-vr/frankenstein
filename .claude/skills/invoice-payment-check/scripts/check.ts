import {
  columnIndex,
  formatAmount,
  formatDate,
  parseAmount,
  parseDate,
  toTable,
} from "./csv.ts";

const LEADING_ZEROS_RE = /^0+/;
const SPACES_RE = /\s+/g;
const IGNORED_TYPE_RE = /^(platba kartou|poplatek)/;

export interface Invoice {
  amount: number;
  currency: string;
  customer: string;
  dueDate: string;
  issueDate: string;
  number: string;
  payments: { amount: number; date: string; method: string }[];
  vs: string;
}

export interface Payment {
  amount: number;
  currency: string;
  date: string;
  ignored?: boolean;
  message: string;
  payer: string;
  vs: string;
}

export interface Flagged {
  candidate: string;
  payment: Payment;
  reason: string;
}

export interface Result {
  asOf: string;
  invoices: Invoice[];
  toCheck: Flagged[];
  unmatched: Flagged[];
}

const normName = (s: string): string =>
  s.trim().replace(SPACES_RE, " ").toLowerCase();
const normVs = (s: string): string => s.trim().replace(LEADING_ZEROS_RE, "");
const paidOf = (inv: Invoice): number =>
  inv.payments.reduce((sum, p) => sum + p.amount, 0);
const remaining = (inv: Invoice): number => inv.amount - paidOf(inv);

export function parseInvoices(text: string): Invoice[] {
  const table = toTable(text);
  const col = columnIndex(
    table,
    [
      "Číslo faktury",
      "VS",
      "Odběratel",
      "Datum vystavení",
      "Datum splatnosti",
      "Částka",
      "Měna",
    ],
    "invoices"
  );
  return table.rows.map((r) => {
    const get = (name: string): string => (r[col[name]] ?? "").trim();
    const number = get("Číslo faktury");
    return {
      amount: parseAmount(get("Částka"), `invoice ${number}`),
      currency: get("Měna").toUpperCase(),
      customer: get("Odběratel"),
      dueDate: parseDate(get("Datum splatnosti"), `invoice ${number}`),
      issueDate: parseDate(get("Datum vystavení"), `invoice ${number}`),
      number,
      payments: [],
      vs: get("VS"),
    };
  });
}

export function parseStatement(text: string): Payment[] {
  const table = toTable(text);
  const col = columnIndex(
    table,
    ["Datum", "Objem", "Měna", "Název protiúčtu", "VS", "Zpráva pro příjemce"],
    "statement"
  );
  const typeCol = table.header.indexOf("Typ");
  return table.rows.map((r, i) => {
    const get = (name: string): string => (r[col[name]] ?? "").trim();
    const type = typeCol >= 0 ? (r[typeCol] ?? "").trim().toLowerCase() : "";
    return {
      amount: parseAmount(get("Objem"), `statement row ${i + 2}`),
      currency: get("Měna").toUpperCase(),
      date: parseDate(get("Datum"), `statement row ${i + 2}`),
      ignored: IGNORED_TYPE_RE.test(type),
      message: get("Zpráva pro příjemce"),
      payer: get("Název protiúčtu"),
      vs: get("VS"),
    };
  });
}

const byAge = (a: Invoice, b: Invoice): number =>
  a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number);

function book(
  inv: Invoice,
  amount: number,
  payment: Payment,
  method: string
): void {
  inv.payments.push({ amount, date: payment.date, method });
}

function allocate(
  payment: Payment,
  target: Invoice,
  invoices: Invoice[],
  method: string
): void {
  let left = payment.amount;
  const first = Math.min(left, Math.max(remaining(target), 0));
  if (first > 0) {
    book(target, first, payment, method);
    left -= first;
  }
  if (left > 0) {
    const siblings = invoices
      .filter(
        (inv) =>
          inv !== target &&
          inv.customer === target.customer &&
          inv.currency === target.currency &&
          remaining(inv) > 0
      )
      .sort(byAge);
    const total = siblings.reduce((sum, inv) => sum + remaining(inv), 0);
    const message = payment.message.toUpperCase();
    const named = siblings.filter(
      (inv) => inv.number !== "" && message.includes(inv.number.toUpperCase())
    );
    const chosen = left === total ? siblings : named;
    for (const inv of chosen) {
      const part = Math.min(left, remaining(inv));
      if (part > 0) {
        book(inv, part, payment, method);
        left -= part;
      }
    }
  }
  if (left > 0) {
    book(target, left, payment, method);
  }
}

function pickOpen(list: Invoice[]): Invoice | undefined {
  const sorted = [...list].sort(byAge);
  return sorted.find((inv) => remaining(inv) > 0) ?? sorted[0];
}

function findByVs(payment: Payment, invoices: Invoice[]): Invoice[] {
  const vs = normVs(payment.vs);
  if (vs === "") {
    return [];
  }
  return invoices.filter((inv) => normVs(inv.vs) === vs);
}

function findByMessage(payment: Payment, invoices: Invoice[]): Invoice[] {
  const msg = payment.message.toUpperCase();
  if (msg === "") {
    return [];
  }
  return invoices.filter(
    (inv) => inv.number !== "" && msg.includes(inv.number.toUpperCase())
  );
}

type Outcome =
  | { kind: "matched"; invoice: Invoice; method: string }
  | { kind: "check"; candidate: string; reason: string }
  | { kind: "unmatched"; reason: string };

function matchByName(payment: Payment, invoices: Invoice[]): Outcome | null {
  const payer = normName(payment.payer);
  if (payer === "") {
    return null;
  }
  const named = invoices.filter((inv) => normName(inv.customer) === payer);
  if (named.length === 0) {
    return null;
  }
  const sameCurrency = named.filter((inv) => inv.currency === payment.currency);
  if (sameCurrency.length === 0) {
    return {
      kind: "unmatched",
      reason: `Currency ${payment.currency} differs from invoice currency ${named[0].currency}`,
    };
  }
  const exact = sameCurrency.filter(
    (inv) =>
      remaining(inv) > 0 &&
      (inv.amount === payment.amount || remaining(inv) === payment.amount)
  );
  const hit = pickOpen(exact);
  if (hit) {
    return { invoice: hit, kind: "matched", method: "name+amount" };
  }
  const candidate = pickOpen(sameCurrency) as Invoice;
  return {
    candidate: candidate.number,
    kind: "check",
    reason:
      "Payer name matches the customer but the amount differs and there is no variable symbol or invoice number",
  };
}

function classify(payment: Payment, invoices: Invoice[]): Outcome {
  const attempts: [string, Invoice[]][] = [
    ["variable symbol", findByVs(payment, invoices)],
    ["invoice number in message", findByMessage(payment, invoices)],
  ];
  for (const [method, found] of attempts) {
    const sameCurrency = found.filter(
      (inv) => inv.currency === payment.currency
    );
    const hit = pickOpen(sameCurrency);
    if (hit) {
      return { invoice: hit, kind: "matched", method };
    }
    if (found.length > 0) {
      return {
        kind: "unmatched",
        reason: `Currency ${payment.currency} differs from invoice currency ${found[0].currency}`,
      };
    }
  }
  const byName = matchByName(payment, invoices);
  if (byName) {
    return byName;
  }
  return {
    kind: "unmatched",
    reason:
      normVs(payment.vs) === ""
        ? "No matching invoice (no variable symbol, invoice number or known payer)"
        : `Unknown variable symbol ${payment.vs} and unknown payer`,
  };
}

export function reconcile(invoices: Invoice[], payments: Payment[]): Result {
  const asOf =
    payments
      .map((p) => p.date)
      .sort((a, b) => a.localeCompare(b))
      .at(-1) ?? "";
  const toCheck: Flagged[] = [];
  const unmatched: Flagged[] = [];
  const incoming = payments.filter((p) => p.amount > 0 && !p.ignored);
  for (const payment of incoming) {
    const outcome = classify(payment, invoices);
    if (outcome.kind === "matched") {
      allocate(payment, outcome.invoice, invoices, outcome.method);
    } else if (outcome.kind === "check") {
      toCheck.push({
        candidate: outcome.candidate,
        payment,
        reason: outcome.reason,
      });
    } else {
      unmatched.push({ candidate: "", payment, reason: outcome.reason });
    }
  }
  return { asOf, invoices, toCheck, unmatched };
}

export type Status = "paid" | "partly_paid" | "unpaid" | "overpaid";

export function statusOf(inv: Invoice): Status {
  const paid = paidOf(inv);
  if (paid === 0) {
    return "unpaid";
  }
  if (paid === inv.amount) {
    return "paid";
  }
  return paid > inv.amount ? "overpaid" : "partly_paid";
}

export function summarize(result: Result): Record<string, number | string> {
  const counts = { overpaid: 0, paid: 0, partly_paid: 0, unpaid: 0 };
  let overdue = 0;
  let totalOwed = 0;
  let overdueOwed = 0;
  for (const inv of result.invoices) {
    counts[statusOf(inv)] += 1;
    const missing = remaining(inv);
    if (missing > 0) {
      totalOwed += missing;
      if (inv.dueDate < result.asOf) {
        overdue += 1;
        overdueOwed += missing;
      }
    }
  }
  return {
    asOf: result.asOf,
    currency: result.invoices[0]?.currency ?? "",
    invoices: result.invoices.length,
    overdue,
    overdueOwed: overdueOwed / 100,
    overpaid: counts.overpaid,
    paid: counts.paid,
    partlyPaid: counts.partly_paid,
    toCheck: result.toCheck.length,
    totalOwed: totalOwed / 100,
    unmatchedPayments: result.unmatched.length,
    unpaid: counts.unpaid,
  };
}

export function statusRows(result: Result): string[][] {
  const rows = [
    [
      "Číslo faktury",
      "Odběratel",
      "Datum splatnosti",
      "Částka",
      "Stav",
      "Po splatnosti",
      "Zaplaceno",
      "Chybí / přeplatek",
      "Spárované platby",
    ],
  ];
  for (const inv of result.invoices) {
    const diff = remaining(inv);
    const overdue = diff > 0 && inv.dueDate < result.asOf;
    rows.push([
      inv.number,
      inv.customer,
      formatDate(inv.dueDate),
      formatAmount(inv.amount),
      statusOf(inv),
      overdue ? "yes" : "no",
      formatAmount(paidOf(inv)),
      formatAmount(Math.abs(diff)),
      inv.payments
        .map(
          (p) =>
            `${formatDate(p.date)} ${formatAmount(p.amount)} ${inv.currency} (${p.method})`
        )
        .join(" | "),
    ]);
  }
  return rows;
}

export function flaggedRows(
  items: Flagged[],
  withCandidate: boolean
): string[][] {
  const header = ["Datum", "Částka", "Měna", "Plátce", "VS", "Zpráva", "Důvod"];
  if (withCandidate) {
    header.push("Kandidátní faktura");
  }
  const rows = [header];
  for (const { candidate, payment, reason } of items) {
    const row = [
      formatDate(payment.date),
      formatAmount(payment.amount),
      payment.currency,
      payment.payer,
      payment.vs,
      payment.message,
      reason,
    ];
    if (withCandidate) {
      row.push(candidate);
    }
    rows.push(row);
  }
  return rows;
}
