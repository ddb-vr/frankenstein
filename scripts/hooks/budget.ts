// Hook: will cap skill-builder iterations (`MAX_BUILDER_ITERATIONS`) and
// USD spend per run (`BUDGET_USD_PER_RUN`).

function main(): void {
  // Hooks must never block until implemented.
  process.exitCode = 0;
}

main();
