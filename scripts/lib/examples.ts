// Skill contract: `examples.json` schema, runtime validator and output matching.

import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export type MatchMode = "exact" | "subset";

export interface Example {
  expected: unknown;
  input: unknown;
  match: MatchMode;
  name: string;
}

export interface ExamplesFile {
  entry: string;
  examples: Example[];
  skill: string;
}

export type ValidationResult =
  | { ok: true; value: ExamplesFile }
  | { ok: false; error: string };

export interface ExampleOutcome {
  exitCode: number;
  stdout: string;
}

/** `actual` is parsed stdout, or the raw string when it is not valid JSON. */
export type MatchResult =
  | { actual: unknown; pass: true }
  | { actual: unknown; pass: false; reason: string };

const MATCH_MODES: readonly MatchMode[] = ["exact", "subset"];
/** Skill names are also directory names: lower-case, no path separators. */
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const ERROR_EXIT_CODE = 1;
const PATH_SEPARATOR = /[\\/]/;

export const isPlainObject = (
  value: unknown
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSafeRelativePath = (value: string): boolean => {
  if (
    value === "" ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    return false;
  }
  return !value.split(PATH_SEPARATOR).includes("..");
};

const validateExample = (
  raw: unknown,
  index: number
): { ok: true; value: Example } | { ok: false; error: string } => {
  const where = `examples[${index}]`;
  if (!isPlainObject(raw)) {
    return { error: `${where} must be an object`, ok: false };
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    return { error: `${where}.name must be a non-empty string`, ok: false };
  }
  if (!("input" in raw)) {
    return { error: `${where}.input is required`, ok: false };
  }
  if (!("expected" in raw)) {
    return { error: `${where}.expected is required`, ok: false };
  }
  const match = raw.match ?? "exact";
  if (!MATCH_MODES.includes(match as MatchMode)) {
    return { error: `${where}.match must be "exact" or "subset"`, ok: false };
  }
  if (match === "subset" && !isPlainObject(raw.expected)) {
    return {
      error: `${where}.expected must be an object when match is "subset"`,
      ok: false,
    };
  }
  return {
    ok: true,
    value: {
      expected: raw.expected,
      input: raw.input,
      match: match as MatchMode,
      name: raw.name,
    },
  };
};

export const validateExamples = (data: unknown): ValidationResult => {
  if (!isPlainObject(data)) {
    return { error: "examples.json must be an object", ok: false };
  }
  if (typeof data.skill !== "string" || !SKILL_NAME.test(data.skill)) {
    return { error: "skill must be a kebab-case name", ok: false };
  }
  if (typeof data.entry !== "string" || !isSafeRelativePath(data.entry)) {
    return {
      error: "entry must be a relative path inside the skill directory",
      ok: false,
    };
  }
  if (!Array.isArray(data.examples) || data.examples.length === 0) {
    return { error: "examples must be a non-empty array", ok: false };
  }
  const examples: Example[] = [];
  const names = new Set<string>();
  for (const [index, raw] of data.examples.entries()) {
    const result = validateExample(raw, index);
    if (!result.ok) {
      return result;
    }
    if (names.has(result.value.name)) {
      return {
        error: `duplicate example name "${result.value.name}"`,
        ok: false,
      };
    }
    names.add(result.value.name);
    examples.push(result.value);
  }
  return {
    ok: true,
    value: { entry: data.entry, examples, skill: data.skill },
  };
};

/** `{ "error": true }` marks an example that expects a handled error. */
export const expectsError = (expected: unknown): boolean =>
  isPlainObject(expected) &&
  Object.keys(expected).length === 1 &&
  expected.error === true;

const parseOutput = (
  stdout: string
): { ok: true; value: unknown } | { ok: false } => {
  try {
    return { ok: true, value: JSON.parse(stdout) };
  } catch {
    return { ok: false };
  }
};

const subsetMismatch = (
  expected: Record<string, unknown>,
  actual: unknown
): string | undefined => {
  if (!isPlainObject(actual)) {
    return "output is not an object";
  }
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in actual)) {
      return `missing key "${key}"`;
    }
    if (!isDeepStrictEqual(actual[key], value)) {
      return `key "${key}" differs`;
    }
  }
};

export const matchExample = (
  example: Example,
  outcome: ExampleOutcome
): MatchResult => {
  const parsed = parseOutput(outcome.stdout);
  if (!parsed.ok) {
    return {
      actual: outcome.stdout,
      pass: false,
      reason: `stdout is not valid JSON (exit ${outcome.exitCode})`,
    };
  }
  const actual = parsed.value;

  if (expectsError(example.expected)) {
    const hasErrorMessage =
      isPlainObject(actual) && typeof actual.error === "string";
    if (outcome.exitCode !== ERROR_EXIT_CODE || !hasErrorMessage) {
      return {
        actual,
        pass: false,
        reason: `expected exit 1 with { "error": string }, got exit ${outcome.exitCode} with ${JSON.stringify(actual)}`,
      };
    }
    return { actual, pass: true };
  }

  if (outcome.exitCode !== 0) {
    return {
      actual,
      pass: false,
      reason: `expected exit 0, got exit ${outcome.exitCode} with ${JSON.stringify(actual)}`,
    };
  }

  let mismatch: string | undefined;
  if (example.match === "subset" && isPlainObject(example.expected)) {
    mismatch = subsetMismatch(example.expected, actual);
  } else if (!isDeepStrictEqual(actual, example.expected)) {
    mismatch = "not deep-equal";
  }
  if (mismatch !== undefined) {
    return {
      actual,
      pass: false,
      reason: `${mismatch}: expected ${JSON.stringify(example.expected)} got ${JSON.stringify(actual)}`,
    };
  }
  return { actual, pass: true };
};
