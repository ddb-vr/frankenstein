import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateIco, validateInput } from "../scripts/ico.ts";

const MAIN = fileURLToPath(new URL("../scripts/main.ts", import.meta.url));

test("valid checksum", () => {
  assert.deepEqual(validateIco("27082440"), {
    ico: "27082440",
    reason: "ok",
    valid: true,
  });
});

test("bad checksum", () => {
  assert.equal(validateIco("12345678").reason, "checksum");
});

test("pads, strips spaces and CZ", () => {
  assert.equal(validateIco("19").ico, "00000019");
  assert.equal(validateIco(" cz 2708 2440").ico, "27082440");
});

test("not digits and too long", () => {
  assert.equal(validateIco("2708A440").reason, "not_digits");
  assert.equal(validateIco("").reason, "not_digits");
  assert.equal(validateIco("123456789").reason, "too_long");
});

test("special checksum branches", () => {
  assert.equal(validateIco("1").valid, true);
  assert.equal(validateIco("00000001").reason, "ok");
  assert.equal(validateIco("00003000").valid, true);
  assert.equal(validateIco("00003001").reason, "checksum");
});

test("non-string items are not_digits", () => {
  assert.deepEqual(validateIco(27_082_440), {
    ico: "27082440",
    reason: "not_digits",
    valid: false,
  });
  assert.deepEqual(validateIco(null), {
    ico: "",
    reason: "not_digits",
    valid: false,
  });
});

test("whitespace-only, bare CZ, lowercase prefix", () => {
  assert.deepEqual(validateIco("   "), {
    ico: "",
    reason: "not_digits",
    valid: false,
  });
  assert.equal(validateIco("CZ").reason, "not_digits");
  assert.equal(validateIco("cz27082440").reason, "ok");
});

test("input errors with messages", () => {
  assert.throws(() => validateInput({}), { message: "Missing field: ico" });
  assert.throws(() => validateInput([]), { message: "Missing field: ico" });
  assert.throws(() => validateInput(5), { message: "Missing field: ico" });
  assert.throws(() => validateInput({ ico: null }), {
    message: "ico must be an array of strings",
  });
  assert.throws(() => validateInput({ ico: "x" }), {
    message: "ico must be an array of strings",
  });
  assert.throws(() => validateInput({ ico: [] }), {
    message: "ico must not be empty",
  });
  assert.equal(validateInput({ ico: ["19", "x"] }).results.length, 2);
});

test("main.ts invalid JSON exits 1", () => {
  const r = spawnSync(process.execPath, [MAIN], {
    encoding: "utf8",
    input: "not json",
  });
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(typeof out.error, "string");
  assert.ok(out.error.length > 0);
});

test("main.ts valid input exits 0", () => {
  const r = spawnSync(process.execPath, [MAIN], {
    encoding: "utf8",
    input: '{"ico":["27082440"]}',
  });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), {
    results: [{ ico: "27082440", reason: "ok", valid: true }],
  });
});
