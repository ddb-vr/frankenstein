import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyze,
  parseAmount,
  parseLine,
  round2,
  toCsv,
} from "../scripts/orders.ts";

const HEADER = "order_id;date;customer_email;customer_name;total_czk;status";

test("parseAmount handles thousands and decimal comma", () => {
  assert.equal(parseAmount("1 250,00"), 1250);
  assert.equal(parseAmount("1 250,5"), 1250.5);
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount(""), null);
});

test("parseLine handles quotes", () => {
  assert.deepEqual(parseLine('a;"b;c";"d""e"'), ["a", "b;c", 'd"e']);
});

test("round2 rounds", () => {
  assert.equal(round2(871.428_57), 871.43);
});

test("analyze counts, skips and cancels", () => {
  const text = [
    HEADER,
    "1;x;A@x.cz ;Anna;100,00;completed",
    "",
    "2;x;a@x.cz;Other;200,00;completed",
    "3;x;b@x.cz;Ben;50,00;cancelled",
    "4;x;b@x.cz;Ben;50,00;completed",
    "5;x;;Nomail;50,00;completed",
    "6;x;c@x.cz;C;zzz;completed",
  ].join("\n");
  const { repeat, summary } = analyze(text);
  assert.equal(summary.orders_counted, 3);
  assert.equal(summary.orders_cancelled, 1);
  assert.equal(summary.orders_skipped, 2);
  assert.equal(summary.customers, 2);
  assert.equal(summary.repeat_customers, 1);
  assert.equal(summary.average_order_value_czk, 116.67);
  assert.deepEqual(repeat, [
    { email: "a@x.cz", name: "Anna", orders: 2, total_czk: 300 },
  ]);
});

test("analyze errors and null average", () => {
  assert.throws(() => analyze(""));
  assert.throws(() => analyze("order_id;total_czk\n1;2"));
  const { summary } = analyze(`${HEADER}\n1;x;a@x.cz;A;1;cancelled`);
  assert.equal(summary.average_order_value_czk, null);
});

test("toCsv writes BOM and decimal comma", () => {
  const csv = toCsv([
    { email: "a@x.cz", name: "A", orders: 2, total_czk: 10.5 },
  ]);
  assert.ok(csv.startsWith("﻿name;email;orders;total_czk"));
  assert.ok(csv.includes("A;a@x.cz;2;10,5"));
  assert.equal(toCsv([]), "﻿name;email;orders;total_czk\r\n");
});
