// Loads `.env` via `process.loadEnvFile` and validates required keys
// (GitHub App credentials, repo, budget caps). Fails fast on missing values.

function main(): void {
  process.stderr.write("not implemented\n");
  process.exitCode = 1;
}

// Library module: only run when executed directly, never on import.
if (import.meta.main) {
  main();
}
