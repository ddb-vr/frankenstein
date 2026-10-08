// Loads the repo's `.env` (GitHub App credentials, repo, budget caps) via
// `process.loadEnvFile` and validates required variables. Variables already
// set in the environment win.

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

/** Throws one error naming every variable in `names` that is unset or empty. */
export const requireEnvVars = (
  names: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): void => {
  const missing = names.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var${missing.length === 1 ? "" : "s"} ${missing.join(", ")}: set ${missing.length === 1 ? "it" : "them"} in .env (see .env.example)`
    );
  }
};
