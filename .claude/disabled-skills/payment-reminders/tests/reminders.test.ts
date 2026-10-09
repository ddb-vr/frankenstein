import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildManualCheck,
  buildOverview,
  buildReminder,
  CHECK_COLUMNS,
  findLate,
  formatCents,
  money,
  parseAmountCents,
  parseCsv,
  parseIsoDate,
  readCheckItems,
  readInvoices,
  readTable,
  STATUS_COLUMNS,
  slugify,
} from "../scripts/reminders.ts";

const INV_RE = /FV-2026-104/;
const ACCOUNT_PLACEHOLDER_RE = /\[číslo účtu\]/;
const ASOF_RE = /30\.09\.2026/;
const ACCOUNT_RE = /123\/0100/;
const EUR_RE = /EUR/;
const NAME_PLACEHOLDER_RE = /\[Vaše jméno\]/;
const OVERVIEW_RE = /^﻿Odběratel;/;
const CHECK_RE = /FV-2026-108/;

const dir = new URL("../fixtures/input/", import.meta.url);
const read = (n: string) => readFileSync(new URL(n, dir), "utf-8");
const invoices = readInvoices(
  readTable(read("invoice-status.csv"), STATUS_COLUMNS, "s")
);
const checks = readCheckItems(
  readTable(read("to-check.csv"), CHECK_COLUMNS, "c"),
  invoices
);

test("slugify strips diacritics", () => {
  assert.equal(slugify("Beta Dílna s.r.o."), "beta-dilna-s-r-o");
});

test("amounts and dates", () => {
  assert.equal(parseAmountCents("10 000,50"), 1_000_050);
  assert.equal(formatCents(500), "5,00");
  assert.equal(money(1_000_000, "CZK"), "10 000,00 Kč");
  assert.throws(() => parseAmountCents("abc"));
  assert.throws(() => parseIsoDate("09.10.2026", "today"));
  assert.throws(() => parseIsoDate("2026-02-30", "today"));
});

test("parseCsv handles BOM and quotes", () => {
  assert.deepEqual(parseCsv('﻿a;"b;c"\r\n1;2\n'), [
    ["a", "b;c"],
    ["1", "2"],
  ]);
});

test("readTable rejects missing column", () => {
  assert.throws(() => readTable(read("to-check.csv"), STATUS_COLUMNS, "x"));
});

test("late logic with threshold and hold back", () => {
  const held = new Set(checks.map((c) => c.customer));
  assert.deepEqual([...held], ["Zeta Kavárna s.r.o."]);
  const today = parseIsoDate("2026-10-09", "t");
  const late = findLate(invoices, today, 30, held);
  assert.equal(late.length, 2);
  assert.equal(late[0]?.customer, "Alfa Stavby s.r.o.");
  assert.equal(late[0]?.missingCents, 2_400_000);
  assert.equal(
    findLate(invoices, parseIsoDate("2026-10-29", "t"), 30, held).length,
    2
  );
  assert.equal(
    findLate(invoices, parseIsoDate("2026-10-30", "t"), 30, held).length,
    3
  );
});

test("reminder text and csvs", () => {
  const late = findLate(
    invoices,
    parseIsoDate("2026-10-09", "t"),
    30,
    new Set()
  );
  const beta = late.find((c) => c.customer.startsWith("Beta"));
  assert.ok(beta);
  const text = buildReminder(beta, { asOf: "2026-09-30", currency: "CZK" });
  assert.match(text, INV_RE);
  assert.match(text, ACCOUNT_PLACEHOLDER_RE);
  assert.match(text, ASOF_RE);
  const signed = buildReminder(beta, {
    bankAccount: "123/0100",
    currency: "EUR",
    senderName: "Jana",
  });
  assert.match(signed, ACCOUNT_RE);
  assert.match(signed, EUR_RE);
  assert.doesNotMatch(signed, NAME_PLACEHOLDER_RE);
  assert.match(buildOverview(late), OVERVIEW_RE);
  assert.match(buildManualCheck(checks), CHECK_RE);
});
