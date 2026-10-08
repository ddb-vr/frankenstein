import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCost, priceFor } from "./pricing.ts";

const UNKNOWN_MODEL_ERROR = /No price known/;

test("computeCost sums per model and in total", () => {
  const report = computeCost([
    {
      cacheRead: 2_000_000,
      cacheWrite: 200_000,
      input: 1_000_000,
      model: "claude-opus-5-5",
      output: 100_000,
    },
    {
      cacheRead: 1_000_000,
      cacheWrite: 0,
      input: 500_000,
      model: "claude-sonnet-5-5",
      output: 50_000,
    },
    {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      model: "claude-opus-5-5",
      output: 100_000,
    },
  ]);

  // Opus 5.5: 1M*4 + 0.2M*5 + 2M*0.2 + 0.2M*20 = 4 + 1 + 0.4 + 4 = 9.4
  // Sonnet 5.5: 0.5M*2 + 1M*0.1 + 0.05M*10 = 1 + 0.1 + 0.5 = 1.6
  assert.deepEqual(report, {
    perModel: [
      {
        cacheRead: 2_000_000,
        cacheWrite: 200_000,
        input: 1_000_000,
        model: "claude-opus-5-5",
        output: 200_000,
        usd: 9.4,
      },
      {
        cacheRead: 1_000_000,
        cacheWrite: 0,
        input: 500_000,
        model: "claude-sonnet-5-5",
        output: 50_000,
        usd: 1.6,
      },
    ],
    totals: {
      cacheRead: 3_000_000,
      cacheWrite: 200_000,
      input: 1_500_000,
      output: 250_000,
    },
    totalUsd: 11,
  });
});

test("computeCost of empty usage is zero", () => {
  assert.deepEqual(computeCost([]), {
    perModel: [],
    totals: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    totalUsd: 0,
  });
});

test("priceFor accepts snapshot suffixes and rejects unknown models", () => {
  assert.equal(priceFor("claude-sonnet-5-5-20260101").input, 2);
  assert.throws(() => priceFor("claude-sonnet-4-6"), UNKNOWN_MODEL_ERROR);
  assert.throws(() => priceFor("gpt-4"), UNKNOWN_MODEL_ERROR);
});

test("computeCost prices Haiku 5.5 per prompt tier, grouped in one row", () => {
  const tokens = {
    cacheRead: 1_000_000,
    cacheWrite: 1_000_000,
    input: 1_000_000,
    output: 1_000_000,
  };
  const report = computeCost([
    { ...tokens, model: "claude-haiku-5-5" },
    { ...tokens, longPrompt: true, model: "claude-haiku-5-5" },
  ]);

  // <=100k prompt: 0.1 + 0.125 + 0.01 + 0.5 = 0.735
  // >100k prompt:  0.5 + 0.625 + 0.05 + 2.5 = 3.675
  assert.deepEqual(report.perModel, [
    {
      cacheRead: 2_000_000,
      cacheWrite: 2_000_000,
      input: 2_000_000,
      model: "claude-haiku-5-5",
      output: 2_000_000,
      usd: 4.41,
    },
  ]);
  assert.equal(report.totalUsd, 4.41);
});

test("longPrompt does not change flat-priced models", () => {
  assert.deepEqual(
    priceFor("claude-opus-5-5", true),
    priceFor("claude-opus-5-5")
  );
});
