import assert from "node:assert/strict";
import { test } from "node:test";
import { textStats } from "../scripts/main.ts";

test("counts words separated by any whitespace", () => {
  assert.deepEqual(textStats({ text: "  one\ttwo\n three " }), {
    chars: 17,
    words: 3,
  });
});

test("rejects missing text", () => {
  assert.throws(() => textStats({}), { message: "text must be a string" });
});
