# Frankenstein

A Claude Code agent that detects missing capabilities in a task, builds them as Agent Skills (SKILL.md + Node.js scripts + tests), tests them in a Docker sandbox, gets them reviewed and installs them into `.claude/skills/`. All GitHub writes go through a GitHub App (bot identity).

## Requirements

- Node.js 24 (`.nvmrc`)
- Docker

## Setup

```sh
npm install
cp .env.example .env   # fill in GitHub App credentials and caps
npm run sandbox:build
```

## Scripts

| Script | Description |
| --- | --- |
| `npm run check` | Lint + format check (Ultracite/Biome) |
| `npm run fix` | Auto-fix lint + format issues |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Run `scripts/**/*.test.ts` with `node --test` |
| `npm run sandbox:build` | Build the `frankenstein-sandbox` Docker image |

## Skill test runner

```sh
node scripts/run-examples.ts <skillDir>   # e.g. fixtures/skills/text-stats
```

Validates `examples.json`, runs `tests/**/*.test.ts` and every example inside the sandbox (`scripts/sandbox.ts`: no network, read-only root and mount, no host env). Prints one JSON summary line (exit 0 on PASS, 1 on FAIL). Full output goes to `logs/<skill>/<timestamp>.log`; follow a run live with `tail -f logs/<skill>/latest.log` (Windows: `Get-Content -Wait`).

Skill contract:

- Layout: `SKILL.md`, `examples.json`, `scripts/main.ts` (entry), optional `tests/*.test.ts` and `fixtures/`.
- Entry reads one JSON value from stdin and writes one JSON value to stdout (exit 0); handled errors write `{ "error": "<message>" }` and exit 1.
- With `FRANKENSTEIN_MODE=test` the skill must not touch the network; recorded responses live in `/skill/fixtures/`.
- `examples.json`: `{ skill, entry, examples: [{ name, input, expected, match? }] }`; `match` is `"exact"` (default) or `"subset"`; `"expected": { "error": true }` expects a handled error. Schema and validator: `scripts/lib/examples.ts`.

## Hard rules in code

Claude Code hooks (`.claude/settings.json`, `scripts/hooks/`) and permission deny rules enforce the build rules; prompts only explain them.

| Rule | Mechanism |
| --- | --- |
| `examples.json` is locked once the user confirms the source of truth | `node scripts/lock.ts <skill>` writes `work/.locks/<skill>.json` (sha256 + timestamp); `guard-files.ts` denies edits while it exists |
| Nothing lands in `.claude/skills/` except through the install script | `Edit(/.claude/skills/**)` deny rule; `guard-files.ts` and `guard-bash.ts` deny writes and shell access |
| Install only with passing tests and an approve verdict | `node scripts/registry.ts install` checks lock hash, `review.json` and a fresh `run-examples`; `review.json` is written only by `capture-review.ts` (SubagentStop) from the `skill-reviewer`'s final `verdict` block, max 2 review rounds, an approve is final |
| Generated code never executes on the host | `guard-bash.ts` denies runtimes (`node`, `npx`, `tsx`, `deno`, `bun`, `python`, …) on `work/`, `.claude/skills/`, `fixtures/skills/` and docker/`--network` outside the sandbox scripts |
| Builder iterations and USD spend per run are capped | `budget.ts` counts `skill-builder` calls and sums transcript usage (`MAX_BUILDER_ITERATIONS`, `BUDGET_USD_PER_RUN` in `.env`) |

Hooks fail closed: a PreToolUse hook error denies the tool call; a `capture-review.ts` error records no verdict, so install keeps refusing. `guard-files.ts` also protects `scripts/`, `registry.json`, the Claude settings files and `work/<skill>/review.json`. Shell entry points that always pass (exactly, from the repo root): `node scripts/{run-examples,run-skill,registry,lock,tracker,record-fixture}.ts`, `npm test`, `npm run check`, `npm run typecheck` and read-only `git` (`status`, `log`, `diff`, `show`, …).

```sh
node scripts/lock.ts <skill>                                  # after the user confirms examples.json
node scripts/registry.ts install <skill> [--issue <n>] [--network]
node scripts/run-skill.ts <name> '<json input>'               # run an installed, enabled skill
```

- `install` copies `work/<skill>` (without `progress.md`, `review.json`, `issue.json`) to `.claude/skills/<skill>`, bumps the version (`v1`, `v2`, …), updates `registry.json` and commits, tags `skill/<skill>@vN` and pushes as the bot. The issue defaults to `work/<skill>/issue.json`, written by `tracker.ts open`. Prints `{ "installed", "version", "commit" }` or `{ "installed": false, "reason" }` (exit 1).
- `run-skill` runs `scripts/main.ts` in the sandbox without `FRANKENSTEIN_MODE=test`, with network per the registry entry; prints the skill's JSON output, full stderr in `logs/<name>/run-<timestamp>.log`.
- Budget state lives in `work/.run/<session_id>.json`; `work/.run/current.json` points to the session of the latest tool call. Over budget, only `node scripts/tracker.ts` may run; `tracker.ts done` without `--usage` reports the usage of the session in `current.json`.

Known limitations:

- The verdict in `review.json` is still LLM output: the hook records whatever a `skill-reviewer` subagent ends with, and the main agent chooses the reviewer's prompt.
- `guard-bash.ts` is a heuristic second layer (quotes, chains, `sh -c`, substitutions are handled; arbitrary obfuscation is not). Entry points are trusted only without `cd`, substitutions or protected redirect targets.
- Spend only counts models priced in `scripts/lib/pricing.ts`; usage from any other model makes the budget hook deny every call (fail closed). 1-hour cache writes are priced at the 5-minute rate.
- Claude Code writes transcripts asynchronously, so spend lags by the messages not yet flushed (typically the current turn) and a run can overshoot the cap by that much.
- The hooks also apply to anyone editing this repo with Claude Code (`scripts/` is protected); maintainers disable them locally in `.claude/settings.local.json` (`"disableAllHooks": true`).

## Build flow

After the intake locks a PRD-reviewed `work/<skill>/`, the main agent follows the "Build, review, install" section of `.claude/skills/frankenstein/SKILL.md`: `tracker.ts open` → `skill-builder` loop (fresh context per call, state in `progress.md`) → `skill-reviewer` (one extra build + review after a reject) → `registry.ts install` → `tracker.ts done` → answers the user with the new skill via `run-skill.ts`. Any cap, a second reject, an `impossible` builder or a refused install ends in `tracker.ts blocked`.
