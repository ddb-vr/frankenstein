import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseInvoices,
  parseStatement,
  reconcile,
  statusOf,
  summarize,
} from "../scripts/check.ts";
import {
  formatAmount,
  parseAmount,
  parseCsv,
  parseDate,
  toCsv,
} from "../scripts/csv.ts";
import { run } from "../scripts/main.ts";

const CURRENCY_EUR_RE = /Currency EUR/;
const INV_HEADER =
  "Číslo faktury;VS;Odběratel;IČO;E-mail;Datum vystavení;Datum splatnosti;Částka;Měna";
const ST_HEADER =
  "Datum;Objem;Měna;Protiúčet;Kód banky;Název protiúčtu;VS;KS;SS;Zpráva pro příjemce;Typ";

const inv = (n: string, vs: string, who: string, issue: string, amt: string) =>
  `${n};${vs};${who};1;a@b;${issue};30.09.2026;${amt};CZK`;
const pay = (
  date: string,
  amt: string,
  who: string,
  vs: string,
  msg: string,
  cur = "CZK"
) => `${date};${amt};${cur};1;0100;${who};${vs};;;${msg};Bezhotovostní příjem`;

function go(invoices: string[], payments: string[]) {
  const result = reconcile(
    parseInvoices([INV_HEADER, ...invoices].join("\n")),
    parseStatement([ST_HEADER, ...payments].join("\n"))
  );
  return result;
}

test("csv helpers", () => {
  assert.equal(parseAmount("18 150,00", "x"), 1_815_000);
  assert.equal(parseAmount("-1290,5", "x"), -129_050);
  assert.throws(() => parseAmount("abc", "x"));
  assert.equal(parseDate("3.8.2026", "x"), "2026-08-03");
  assert.throws(() => parseDate("2026-08-03", "x"));
  assert.equal(formatAmount(-1250), "-12,50");
  assert.deepEqual(parseCsv('a;"b;""c""";d\r\n\r\ne;;f'), [
    ["a", 'b;"c"', "d"],
    ["e", "", "f"],
  ]);
  assert.ok(toCsv([["a;b"]]).startsWith('﻿"a;b"'));
});

test("part payments with same VS are summed", () => {
  const r = go(
    [inv("F1", "11", "Acme", "01.09.2026", "1000,00")],
    [
      pay("02.09.2026", "400,00", "Acme", "11", ""),
      pay("03.09.2026", "100,00", "Acme", "11", ""),
    ]
  );
  assert.equal(statusOf(r.invoices[0]), "partly_paid");
  assert.equal(summarize(r).totalOwed, 500);
});

test("wrong VS but invoice number in message", () => {
  const r = go(
    [inv("FV-1", "11", "Acme", "01.09.2026", "1000,00")],
    [pay("02.09.2026", "1000,00", "X", "99", "Úhrada FV-1")]
  );
  assert.equal(statusOf(r.invoices[0]), "paid");
  assert.equal(r.invoices[0].payments[0].method, "invoice number in message");
});

test("name plus exact amount without symbols", () => {
  const r = go(
    [inv("F1", "11", "Acme s.r.o.", "01.09.2026", "1000,00")],
    [pay("02.09.2026", "1000,00", "ACME s.r.o.", "", "")]
  );
  assert.equal(statusOf(r.invoices[0]), "paid");
});

test("same name different amount goes to check", () => {
  const r = go(
    [inv("F1", "11", "Acme", "01.09.2026", "1000,00")],
    [pay("02.09.2026", "900,00", "Acme", "", "Platba")]
  );
  assert.equal(r.toCheck.length, 1);
  assert.equal(r.toCheck[0].candidate, "F1");
  assert.equal(statusOf(r.invoices[0]), "unpaid");
});

test("overpayment and unknown payer and foreign currency", () => {
  const r = go(
    [inv("F1", "11", "Acme", "01.09.2026", "1000,00")],
    [
      pay("02.09.2026", "1200,00", "Acme", "11", ""),
      pay("03.09.2026", "5,00", "Who", "77", "Dar"),
      pay("04.09.2026", "1000,00", "Acme", "11", "", "EUR"),
      pay("05.09.2026", "-50,00", "Fee", "", "Poplatek"),
    ]
  );
  assert.equal(statusOf(r.invoices[0]), "overpaid");
  assert.equal(r.unmatched.length, 2);
  assert.match(r.unmatched[1].reason, CURRENCY_EUR_RE);
  assert.equal(r.asOf, "2026-09-05");
  const s = summarize(r);
  assert.equal(s.overpaid, 1);
  assert.equal(s.totalOwed, 0);
});

test("one payment covers several invoices, oldest first", () => {
  const r = go(
    [
      inv("F2", "12", "Acme", "10.09.2026", "500,00"),
      inv("F1", "11", "Acme", "01.09.2026", "1000,00"),
    ],
    [pay("15.09.2026", "1500,00", "Acme", "12", "")]
  );
  const [f2, f1] = r.invoices;
  assert.equal(statusOf(f1), "paid");
  assert.equal(statusOf(f2), "paid");
});

test("matched newer invoice is paid first, surplus overpays it", () => {
  const r = go(
    [
      inv("F1", "11", "Acme", "01.09.2026", "1000,00"),
      inv("F2", "12", "Acme", "10.09.2026", "500,00"),
    ],
    [pay("15.09.2026", "1000,00", "Acme", "12", "")]
  );
  assert.equal(statusOf(r.invoices[1]), "overpaid");
  assert.equal(statusOf(r.invoices[0]), "unpaid");
});

test("small overpayment stays on the target invoice", () => {
  const r = go(
    [
      inv("F1", "11", "Acme", "01.09.2026", "1000,00"),
      inv("F2", "12", "Acme", "10.09.2026", "500,00"),
    ],
    [pay("15.09.2026", "600,00", "Acme", "12", "")]
  );
  assert.equal(statusOf(r.invoices[1]), "overpaid");
  assert.equal(statusOf(r.invoices[0]), "unpaid");
});

test("card and fee rows are ignored, impossible dates rejected", () => {
  const r = go(
    [inv("F1", "11", "Acme", "01.09.2026", "1000,00")],
    [
      "02.09.2026;50,00;CZK;1;0100;Shop;;;;Vratka;Platba kartou",
      "02.09.2026;5,00;CZK;1;0100;Bank;;;;Vraceni;Poplatek",
    ]
  );
  assert.equal(r.unmatched.length, 0);
  assert.throws(() => parseDate("31.02.2026", "x"));
});

test("overdue counted against last statement date", () => {
  const r = go(
    [inv("F1", "11", "Acme", "01.09.2026", "1000,00")],
    [pay("01.10.2026", "5,00", "Z", "", "")]
  );
  const s = summarize(r);
  assert.equal(s.overdue, 1);
  assert.equal(s.overdueOwed, 1000);
});

function encodeCp1250(text: string): Buffer {
  const decoder = new TextDecoder("windows-1250");
  const table = new Map<string, number>();
  for (let b = 0; b < 256; b += 1) {
    table.set(decoder.decode(Uint8Array.of(b)), b);
  }
  return Buffer.from([...text].map((ch) => table.get(ch) ?? 0x3f));
}

test("run decodes windows-1250 and reports errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "ipc-"));
  const st = join(dir, "st.csv");
  const iv = join(dir, "iv.csv");
  writeFileSync(
    st,
    encodeCp1250(
      `${ST_HEADER}\n02.09.2026;1000,00;CZK;1;0100;Příliš žluťoučký;;;;x;t\n`
    )
  );
  writeFileSync(
    iv,
    `${INV_HEADER}\n${inv("F1", "11", "Příliš žluťoučký", "01.09.2026", "1000,00")}\n`
  );
  assert.throws(() =>
    run({ invoices: iv, statement: st, statementEncoding: "nope" })
  );
  const out = run({
    invoices: iv,
    statement: st,
    statementEncoding: "windows-1250",
  });
  assert.equal(out.paid, 1);
  assert.throws(() => run({ invoices: iv }));
  assert.throws(() => run({ invoices: iv, statement: join(dir, "none") }));
  assert.throws(() => run({ invoices: st, statement: iv }));
});
