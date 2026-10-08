import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import {
  type Deps,
  type Fixture,
  isHostAllowed,
  loadAllowlistEnv,
  parseAllowlist,
  run,
} from "./record-fixture.ts";

const execFileAsync = promisify(execFile);
const RECORDER = join(import.meta.dirname, "record-fixture.ts");
const ONE_MB = 1024 * 1024;
const RECORDED_AT = new Date("2026-10-08T12:00:00.000Z");
const ARES_URL =
  "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/00006947";
const ALLOWED = { FIXTURE_ALLOWED_DOMAINS: "ares.gov.cz, example.com" };
const NOT_ALLOWED = /not in FIXTURE_ALLOWED_DOMAINS/;
const NOT_SET = /FIXTURE_ALLOWED_DOMAINS is not set/;
const ALLOWLIST_ERROR =
  /FIXTURE_ALLOWED_DOMAINS is not set|not in FIXTURE_ALLOWED_DOMAINS/;
const TOO_LARGE = /exceeds 1048576 bytes/;
const TIMED_OUT = /timed out after 10 s/;
const REDIRECTED = /Redirected \(302\)/;
const USAGE = /Usage:/;
const BAD_SKILL = /Invalid skill/;
const BAD_NAME = /Invalid fixture name/;
const BAD_PROTOCOL = /Unsupported protocol/;
const BAD_URL = /Invalid URL/;

let rootDir = "";

before(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "record-fixture-test-"));
});

after(async () => {
  await rm(rootDir, { force: true, recursive: true });
});

interface FetchCall {
  init: RequestInit | undefined;
  url: string;
}

const mockFetch = (
  respond: () => Response | Promise<Response>
): { calls: FetchCall[]; fetch: typeof fetch } => {
  const calls: FetchCall[] = [];
  const fetchFn = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    calls.push({ init, url: String(input) });
    return await respond();
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
};

const deps = (
  fetchFn: typeof fetch,
  env: Record<string, string | undefined> = ALLOWED
): Deps => ({ env, fetch: fetchFn, now: () => RECORDED_AT, rootDir });

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "set-cookie": "secret=1",
      "x-request-id": "abc",
    },
    status,
  });

// Body without content-length, so only the streaming cap can catch it.
const streamedResponse = (bytes: number): Response => {
  const chunk = new Uint8Array(64 * 1024).fill(97);
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunk.byteLength, bytes - sent);
      controller.enqueue(chunk.subarray(0, size));
      sent += size;
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain" } });
};

// ---------------------------------------------------------------------------
// Allowlist

test("parseAllowlist trims, lowercases and drops empty entries", () => {
  assert.deepEqual(parseAllowlist(" ARES.gov.cz ,, .example.com. ,"), [
    "ares.gov.cz",
    "example.com",
  ]);
  assert.deepEqual(parseAllowlist(undefined), []);
});

test("isHostAllowed matches exact domains and subdomains only", () => {
  const list = ["ares.gov.cz"];
  assert.equal(isHostAllowed("ares.gov.cz", list), true);
  assert.equal(isHostAllowed("api.ARES.gov.cz", list), true);
  assert.equal(isHostAllowed("ares.gov.cz.", list), true);
  assert.equal(isHostAllowed("evilares.gov.cz", list), false);
  assert.equal(isHostAllowed("ares.gov.cz.evil.com", list), false);
  assert.equal(isHostAllowed("gov.cz", list), false);
});

test("disallowed domain errors without making a request", async () => {
  const { calls, fetch } = mockFetch(() => jsonResponse({}));
  await assert.rejects(
    run(["ares-lookup", "x", "https://evil.com/data"], deps(fetch)),
    NOT_ALLOWED
  );
  assert.equal(calls.length, 0);
});

test("missing allowlist errors without making a request", async () => {
  const { calls, fetch } = mockFetch(() => jsonResponse({}));
  await Promise.all(
    [{}, { FIXTURE_ALLOWED_DOMAINS: " , " }].map((env) =>
      assert.rejects(
        run(["ares-lookup", "x", ARES_URL], deps(fetch, env)),
        NOT_SET
      )
    )
  );
  assert.equal(calls.length, 0);
});

test("allowlist comes from .env only, never from the process env", async () => {
  const dotEnv = join(rootDir, "allowlist.env");
  await writeFile(
    dotEnv,
    "# fixture allowlist\nOTHER=1\nFIXTURE_ALLOWED_DOMAINS=ares.gov.cz\n"
  );
  const previous = process.env.FIXTURE_ALLOWED_DOMAINS;
  process.env.FIXTURE_ALLOWED_DOMAINS = "evil.com";
  try {
    assert.deepEqual(await loadAllowlistEnv(dotEnv), {
      FIXTURE_ALLOWED_DOMAINS: "ares.gov.cz",
    });
    assert.deepEqual(await loadAllowlistEnv(join(rootDir, "missing.env")), {});
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "FIXTURE_ALLOWED_DOMAINS");
    } else {
      process.env.FIXTURE_ALLOWED_DOMAINS = previous;
    }
  }
});

// ---------------------------------------------------------------------------
// Output format

test("records a JSON fixture and returns the path and status", async () => {
  const { calls, fetch } = mockFetch(() =>
    jsonResponse({ ico: "00006947", obchodniJmeno: "Ministerstvo financí" })
  );
  const result = await run(["ares-lookup", "mf", ARES_URL], deps(fetch));

  assert.deepEqual(result, {
    recorded: "work/ares-lookup/fixtures/mf.json",
    status: 200,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, ARES_URL);
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(calls[0]?.init?.redirect, "manual");
  assert.ok(calls[0]?.init?.signal instanceof AbortSignal);

  const saved: Fixture = JSON.parse(
    await readFile(join(rootDir, result.recorded), "utf8")
  );
  assert.deepEqual(saved, {
    body: { ico: "00006947", obchodniJmeno: "Ministerstvo financí" },
    headers: { "content-type": "application/json; charset=utf-8" },
    recordedAt: "2026-10-08T12:00:00.000Z",
    status: 200,
    url: ARES_URL,
  });
});

test("records error statuses and non-JSON bodies as text", async () => {
  const { fetch } = mockFetch(
    () =>
      new Response("Not Found", {
        headers: { "content-type": "text/plain" },
        status: 404,
      })
  );
  const result = await run(
    ["ares-lookup", "missing", "https://example.com/x"],
    deps(fetch)
  );
  assert.deepEqual(result, {
    recorded: "work/ares-lookup/fixtures/missing.json",
    status: 404,
  });
  const saved: Fixture = JSON.parse(
    await readFile(join(rootDir, result.recorded), "utf8")
  );
  assert.equal(saved.body, "Not Found");
  assert.deepEqual(saved.headers, { "content-type": "text/plain" });
});

test("CLI prints one JSON error line on stderr and ignores an env allowlist", async () => {
  // The caller's env names the domain, but only the repo's .env counts.
  const { stdout, stderr, code } = await execFileAsync(
    process.execPath,
    [RECORDER, "ares-lookup", "x", "https://evil.invalid/"],
    { env: { ...process.env, FIXTURE_ALLOWED_DOMAINS: "evil.invalid" } }
  ).then(
    (ok) => ({ ...ok, code: 0 }),
    (error: { code: number; stderr: string; stdout: string }) => error
  );
  assert.equal(code, 1);
  assert.equal(stdout, "");
  const lines = stderr.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(JSON.parse(lines[0] ?? "").error, ALLOWLIST_ERROR);
});

// ---------------------------------------------------------------------------
// Size limit

test("accepts a body of exactly 1 MB", async () => {
  const { fetch } = mockFetch(() => streamedResponse(ONE_MB));
  const result = await run(
    ["ares-lookup", "big", "https://example.com/big"],
    deps(fetch)
  );
  const saved: Fixture = JSON.parse(
    await readFile(join(rootDir, result.recorded), "utf8")
  );
  assert.equal(String(saved.body).length, ONE_MB);
});

test("rejects a streamed body over 1 MB and writes nothing", async () => {
  const { fetch } = mockFetch(() => streamedResponse(ONE_MB + 1));
  await assert.rejects(
    run(["ares-lookup", "huge", "https://example.com/huge"], deps(fetch)),
    TOO_LARGE
  );
  await assert.rejects(
    stat(join(rootDir, "work/ares-lookup/fixtures/huge.json"))
  );
});

test("rejects early when content-length declares over 1 MB", async () => {
  const { fetch } = mockFetch(
    () =>
      new Response("small", {
        headers: { "content-length": String(ONE_MB + 1) },
      })
  );
  await assert.rejects(
    run(["ares-lookup", "declared", "https://example.com/"], deps(fetch)),
    TOO_LARGE
  );
});

// ---------------------------------------------------------------------------
// Timeout, redirects, arguments

test("timeout gives a clear error", async () => {
  const { fetch } = mockFetch(() => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  });
  await assert.rejects(
    run(["ares-lookup", "slow", ARES_URL], deps(fetch)),
    TIMED_OUT
  );
});

test("redirects are not followed", async () => {
  const { fetch } = mockFetch(() =>
    Response.redirect("https://evil.com/", 302)
  );
  await assert.rejects(
    run(["ares-lookup", "moved", ARES_URL], deps(fetch)),
    REDIRECTED
  );
});

test("bad arguments error without making a request", async () => {
  const { calls, fetch } = mockFetch(() => jsonResponse({}));
  const cases: [string[], RegExp][] = [
    [[], USAGE],
    [["ares-lookup", "x"], USAGE],
    [["Ares_Lookup", "x", ARES_URL], BAD_SKILL],
    [["../etc", "x", ARES_URL], BAD_SKILL],
    [["ares-lookup", "../x", ARES_URL], BAD_NAME],
    [["ares-lookup", "x", "not a url"], BAD_URL],
    [["ares-lookup", "x", "file:///etc/passwd"], BAD_PROTOCOL],
  ];
  await Promise.all(
    cases.map(([argv, error]) => assert.rejects(run(argv, deps(fetch)), error))
  );
  assert.equal(calls.length, 0);
});
