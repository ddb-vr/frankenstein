// Claude API token prices and cost calculation for skill-build usage reports.

/** USD per 1M tokens. `cacheWrite` is the 5-minute cache write rate. */
export interface ModelPrice {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
}

// Source: https://platform.claude.com/docs/en/about-claude/pricing
// (redirected from https://docs.claude.com/en/docs/about-claude/pricing),
// "Model pricing" table, retrieved 2026-10-08.
export const PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-4-6": { cacheRead: 0.5, cacheWrite: 6.25, input: 5, output: 25 },
  "claude-opus-4-7": { cacheRead: 0.5, cacheWrite: 6.25, input: 5, output: 25 },
  "claude-opus-4-8": { cacheRead: 0.5, cacheWrite: 6.25, input: 5, output: 25 },
  "claude-opus-5": { cacheRead: 0.5, cacheWrite: 6.25, input: 5, output: 25 },
  "claude-opus-5-5": { cacheRead: 0.2, cacheWrite: 5, input: 4, output: 20 },
  "claude-sonnet-4-6": {
    cacheRead: 0.3,
    cacheWrite: 3.75,
    input: 3,
    output: 15,
  },
  "claude-sonnet-5": { cacheRead: 0.2, cacheWrite: 2.5, input: 2, output: 10 },
  "claude-sonnet-5-5": {
    cacheRead: 0.1,
    cacheWrite: 2.5,
    input: 2,
    output: 10,
  },
};

export interface TokenCounts {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
}

export interface UsageEntry extends TokenCounts {
  model: string;
}

export interface ModelCost extends TokenCounts {
  model: string;
  usd: number;
}

export interface CostReport {
  perModel: ModelCost[];
  totals: TokenCounts;
  totalUsd: number;
}

const TOKENS_PER_UNIT = 1_000_000;
// Round USD to a micro-dollar to drop floating point noise.
const USD_PRECISION = 1_000_000;
// Model ids may carry a date snapshot suffix, e.g. `claude-opus-4-6-20260101`.
const SNAPSHOT_SUFFIX = /-\d{8}$/;

const roundUsd = (value: number): number =>
  Math.round(value * USD_PRECISION) / USD_PRECISION;

export const priceFor = (model: string): ModelPrice => {
  const price = PRICES[model] ?? PRICES[model.replace(SNAPSHOT_SUFFIX, "")];
  if (!price) {
    throw new Error(`No price known for model "${model}"`);
  }
  return price;
};

const costOf = (counts: TokenCounts, price: ModelPrice): number =>
  (counts.input * price.input +
    counts.cacheWrite * price.cacheWrite +
    counts.cacheRead * price.cacheRead +
    counts.output * price.output) /
  TOKENS_PER_UNIT;

export const computeCost = (usage: readonly UsageEntry[]): CostReport => {
  const byModel = new Map<string, TokenCounts>();
  for (const { model, input, cacheWrite, cacheRead, output } of usage) {
    const current = byModel.get(model) ?? {
      cacheRead: 0,
      cacheWrite: 0,
      input: 0,
      output: 0,
    };
    current.input += input;
    current.cacheWrite += cacheWrite;
    current.cacheRead += cacheRead;
    current.output += output;
    byModel.set(model, current);
  }

  const totals: TokenCounts = {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
  };
  const perModel: ModelCost[] = [];
  let totalUsd = 0;
  for (const [model, counts] of byModel) {
    const usd = costOf(counts, priceFor(model));
    perModel.push({ model, ...counts, usd: roundUsd(usd) });
    totals.input += counts.input;
    totals.cacheWrite += counts.cacheWrite;
    totals.cacheRead += counts.cacheRead;
    totals.output += counts.output;
    totalUsd += usd;
  }

  return { perModel, totals, totalUsd: roundUsd(totalUsd) };
};
