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
