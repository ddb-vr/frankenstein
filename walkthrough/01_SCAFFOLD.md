# Frankenstein – repo scaffolding

Scaffold this repository exactly as specified below. Keep it minimal: create structure, config and stubs only. Do NOT implement any business logic, do NOT write any skill, do NOT add dependencies beyond the ones listed. When done, run `npm install`, `npm run check` and `npm run typecheck` and make sure both pass.

## Context

Frankenstein is a Claude Code agent that detects missing capabilities from a task, builds them as Agent Skills (SKILL.md + Node.js scripts + tests), tests them in a Docker sandbox, gets them reviewed and installs them into `.claude/skills/`. Everything the agent writes to GitHub goes through a GitHub App (bot identity). The repo must work identically on macOS and Windows, in Claude Code CLI and desktop GUI.

## Hard constraints

- Node.js 24, pure ESM only (`"type": "module"`), no CommonJS anywhere, no `require`.
- TypeScript runs natively via Node 24 type stripping. No build step, no `tsc` emit, no `ts-node`/`tsx`.
  - Use only erasable syntax (no `enum`, no `namespace`, no parameter properties).
  - Relative imports must use the `.ts` extension.
- Biome + Ultracite as linter and formatter. Initialize with `npx ultracite@latest init` (choose Biome; enable Claude Code integration if offered). No ESLint, no Prettier.
- Cross-platform: all scripts and hooks are invoked as `node <file>.ts`. No bash scripts.
- No runtime dependencies for now. Dev dependencies only: `typescript`, `@types/node`, `@biomejs/biome`, `ultracite`.

## Files

### package.json

- `"name": "frankenstein"`, `"private": true`, `"type": "module"`, `"engines": { "node": ">=24" }`
- Scripts:
  - `check` – Ultracite/Biome check (lint + format check)
  - `fix` – Ultracite/Biome fix
  - `typecheck` – `tsc --noEmit`
  - `test` – `node --test "scripts/**/*.test.ts"`
  - `sandbox:build` – `docker build -t frankenstein-sandbox sandbox`

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "noEmit": true,
    "strict": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["scripts/**/*.ts", ".claude/**/*.ts"]
}
```

### Other root files

- `.nvmrc` → `24`
- `.gitattributes` → `* text=auto eol=lf` (Windows teammate)
- `.editorconfig` → LF, 2 spaces, UTF-8, final newline
- `.gitignore` → `node_modules/`, `.env`, `logs/`, `work/*` (keep `work/.gitkeep`)
- `.env.example` with empty keys: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_REPO` (owner/name), `BUDGET_USD_PER_RUN`, `MAX_BUILDER_ITERATIONS`
- `registry.json` → `{ "skills": [] }`
- `README.md` → short: what it is, requirements (Node 24, Docker), setup steps, npm scripts

### Directory structure

```text
.claude/
├── settings.json            # permissions + hooks (hooks section empty for now)
├── agents/
│   ├── prd.md
│   ├── prd-reviewer.md
│   ├── skill-builder.md
│   └── skill-reviewer.md
└── skills/
    └── frankenstein/
        └── SKILL.md         # meta-skill stub for the main agent
CLAUDE.md                    # main agent system prompt stub
scripts/
├── lib/
│   └── env.ts               # load + validate .env (process.loadEnvFile)
├── hooks/
│   ├── guard-examples.ts    # will block writes to work/**/examples.json during build
│   ├── gate-install.ts      # will block writes to .claude/skills/ without green tests + approval
│   └── budget.ts            # will cap builder iterations and USD spend per run
├── run-examples.ts          # integration test runner over examples.json (in sandbox)
├── sandbox.ts               # docker run wrapper with isolation flags
├── registry.ts              # list / disable / rollback skills, versions via git tags
├── github-app-token.ts      # GitHub App JWT -> installation token (node:crypto, no deps)
└── tracker.ts               # gh issue lifecycle: open / blocked / done
sandbox/
└── Dockerfile               # node:24-slim, non-root user "node", workdir /skill
fixtures/.gitkeep
work/.gitkeep
logs/.gitkeep
```

### Stub rules

- Every `scripts/**/*.ts` file: a short header comment describing its responsibility, a typed `main()` that prints `not implemented` to stderr and exits with code 1. Hooks (`scripts/hooks/*`) instead exit 0 for now, so they never block.
- `.claude/agents/*.md`: valid subagent frontmatter (`name`, `description`, `model`, `tools`) + a 3–5 line role description. Models: `prd` sonnet, `prd-reviewer` opus, `skill-builder` sonnet, `skill-reviewer` opus.
  - prd: estimates user intent, drafts questions for the user (returned to the main agent, never asked directly), writes the source of truth summary and `examples.json`.
  - prd-reviewer: checks the PRD makes sense and the skill is implementable.
  - skill-builder: implements the skill (SKILL.md, scripts, unit tests) against the locked `examples.json`; invoked repeatedly with fresh context, state lives in `work/<skill>/progress.md`.
  - skill-reviewer: verdict approve/reject against the source of truth, SKILL.md quality and test results.
- `.claude/skills/frankenstein/SKILL.md`: valid frontmatter (`name`, `description`) + the lifecycle as a numbered list: gap detection → PRD + questions → source of truth confirmed by user → PRD review → open issue → build loop → final review → install (commit + tag `skill/<name>@vN` as bot) → close issue with cost. Mark details as TODO.
- `CLAUDE.md`: role of the main agent (orchestrator, decides if a skill exists, asks user the PRD questions, owns the GitHub issue), hard rules (generated code only in sandbox, no install without passing tests, caps enforced in code), repo conventions (Node 24, ESM, `.ts` imports, run `npm run check` before finishing).
- `.claude/settings.json`: permissions allowing `node`, `npm run *`, `docker`, `git`, `gh`; deny reading `.env` and the GitHub App private key; empty `"hooks": {}`.
- `sandbox/Dockerfile`: `FROM node:24-slim`, `USER node`, `WORKDIR /skill`, no npm install, `ENTRYPOINT ["node"]`.

## Done when

- `npm run check` and `npm run typecheck` pass.
- `node scripts/tracker.ts` runs (prints not implemented) on Node 24 without any build step.
- Initial commit: `chore: scaffold frankenstein repo`.
