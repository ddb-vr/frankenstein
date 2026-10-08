// Exchanges a GitHub App JWT (signed with `node:crypto`, no deps) for an
// installation access token used for all bot-identity GitHub writes.
// Library only: nothing here ever prints the token or the private key.

import { execFile } from "node:child_process";
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

const GITHUB_API = "https://api.github.com";
const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

// GitHub allows a JWT lifetime of at most 10 minutes; backdate `iat` for
// clock drift.
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_EXEC_BUFFER_BYTES = 16 * 1024 * 1024;
const REDACTED = "[REDACTED]";

// Every secret this process has seen; scrubbed from any error text.
const secrets = new Set<string>();

const rememberSecret = (value: string): string => {
  if (value) {
    secrets.add(value);
  }
  return value;
};

export const redact = (text: string): string => {
  let result = text;
  for (const secret of secrets) {
    result = result.replaceAll(secret, REDACTED);
  }
  return result;
};

const base64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

export const createAppJwt = (
  appId: string,
  privateKeyPem: string,
  now: number = Math.floor(Date.now() / 1000)
): string => {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      exp: now + JWT_LIFETIME_SECONDS,
      iat: now - JWT_BACKDATE_SECONDS,
      iss: appId,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKeyPem, "base64url");
  return `${signingInput}.${signature}`;
};

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
};

const appJwt = async (): Promise<string> => {
  const keyPath = requireEnv("GITHUB_APP_PRIVATE_KEY_PATH");
  const privateKey = rememberSecret(await readFile(keyPath, "utf8"));
  return rememberSecret(createAppJwt(requireEnv("GITHUB_APP_ID"), privateKey));
};

const githubRequest = async (
  method: "GET" | "POST",
  path: string,
  bearer: string
): Promise<unknown> => {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: { ...API_HEADERS, Authorization: `Bearer ${bearer}` },
    method,
  });
  if (!response.ok) {
    const body = redact(await response.text());
    throw new Error(
      `GitHub ${method} ${path} failed: ${response.status} ${body}`
    );
  }
  return response.json();
};

const readString = (data: unknown, key: string): string => {
  const value =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error(`GitHub response is missing "${key}"`);
  }
  return String(value);
};

interface CachedToken {
  expiresAt: number;
  token: string;
}

let cachedToken: CachedToken | undefined;
// In-flight mint shared by concurrent callers; cleared once it settles.
let pendingToken: Promise<string> | undefined;

const mintInstallationToken = async (): Promise<string> => {
  const installationId = requireEnv("GITHUB_APP_INSTALLATION_ID");
  const data = await githubRequest(
    "POST",
    `/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    await appJwt()
  );
  const token = rememberSecret(readString(data, "token"));
  const expiresAt = Date.parse(readString(data, "expires_at"));
  cachedToken = { expiresAt, token };
  return token;
};

export const getInstallationToken = (): Promise<string> => {
  if (
    cachedToken &&
    Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS
  ) {
    return Promise.resolve(cachedToken.token);
  }
  pendingToken ??= mintInstallationToken().finally(() => {
    pendingToken = undefined;
  });
  return pendingToken;
};

export interface BotIdentity {
  email: string;
  name: string;
}

// The bot identity never changes, so the (single-flight) lookup is cached for
// the process lifetime; a failed lookup is dropped so the next call retries.
let cachedIdentity: Promise<BotIdentity> | undefined;

const fetchBotIdentity = async (): Promise<BotIdentity> => {
  const app = await githubRequest("GET", "/app", await appJwt());
  const name = `${readString(app, "slug")}[bot]`;
  const user = await githubRequest(
    "GET",
    `/users/${encodeURIComponent(name)}`,
    await getInstallationToken()
  );
  return {
    email: `${readString(user, "id")}+${name}@users.noreply.github.com`,
    name,
  };
};

export const getBotIdentity = (): Promise<BotIdentity> => {
  cachedIdentity ??= fetchBotIdentity().catch((error: unknown) => {
    cachedIdentity = undefined;
    throw error;
  });
  return cachedIdentity;
};

export const botEnv = async (): Promise<Record<string, string>> => {
  const [token, { name, email }] = await Promise.all([
    getInstallationToken(),
    getBotIdentity(),
  ]);
  return {
    GH_TOKEN: token,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_NAME: name,
  };
};

export const runAsBot = async (
  cmd: string,
  args: readonly string[],
  { stdin }: { stdin?: string } = {}
): Promise<string> => {
  const env = { ...process.env, ...(await botEnv()) };
  return await new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { env, maxBuffer: MAX_EXEC_BUFFER_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const detail = redact(String(stderr).trim() || error.message);
          reject(new Error(`${cmd} ${args[0] ?? ""} failed: ${detail}`));
          return;
        }
        resolve(String(stdout));
      }
    );
    child.stdin?.end(stdin ?? "");
  });
};
