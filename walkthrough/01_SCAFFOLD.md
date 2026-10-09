# Frankenstein – repo scaffolding

Scaffold this repository exactly as specified below. Keep it minimal: create structure, config and stubs only. Do NOT
implement any business logic, do NOT write any skill, do NOT add dependencies beyond the ones listed. When done, run
`npm install`, `npm run check` and `npm run typecheck` and make sure both pass.

> **Status (superseded parts):** this is the original scaffold spec (commit 302dfff). Walkthroughs 02–06 replaced
> the stubs with real implementations, so where the two differ the later walkthroughs and the current code are
> authoritative:
>
> - `scripts/hooks/guard-examples.ts` and `gate-install.ts` no longer exist. `guard-files.ts` (file writes, examples
>   lock, `.claude/skills/**`) and `guard-bash.ts` (shell) replaced them, and `scripts/registry.ts install` is the
>   only way into `.claude/skills/` (04_HOOKS). Hooks are no longer exit-0 stubs: `.claude/settings.json` wires
>   `budget.ts`, `guard-files.ts`, `guard-bash.ts` and `capture-review.ts`, and they fail closed.
> - No script prints `not implemented` any more. `registry.json` is no longer empty once a skill is installed.
> - `registry.ts` implements `install` only. `list`, `disable` and `rollback` are deferred: until they exist, edit
>   `registry.json` by hand (outside the agent) to disable a skill, and use the `skill/<name>@vN` tags to roll back.
> - Node 24.3 or newer is required: every entry point runs under `if (import.meta.main)`, which is always `false` in
>   `.ts` files on Node 24.2 and older, so hooks would silently allow everything there.

## Context

Frankenstein is a Claude Code agent that detects missing capabilities from a task, builds them as Agent Skills
(SKILL.md + Node.js scripts + tests), tests them in a Docker sandbox, gets them reviewed and installs them into
`.claude/skills/`. Everything the agent writes to GitHub goes through a GitHub App (bot identity). The repo must work
identically on macOS and Windows, in Claude Code CLI and desktop GUI.

## Hard constraints

- Node.js 24.3+ (`import.meta.main` in `.ts` files), pure ESM only (`"type": "module"`), no CommonJS anywhere, no
  `require`.
- TypeScript runs natively via Node 24 type stripping. No build step, no `tsc` emit, no `ts-node`/`tsx`.
  - Use only erasable syntax (no `enum`, no `namespace`, no parameter properties).
  - Relative imports must use the `.ts` extension.
- Biome + Ultracite as linter and formatter. Initialize with `npx ultracite@latest init` (choose Biome; enable Claude
  Code integration if offered). No ESLint, no Prettier.
- Cross-platform: all scripts and hooks are invoked as `node <file>.ts`. No bash scripts.
- No runtime dependencies for now. Dev dependencies only: `typescript`, `@types/node`, `@biomejs/biome`, `ultracite`.

## Files

### package.json

- `"name": "frankenstein"`, `"private": true`, `"type": "module"`, `"engines": { "node": ">=24.3.0" }`
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

- `.nvmrc` → `24.3`
- `.gitattributes` → `* text=auto eol=lf` (Windows teammate)
- `.editorconfig` → LF, 2 spaces, UTF-8, final newline
- `.gitignore` → `node_modules/`, `.env`, `*.pem`, `logs/*` with `!logs/.gitkeep`, `work/*` with `!work/.gitkeep`
  (ignore the directory contents, not the directories, so the `.gitkeep` files stay tracked)
- `.env.example` with empty keys: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID`,
  `GITHUB_REPO` (owner/name), `BUDGET_USD_PER_RUN`, `MAX_BUILDER_ITERATIONS`
- `registry.json` → `{ "skills": [] }` (initial content; `registry.ts install` adds entries)
- `README.md` → short: what it is, requirements (Node 24.3+, Docker), setup steps, npm scripts

### Directory structure

```text
.claude/
├── settings.json            # permissions + hooks (scaffold: hooks empty; now wires the four hooks)
├── agents/
│   ├── prd-reviewer.md
│   ├── prd-writer.md
│   ├── skill-builder.md
│   └── skill-reviewer.md
└── skills/
    └── frankenstein/
        └── SKILL.md         # meta-skill stub for the main agent
CLAUDE.md                    # main agent system prompt stub
scripts/
├── lib/
│   └── env.ts               # load .env (loadDotEnv) + validate required vars (requireEnvVars, GITHUB_APP_ENV)
├── hooks/                   # superseded, see 04_HOOKS: guard-files.ts, guard-bash.ts, capture-review.ts
│   ├── guard-examples.ts    # (scaffold only) → guard-files.ts
│   ├── gate-install.ts      # (scaffold only) → guard-files.ts + guard-bash.ts + registry.ts install
│   └── budget.ts            # caps builder iterations and USD spend per run
├── run-examples.ts          # integration test runner over examples.json (in sandbox)
├── sandbox.ts               # docker run wrapper with isolation flags
├── registry.ts              # install (copy + registry + commit/tag/push as bot, rollback on failure); list / disable / rollback deferred
├── github-app-token.ts      # GitHub App JWT -> installation token (node:crypto, no deps)
└── tracker.ts               # gh issue lifecycle: open / blocked / done
sandbox/
└── Dockerfile               # node:24-slim, non-root user "node", workdir /skill
fixtures/.gitkeep
work/.gitkeep
logs/.gitkeep
```

### Stub rules

- Every `scripts/**/*.ts` file: a short header comment describing its responsibility, a typed `main()` that prints
  `not implemented` to stderr and exits with code 1. Hooks (`scripts/hooks/*`) instead exit 0 for now, so they never
  block. (Scaffold only: all stubs are implemented now and hooks fail closed.)
- `.claude/agents/*.md`: valid subagent frontmatter (`name`, `description`, `model`, `tools`) + a 3–5 line role
  description. Models: `prd-writer` sonnet, `prd-reviewer` opus, `skill-builder` sonnet, `skill-reviewer` opus.
  - prd-writer: estimates user intent, drafts questions for the user (returned to the main agent, never asked
    directly), writes the source of truth summary and `examples.json`.
  - prd-reviewer: checks the PRD makes sense and the skill is implementable.
  - skill-builder: implements the skill (SKILL.md, scripts, unit tests) against the locked `examples.json`; invoked
    repeatedly with fresh context, state lives in `work/<skill>/progress.md`.
  - skill-reviewer: verdict approve/reject against the source of truth, SKILL.md quality and test results.
- `.claude/skills/frankenstein/SKILL.md`: valid frontmatter (`name`, `description`) + the lifecycle as a numbered list:
  gap detection → PRD + questions → PRD review → source of truth confirmed by user (examples locked) → open issue →
  build loop → final review → install (commit + tag `skill/<name>@vN` as bot) → close issue with cost. Mark details as
  TODO (scaffold only; the Intake and Build sections now specify them).
- `CLAUDE.md`: role of the main agent (orchestrator, decides if a skill exists, asks user the PRD questions, owns the
  GitHub issue), hard rules (generated code only in sandbox, no install without passing tests, caps enforced in code),
  repo conventions (Node 24, ESM, `.ts` imports, run `npm run check` before finishing).
- `.claude/settings.json`: permissions allowing `node`, `npm run *`, `docker` and read-only `git` (`status`, `log`,
  `diff`, `show`, `blame`, `describe`, `ls-files`, `rev-parse`). Deny `gh`, `git commit`/`tag`/`push`,
  `git diff --no-index`, reading `.env` and any `*.pem` (the GitHub App private key). GitHub writes go only through
  `scripts/tracker.ts` and `scripts/registry.ts` as the bot. Shell reads that bypass the `Read` deny rules are blocked
  by `guard-bash.ts`. (The scaffold had `git`, `gh` and an empty `"hooks": {}`.)
- `sandbox/Dockerfile`: `FROM node:24-slim`, `USER node`, `WORKDIR /skill`, no npm install, `ENTRYPOINT ["node"]`.

## Done when

- `npm run check` and `npm run typecheck` pass.
- `node scripts/tracker.ts` runs on Node 24.3+ without any build step (at scaffold time it printed `not implemented`).
- Initial commit: `chore: scaffold frankenstein repo`.
