// Records a real API response as an offline fixture for skill tests, so
// generated code never needs the network on the host.
//
//   node scripts/record-fixture.ts <skill> <name> <url>
//
// GET only, 10 s timeout, 1 MB max body, redirects are not followed. The host
// must be in FIXTURE_ALLOWED_DOMAINS (comma-separated; a domain also allows its
// subdomains), read only from the repo's `.env`: the caller's environment
// cannot widen it. Saves `work/<skill>/fixtures/<name>.json` as
// `{ url, status, headers, body, recordedAt }` and prints one JSON line
// `{ "recorded": "<path>", "status": <code> }`.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;
const ALLOWLIST_ENV = "FIXTURE_ALLOWED_DOMAINS";
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
const FIXTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const JSON_CONTENT_TYPE = /[/+]json\b/i;
const EDGE_DOTS = /^\.+|\.+$/g;
const TRAILING_DOT = /\.$/;
const REDIRECT_MIN = 300;
const REDIRECT_MAX = 399;
const JSON_INDENT = 2;
const REPO_ROOT = join(import.meta.dirname, "..");
const DOT_ENV_PATH = join(REPO_ROOT, ".env");
const USAGE = "Usage: node scripts/record-fixture.ts <skill> <name> <url>";

export interface Fixture {
  body: unknown;
  headers: { "content-type"?: string };
  recordedAt: string;
  status: number;
  url: string;
}

export interface RecordResult {
  recorded: string;
  status: number;
}

export interface Deps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now: () => Date;
  rootDir: string;
}

// ---------------------------------------------------------------------------
// Validation (pure, unit-tested)

export const parseAllowlist = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase().replace(EDGE_DOTS, ""))
    .filter((entry) => entry !== "");

export const isHostAllowed = (
  hostname: string,
  allowlist: readonly string[]
): boolean => {
  const host = hostname.toLowerCase().replace(TRAILING_DOT, "");
  return allowlist.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
};

export const parseArgs = (
  argv: readonly string[]
): { name: string; skill: string; url: URL } => {
  if (argv.length !== 3) {
    throw new Error(USAGE);
  }
  const [skill = "", name = "", rawUrl = ""] = argv;
  if (!SKILL_NAME.test(skill)) {
    throw new Error(`Invalid skill "${skill}": use kebab-case (a-z, 0-9, -)`);
  }
  if (!FIXTURE_NAME.test(name)) {
    throw new Error(`Invalid fixture name "${name}": use A-Z, a-z, 0-9, _, -`);
  }
  if (!URL.canParse(rawUrl)) {
    throw new Error(`Invalid URL "${rawUrl}"`);
  }
  const url = new URL(rawUrl);
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      `Unsupported protocol "${url.protocol}": use http or https`
    );
  }
  return { name, skill, url };
};

export const assertAllowed = (
  url: URL,
  env: Record<string, string | undefined>
): void => {
  const allowlist = parseAllowlist(env[ALLOWLIST_ENV]);
  if (allowlist.length === 0) {
    throw new Error(
      `${ALLOWLIST_ENV} is not set; add a comma-separated list of domains to .env`
    );
  }
  if (!isHostAllowed(url.hostname, allowlist)) {
    throw new Error(
      `Domain "${url.hostname}" is not in ${ALLOWLIST_ENV} (${allowlist.join(", ")})`
    );
  }
};

// ---------------------------------------------------------------------------
// Fetching

const tooLarge = (): Error =>
  new Error(`Response exceeds ${MAX_BODY_BYTES} bytes (1 MB limit)`);

const readCappedBody = async (response: Response): Promise<string> => {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

const parseBody = (text: string, contentType: string | undefined): unknown => {
  if (!(contentType && JSON_CONTENT_TYPE.test(contentType))) {
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const isTimeout = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "TimeoutError" || error.name === "AbortError");

const fetchFixture = async (
  url: URL,
  { fetch: fetchFn, now }: Pick<Deps, "fetch" | "now">
): Promise<Fixture> => {
  try {
    const response = await fetchFn(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status >= REDIRECT_MIN && response.status <= REDIRECT_MAX) {
      await response.body?.cancel();
      const location = response.headers.get("location") ?? "unknown";
      throw new Error(
        `Redirected (${response.status}) to ${location}; record the final URL directly`
      );
    }
    const contentType = response.headers.get("content-type") ?? undefined;
    const text = await readCappedBody(response);
    return {
      body: parseBody(text, contentType),
      headers: contentType === undefined ? {} : { "content-type": contentType },
      recordedAt: now().toISOString(),
      status: response.status,
      url: url.href,
    };
  } catch (error) {
    if (isTimeout(error)) {
      throw new Error(`Request timed out after ${TIMEOUT_MS / 1000} s`, {
        cause: error,
      });
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// CLI

export const run = async (
  argv: readonly string[],
  deps: Deps
): Promise<RecordResult> => {
  const { skill, name, url } = parseArgs(argv);
  assertAllowed(url, deps.env);
  const fixture = await fetchFixture(url, deps);
  const relativePath = `work/${skill}/fixtures/${name}.json`;
  const dir = join(deps.rootDir, "work", skill, "fixtures");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.json`),
    `${JSON.stringify(fixture, null, JSON_INDENT)}\n`
  );
  return { recorded: relativePath, status: fixture.status };
};

/**
 * The allowlist env for `run`, taken from the `.env` file only. Process
 * environment variables are ignored on purpose, so a command prefix like
 * `FIXTURE_ALLOWED_DOMAINS=… node scripts/record-fixture.ts …` cannot widen it.
 */
export const loadAllowlistEnv = async (
  dotEnvPath: string
): Promise<Record<string, string | undefined>> => {
  let content: string;
  try {
    content = await readFile(dotEnvPath, "utf8");
  } catch (error) {
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";
    if (missing) {
      return {};
    }
    throw error;
  }
  return { [ALLOWLIST_ENV]: parseEnv(content)[ALLOWLIST_ENV] };
};

const main = async (): Promise<void> => {
  try {
    const result = await run(process.argv.slice(2), {
      env: await loadAllowlistEnv(DOT_ENV_PATH),
      fetch: globalThis.fetch,
      now: () => new Date(),
      rootDir: REPO_ROOT,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ error: message })}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
