// PreToolUse hook: will block writes to `work/**/examples.json` during the
// build phase, so the skill-builder cannot edit its locked acceptance examples.

function main(): void {
  // Hooks must never block until implemented.
  process.exitCode = 0;
}

main();
