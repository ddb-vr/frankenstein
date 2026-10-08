import assert from "node:assert/strict";
import { test } from "node:test";
import { type Example, matchExample, validateExamples } from "./examples.ts";

const EXPECTED_GOT = /expected .* got /;

const valid = {
  entry: "scripts/main.ts",
  examples: [{ expected: { words: 1 }, input: { text: "x" }, name: "a" }],
  skill: "text-stats",
};

const example = (overrides: Partial<Example>): Example => ({
  expected: { chars: 11, words: 2 },
  input: {},
  match: "exact",
  name: "case",
  ...overrides,
});

test("validateExamples accepts a valid file and defaults match to exact", () => {
  const result = validateExamples(valid);
  assert.ok(result.ok);
  assert.equal(result.value.examples[0]?.match, "exact");
});

test("validateExamples rejects malformed files", () => {
  const cases: [string, unknown][] = [
    ["not an object", []],
    ["skill name", { ...valid, skill: "../evil" }],
    ["absolute entry", { ...valid, entry: "/etc/passwd" }],
    ["escaping entry", { ...valid, entry: "scripts/../../x.ts" }],
    ["windows absolute entry", { ...valid, entry: "C:\\x.ts" }],
    ["other entry file", { ...valid, entry: "scripts/cli.ts" }],
    ["missing entry", { examples: valid.examples, skill: valid.skill }],
    ["empty examples", { ...valid, examples: [] }],
    ["missing expected", { ...valid, examples: [{ input: {}, name: "a" }] }],
    ["missing input", { ...valid, examples: [{ expected: {}, name: "a" }] }],
    [
      "unknown match",
      {
        ...valid,
        examples: [{ expected: {}, input: {}, match: "fuzzy", name: "a" }],
      },
    ],
    [
      "subset with non-object expected",
      {
        ...valid,
        examples: [{ expected: [1], input: {}, match: "subset", name: "a" }],
      },
    ],
    [
      "duplicate names",
      { ...valid, examples: [valid.examples[0], valid.examples[0]] },
    ],
  ];
  for (const [label, data] of cases) {
    assert.equal(validateExamples(data).ok, false, label);
  }
});

test("exact match requires deep equality with no extra keys", () => {
  const exact = example({});
  assert.ok(
    matchExample(exact, { exitCode: 0, stdout: '{"chars":11,"words":2}' }).pass
  );
  const extra = matchExample(exact, {
    exitCode: 0,
    stdout: '{"words":2,"chars":11,"lines":1}',
  });
  assert.ok(!extra.pass);
  assert.match(extra.reason, EXPECTED_GOT);
});

test("subset match ignores extra keys but deep-compares listed ones", () => {
  const subset = example({ expected: { meta: { a: [1] } }, match: "subset" });
  assert.ok(
    matchExample(subset, { exitCode: 0, stdout: '{"meta":{"a":[1]},"x":1}' })
      .pass
  );
  assert.equal(
    matchExample(subset, { exitCode: 0, stdout: '{"meta":{"a":[1],"b":2}}' })
      .pass,
    false
  );
  assert.equal(
    matchExample(subset, { exitCode: 0, stdout: '{"x":1}' }).pass,
    false
  );
});

test("non-error example fails on non-zero exit or invalid JSON", () => {
  const exact = example({});
  assert.equal(
    matchExample(exact, { exitCode: 1, stdout: '{"words":2,"chars":11}' }).pass,
    false
  );
  const garbage = matchExample(exact, { exitCode: 0, stdout: "oops" });
  assert.equal(garbage.pass, false);
  assert.equal(garbage.actual, "oops");
});

test("error example needs exit 1 and an error string", () => {
  const errorCase = example({ expected: { error: true } });
  assert.ok(
    matchExample(errorCase, { exitCode: 1, stdout: '{"error":"missing"}' }).pass
  );
  assert.equal(
    matchExample(errorCase, { exitCode: 0, stdout: '{"error":"missing"}' })
      .pass,
    false
  );
  assert.equal(
    matchExample(errorCase, { exitCode: 1, stdout: '{"error":true}' }).pass,
    false
  );
  assert.equal(
    matchExample(errorCase, { exitCode: 2, stdout: '{"error":"crash"}' }).pass,
    false
  );
});
