import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyze,
  parseAmount,
  parseCzDate,
  parseIsoDate,
  parseLine,
  toCsv,
  windowStart,
} from "../scripts/orders.ts";

const HEADER = "order_id;date;customer_email;customer_name;total_czk;status";

test("parseAmount handles thousands and decimal comma", () => {
  assert.equal(parseAmount("1 250,00"), 1250);
  assert.equal(parseAmount("abc"), null);
});

test("parseLine handles quotes", () => {
  assert.deepEqual(parseLine('a;"b;c";"d""e"'), ["a", "b;c", 'd"e']);
});

test("date helpers", () => {
  assert.equal(parseCzDate("09.08.2026"), "2026-08-09");
  assert.equal(parseCzDate("31.02.2026"), null);
  assert.equal(parseIsoDate("2026-13-45"), null);
  assert.equal(parseIsoDate("2026-10-09"), "2026-10-09");
  assert.equal(windowStart("2026-10-09", 60), "2026-08-10");
});

test("analyze applies boundary, skips and cancellations", () => {
  const text = [
    HEADER,
    "1;09.08.2026;A@x.cz;Anna;100,00;completed",
    "2;01.01.2026;a@x.cz;Other;200,00;completed",
    "3;10.08.2026;b@x.cz;Ben;50,00;completed",
    "4;01.01.2026;c@x.cz;Cec;50,00;completed",
    "5;05.10.2026;c@x.cz;Cec;50,00;cancelled",
    "6;01.01.2026;;No;50,00;completed",
    "7;31.02.2026;d@x.cz;D;50,00;completed",
    "8;01.01.2026;e@x.cz;E;zz;completed",
    "9;01.01.2026;f@x.cz;F;5,00;cancelled",
  ].join("\n");
  const { lapsed, summary } = analyze(text, "2026-10-09", 60);
  assert.equal(summary.orders_skipped, 3);
  assert.equal(summary.lapsed_customers, 2);
  assert.equal(summary.total_spend_czk, 350);
  assert.deepEqual(lapsed[0], {
    email: "a@x.cz",
    last_purchase: "2026-08-09",
    name: "Anna",
    orders: 2,
    total_czk: 300,
  });
});

test("analyze empty result and errors", () => {
  const { summary } = analyze(HEADER, "2026-10-09", 60);
  assert.equal(summary.output_file, null);
  assert.throws(() => analyze("", "2026-10-09", 60));
  assert.throws(() => analyze("order_id;date", "2026-10-09", 60));
});

test("toCsv writes BOM, cz date and decimal comma", () => {
  const csv = toCsv([
    {
      email: "a@x.cz",
      last_purchase: "2026-08-09",
      name: "A",
      orders: 2,
      total_czk: 10.5,
    },
  ]);
  assert.ok(csv.startsWith("﻿name;email;last_purchase;orders;total_czk"));
  assert.ok(csv.includes("A;a@x.cz;09.08.2026;2;10,5"));
});
