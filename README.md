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
