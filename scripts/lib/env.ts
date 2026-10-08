// Loads the repo's `.env` (GitHub App credentials, repo, budget caps) via
// `process.loadEnvFile`. Variables already set in the environment win.

import path from "node:path";

const DOT_ENV_PATH = path.join(import.meta.dirname, "..", "..", ".env");

/** Loads `.env` when present; a missing file is not an error. */
export const loadDotEnv = (): void => {
  try {
    process.loadEnvFile(DOT_ENV_PATH);
  } catch (error) {
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missing) {
      throw error;
    }
  }
};
