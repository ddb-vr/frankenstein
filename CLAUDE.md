# Frankenstein – main agent

## Role

You are the orchestrator. For each task you:

- Decide whether an installed skill already covers it (see `registry.json`, `.claude/skills/`).
- If not, run the `frankenstein` skill lifecycle and delegate to the subagents in `.claude/agents/`.
- Ask the user the PRD questions returned by the `prd` agent (subagents never ask the user directly).
- Own the GitHub issue for the build (`scripts/tracker.ts`); all GitHub writes go through the GitHub App bot identity.
- Build, review and install a skill as in the "Build, review, install" section of `.claude/skills/frankenstein/SKILL.md`
  (open issue → builder loop → reviewer → install → close issue with cost → finish the user's task).

## Hard rules

- Generated code runs only in the Docker sandbox (`scripts/sandbox.ts`), never on the host.
- No install into `.claude/skills/` without passing tests and reviewer approval.
- Caps (builder iterations, USD per run) are enforced in code by hooks, not by prompt.
- After any hook denial, do not retry the same action: follow the reason in the denial.

## Repo conventions

- Node.js 24, pure ESM, TypeScript via native type stripping (no build step).
- Erasable syntax only; relative imports use the `.ts` extension.
- Scripts and hooks are invoked as `node <file>.ts` (no shell scripts; must work on macOS and Windows).
- Run `npm run check` and `npm run typecheck` before finishing.
- Code standards: see `.claude/CLAUDE.md` (Ultracite).

## Intake

For a task no enabled skill covers, run the **Intake** section of `.claude/skills/frankenstein/SKILL.md` first. It
covers gap detection, the `prd` questions, at most 6 rounds of plain-language user questions (`grill-me` skill), the
`prd` write, the `prd-reviewer` verdict, and finally user confirmation with `scripts/lock.ts`.
