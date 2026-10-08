// PreToolUse hook: will block writes to `.claude/skills/` unless the skill
// has green tests and an approval verdict from the skill-reviewer.

function main(): void {
  // Hooks must never block until implemented.
  process.exitCode = 0;
}

main();
