// Loads the repo's `.env` (GitHub credentials, repo, budget caps) via
// `process.loadEnvFile`, validates required variables and picks the tracker
// backend. Variables already set in the environment win; `.env` is optional.

import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");

/** Loads `<root>/.env` when present; a missing file is not an error. */
export const loadDotEnv = (root: string = REPO_ROOT): void => {
  try {
    process.loadEnvFile(path.join(root, ".env"));
  } catch (error) {
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) {
      throw error;
    }
  }
};

/** What the GitHub App bot needs (see `scripts/github-app-token.ts`). */
export const GITHUB_APP_ENV = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY_PATH",
  "GITHUB_APP_INSTALLATION_ID",
] as const;

/**
 * Where build issues live and how registry changes are committed:
 * - `github-app`: the three `GITHUB_APP_ENV` variables are set. GitHub issues,
 *   commits, tags and pushes as the GitHub App bot.
 * - `pat`: else `GH_TOKEN` and `GITHUB_REPO` are set. The same GitHub issue
 *   calls as the token's user; commits and tags stay local.
 * - `local`: otherwise. Issues in `tracker/issues/<n>.md`; commits and tags
 *   stay local.
 */
export type TrackerBackend = "github-app" | "pat" | "local";

const isSet = (
  env: Readonly<Record<string, string | undefined>>,
  name: string
): boolean => Boolean(env[name]?.trim());

export const selectTrackerBackend = (
  env: Readonly<Record<string, string | undefined>> = process.env
): TrackerBackend => {
  if (GITHUB_APP_ENV.every((name) => isSet(env, name))) {
    return "github-app";
  }
  if (isSet(env, "GH_TOKEN") && isSet(env, "GITHUB_REPO")) {
    return "pat";
  }
  return "local";
};

const BACKEND_DESCRIPTIONS: Record<TrackerBackend, string> = {
  "github-app": "GitHub issues, commits, tags and pushes as the GitHub App bot",
  local:
    "issues in tracker/issues/, commits and tags stay local as frankenstein-bot",
  pat: "GitHub issues as the GH_TOKEN user, commits and tags stay local as frankenstein-bot",
};

/** One log line naming the backend, for stderr (stdout stays one JSON line). */
export const describeTrackerBackend = (backend: TrackerBackend): string =>
  `tracker backend: ${backend} (${BACKEND_DESCRIPTIONS[backend]})\n`;

/** Throws one error naming every variable in `names` that is unset or empty. */
export const requireEnvVars = (
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): void => {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var${missing.length === 1 ? "" : "s"} ${missing.join(", ")}: set ${
        missing.length === 1 ? "it" : "them"
      } in .env (see .env.example)`
    );
  }
};
