// Claude API token prices and cost calculation for skill-build usage reports.

/** USD per 1M tokens. `cacheWrite` is the 5-minute cache write rate. */
export interface ModelPrice {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
}

export interface ModelPricing extends ModelPrice {
  /** Rates for prompts over `LONG_PROMPT_TOKENS`; absent when pricing is flat. */
  longPrompt?: ModelPrice;
}

/** Prompt length above which tiered models bill at their `longPrompt` rates. */
export const LONG_PROMPT_TOKENS = 100_000;

// Source: https://platform.claude.com/docs/en/about-claude/pricing
// (redirected from https://docs.claude.com/en/docs/about-claude/pricing),
// "Model pricing" table, retrieved 2026-10-08.
export const PRICES: Readonly<Record<string, ModelPricing>> = {
  "claude-haiku-5-5": {
    cacheRead: 0.01,
    cacheWrite: 0.125,
    input: 0.1,
    longPrompt: { cacheRead: 0.05, cacheWrite: 0.625, input: 0.5, output: 2.5 },
    output: 0.5,
  },
  "claude-opus-5-5": { cacheRead: 0.2, cacheWrite: 5, input: 4, output: 20 },
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
  /**
   * The prompt exceeded `LONG_PROMPT_TOKENS`. Tiered models (Haiku 5.5) bill
   * such usage at higher rates, so report it as a separate entry.
   */
  longPrompt?: boolean;
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
// Model ids may carry a date snapshot suffix, e.g. `claude-opus-5-5-20260101`.
const SNAPSHOT_SUFFIX = /-\d{8}$/;

const roundUsd = (value: number): number =>
  Math.round(value * USD_PRECISION) / USD_PRECISION;

export const priceFor = (model: string, longPrompt = false): ModelPrice => {
  const pricing = PRICES[model] ?? PRICES[model.replace(SNAPSHOT_SUFFIX, "")];
  if (!pricing) {
    throw new Error(`No price known for model "${model}"`);
  }
  return (longPrompt && pricing.longPrompt) || pricing;
};

const costOf = (counts: TokenCounts, price: ModelPrice): number =>
  (counts.input * price.input +
    counts.cacheWrite * price.cacheWrite +
    counts.cacheRead * price.cacheRead +
    counts.output * price.output) /
  TOKENS_PER_UNIT;

const emptyCounts = (): TokenCounts => ({
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
});

const addCounts = (target: TokenCounts, counts: TokenCounts): void => {
  target.input += counts.input;
  target.cacheWrite += counts.cacheWrite;
  target.cacheRead += counts.cacheRead;
  target.output += counts.output;
};

interface ModelTally {
  counts: TokenCounts;
  usd: number;
}

export const computeCost = (usage: readonly UsageEntry[]): CostReport => {
  // Price each entry on its own (its tier may differ), then group by model.
  const byModel = new Map<string, ModelTally>();
  for (const entry of usage) {
    const tally = byModel.get(entry.model) ?? { counts: emptyCounts(), usd: 0 };
    addCounts(tally.counts, entry);
    tally.usd += costOf(entry, priceFor(entry.model, entry.longPrompt));
    byModel.set(entry.model, tally);
  }

  const totals = emptyCounts();
  const perModel: ModelCost[] = [];
  let totalUsd = 0;
  for (const [model, { counts, usd }] of byModel) {
    perModel.push({ model, ...counts, usd: roundUsd(usd) });
    addCounts(totals, counts);
    totalUsd += usd;
  }

  return { perModel, totals, totalUsd: roundUsd(totalUsd) };
};
