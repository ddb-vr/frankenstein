import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  type botEnv,
  createAppJwt,
  type getInstallationToken,
} from "./github-app-token.ts";

const RSA_MODULUS_BITS = 2048;
const FIXED_NOW = 1_700_000_000;
const BASE64URL_JWT = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const MINT_FAILED = /access_tokens failed: 500/;

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

interface TokenModule {
  botEnv: typeof botEnv;
  getInstallationToken: typeof getInstallationToken;
}

// Dynamic import is deliberate: a query-suffixed specifier yields a fresh
// module instance per test, so the token/identity caches start cold.
let moduleInstance = 0;
const freshModule = async (): Promise<TokenModule> => {
  moduleInstance += 1;
  return await import(`./github-app-token.ts?instance=${moduleInstance}`);
};

const TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const realFetch = globalThis.fetch;
const savedEnv = {
  GITHUB_APP_ID: process.env.GITHUB_APP_ID,
  GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID,
  GITHUB_APP_PRIVATE_KEY_PATH: process.env.GITHUB_APP_PRIVATE_KEY_PATH,
};

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

interface FetchCounts {
  app: number;
  tokens: number;
  users: number;
}

interface StubOptions {
  // Fail the first access_tokens POST with a 500.
  failFirstMint?: boolean;
  // Hold access_tokens responses until GET /app arrives, so the identity
  // lookup races ahead of the mint (the case that used to mint twice).
  mintAfterApp?: boolean;
}

const stubGitHub = ({
  failFirstMint = false,
  mintAfterApp = false,
}: StubOptions = {}): FetchCounts => {
  const keyPath = join(mkdtempSync(join(tmpdir(), "gh-app-")), "key.pem");
  writeFileSync(keyPath, privateKey);
  process.env.GITHUB_APP_ID = "1";
  process.env.GITHUB_APP_INSTALLATION_ID = "2";
  process.env.GITHUB_APP_PRIVATE_KEY_PATH = keyPath;
  const counts: FetchCounts = { app: 0, tokens: 0, users: 0 };
  const appRequested = Promise.withResolvers<void>();
  if (!mintAfterApp) {
    appRequested.resolve();
  }
  globalThis.fetch = async (input: string | URL | Request) => {
    const { pathname } = new URL(String(input));
    if (pathname.endsWith("/access_tokens")) {
      counts.tokens += 1;
      const attempt = counts.tokens;
      await appRequested.promise;
      if (failFirstMint && attempt === 1) {
        return new Response("boom", { status: 500 });
      }
      return Response.json({
        expires_at: new Date(Date.now() + TOKEN_LIFETIME_MS).toISOString(),
        token: `tok-${attempt}`,
      });
    }
    if (pathname === "/app") {
      counts.app += 1;
      appRequested.resolve();
      return Response.json({ slug: "frank" });
    }
    counts.users += 1;
    return Response.json({ id: 42 });
  };
  return counts;
};

test("concurrent cold botEnv calls mint one token and look up identity once", async () => {
  const counts = stubGitHub({ mintAfterApp: true });
  const tokens = await freshModule();
  const [first, second] = await Promise.all([tokens.botEnv(), tokens.botEnv()]);
  assert.deepEqual(counts, { app: 1, tokens: 1, users: 1 });
  assert.equal(first.GH_TOKEN, "tok-1");
  assert.deepEqual(first, second);
  assert.equal(first.GIT_AUTHOR_NAME, "frank[bot]");
  assert.equal(
    first.GIT_AUTHOR_EMAIL,
    "42+frank[bot]@users.noreply.github.com"
  );

  await tokens.botEnv();
  assert.deepEqual(counts, { app: 1, tokens: 1, users: 1 });
});

test("a failed token mint is not cached; the next call retries", async () => {
  const counts = stubGitHub({ failFirstMint: true });
  const tokens = await freshModule();
  await assert.rejects(
    Promise.all([tokens.getInstallationToken(), tokens.getInstallationToken()]),
    MINT_FAILED
  );
  assert.equal(counts.tokens, 1);
  assert.equal(await tokens.getInstallationToken(), "tok-2");
  assert.equal(counts.tokens, 2);
});
