import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { createAppJwt } from "./github-app-token.ts";

const RSA_MODULUS_BITS = 2048;
const FIXED_NOW = 1_700_000_000;
const BASE64URL_JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: RSA_MODULUS_BITS,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const decodeSegment = (segment: string): unknown =>
  JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

test("createAppJwt builds an RS256 JWT with the expected claims", () => {
  const jwt = createAppJwt("12345", privateKey, FIXED_NOW);
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header && payload && signature, "JWT has three segments");

  assert.deepEqual(decodeSegment(header), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodeSegment(payload), {
    exp: FIXED_NOW + 540,
    iat: FIXED_NOW - 60,
    iss: "12345",
  });

  const valid = createVerify("RSA-SHA256")
    .update(`${header}.${payload}`)
    .verify(publicKey, signature, "base64url");
  assert.equal(valid, true);
});

test("createAppJwt signature fails verification when tampered", () => {
  const jwt = createAppJwt("12345", privateKey, FIXED_NOW);
  const [header, , signature] = jwt.split(".");
  const forged = Buffer.from(
    JSON.stringify({ exp: 9_999_999_999, iat: 0, iss: "12345" })
  ).toString("base64url");

  const valid = createVerify("RSA-SHA256")
    .update(`${header}.${forged}`)
    .verify(publicKey, signature ?? "", "base64url");
  assert.equal(valid, false);
});

test("JWT segments are base64url without padding", () => {
  const jwt = createAppJwt("1", privateKey, FIXED_NOW);
  assert.match(jwt, BASE64URL_JWT);
});
