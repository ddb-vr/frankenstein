# Frankenstein: technical reference

A Claude Code agent that detects missing capabilities in a task, builds them as Agent Skills (SKILL.md + Node.js
scripts + tests), tests them in a Docker sandbox, gets them reviewed and installs them into `.claude/skills/`. All
GitHub writes go through a GitHub App (bot identity).

## Requirements

- Node.js 24.3 or newer (`.nvmrc`; the scripts rely on `import.meta.main`, which is always `false` in `.ts` files on
  24.2)
- Docker

## Setup

```sh
npm install
cp .env.example .env   # fill in GitHub App credentials and caps
npm run sandbox:build
```

`FIXTURE_ALLOWED_DOMAINS` in `.env` lists the domains `scripts/record-fixture.ts` may record API responses from
(comma-separated, subdomains included). The recorder reads it only from `.env`; a value set in the shell is ignored.
The ARES demo needs `FIXTURE_ALLOWED_DOMAINS=ares.gov.cz` (the `.env.example` default).

`INPUT_ALLOWED_ROOTS` in `.env` lists the directories whose files `scripts/run-skill.ts --mount` may hand to a skill
(comma-separated, repo-relative or absolute; empty: `demo/data,inputs`). Like the fixture allowlist, it is read only
from `.env`. `inputs/` and the skills' output directory `out/` are gitignored.

## Scripts

| Script                  | Description                                                                       |
|-------------------------|-----------------------------------------------------------------------------------|
| `npm run check`         | Lint + format check (Ultracite/Biome)                                             |
| `npm run fix`           | Auto-fix lint + format issues                                                     |
| `npm run typecheck`     | `tsc --noEmit`                                                                    |
| `npm test`              | Run `scripts/**/*.test.ts` with `node --test`                                     |
| `npm run sandbox:build` | Build the `frankenstein-sandbox` Docker image                                     |
| `npm run skills -- …`   | Skill registry: `scripts/registry.ts` (see [Operator control](#operator-control)) |
| `npm run demo:reset`    | Remove every skill with its tags, clear `work/` and `logs/`                       |

## Skill test runner

```sh
node scripts/run-examples.ts <skillDir>   # e.g. fixtures/skills/text-stats
```

Validates `examples.json`, runs `tests/**/*.test.ts` and every example inside the sandbox (`scripts/sandbox.ts`: no
network, read-only root and mount, no host env). Then a `lint` stage runs the repo's Biome rules (`.gitignore` not
applied) and `tsc` on every file install copies (`scripts/lib/skill-lint.ts`); `node scripts/fix-skill.ts <skill>`
applies Biome's safe fixes to `work/<skill>/` (never the locked `examples.json`, which `lock.ts` formats before
hashing). Prints one JSON summary line (exit 0 on PASS, 1 on FAIL). Full output
goes to `logs/<skill>/<timestamp>.log`; follow a run live with `tail -f logs/<skill>/latest.log` (Windows:
`Get-Content -Wait`). Every sandbox run in a log starts with `sandbox: container=frk-… exit=… durationMs=…` and the
exact `docker argv` (env values redacted), followed by one `mount: <host> -> <container> (ro|rw)` line per mount, so
the log proves where the code ran and what it could see. Each example gets a fresh temp directory as `/output`
(deleted afterwards), so skills that write files work in tests; only stdout is compared.

Skill contract:

- Layout: `SKILL.md`, `examples.json`, `scripts/main.ts` (entry), optional `tests/*.test.ts` and `fixtures/`.
- Entry reads one JSON value from stdin and writes one JSON value to stdout (exit 0); handled errors write
  `{ "error": "<message>" }` and exit 1.
- With `FRANKENSTEIN_MODE=test` the skill must not touch the network; recorded responses live in `/skill/fixtures/`.
- Input files arrive as **paths in the JSON input**: under `/input/` at runtime (`run-skill.ts --mount`, read-only) and
  under `/skill/fixtures/input/` in tests (test files are part of the skill: `fixtures/input/…`, referenced in
  `examples.json` as `/skill/fixtures/input/<file>`). Never hardcode either prefix; always use the path from the input.
- If `/output` exists, large results go there as files; stdout stays a compact JSON summary (counts, totals, file
  names). Without `--output`, `/output` does not exist and the root filesystem is read-only.
- Decode text explicitly with `TextDecoder` and the detected or stated encoding (e.g. `windows-1250` for Czech bank
  exports), `fatal: true` so a wrong encoding fails instead of producing mojibake. Verified: `node:24-slim` ships full
  ICU and decodes `windows-1250` correctly (`fixtures/skills/line-count`: a cp1250 export with `ě`, `ř`, `ž`, `ů`, `–`
  decodes to the original text in the sandbox, both in its unit tests and via `run-skill.ts --mount`).
- User data never passes through the model: the agent mounts files with `--mount`, asks the skill for a summary and
  points the user to the files in `out/`; it never reads user data files into its context (the `prd` agent may read the
  first few lines of a file to learn its format).
- `examples.json`: `{ skill, entry, examples: [{ name, input, expected, match? }] }`; `match` is `"exact"` (default) or
  `"subset"`; `"expected": { "error": true }` expects a handled error. Schema and validator: `scripts/lib/examples.ts`.

## Hard rules in code

Claude Code hooks (`.claude/settings.json`, `scripts/hooks/`) and permission deny rules enforce the build rules; prompts
only explain them.

| Rule                                                                 | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|----------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `examples.json` is locked once the user confirms the source of truth | `node scripts/lock.ts <skill>` writes `work/.locks/<skill>.json` (sha256 + timestamp); `guard-files.ts` denies edits while it exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Nothing lands in `.claude/skills/` except through the install script | `Edit(/.claude/skills/**)` deny rule; `guard-files.ts` and `guard-bash.ts` deny writes and shell access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Only a human overrides the registry                                  | `guard-bash.ts` denies `registry.ts disable/enable/rollback/remove`, `npm run skills -- <those>` and the demo reset in any form; `Edit(/.claude/disabled-skills/**)` deny rule and `guard-files.ts` deny writes to disabled skills                                                                                                                                                                                                                                                                                                                                                                  |
| Install only with passing tests and an approve verdict               | `node scripts/registry.ts install` checks lock hash, `review.json` (approve, and its `examplesHash` equals the lock) and a fresh `run-examples`; `review.json` is written only by `capture-review.ts` from the `skill-reviewer`'s single `verdict` block (SubagentStop, or the `SubagentHandback` report in auto mode); each new review supersedes the previous one; a missing, duplicated or invalid block gets one retry, then a `reject` (`no valid verdict block`) is recorded; history in `logs/<skill>/reviews.log`                                                                           |
| Generated code never executes on the host                            | `guard-bash.ts` allows interpreters and package managers (`node`, `npx`, `tsx`, `ts-node`, `bun`, `deno`, `python`, `npm`, …) only as an exact entry point from the repo root, not fed by a pipe, also inside chains, pipes, subshells, `bash -c`, substitutions and wrappers (`env`, `xargs`, `find -exec`); denies `node -e`/`--eval`/`-p`/`--input-type`, `node --test` outside `npm test`, code-loading env vars (`NODE_OPTIONS`, …), shells without `-c`, `cd` into and interpreters inside `work/`, `.claude/skills/`, `fixtures/skills/`, and docker/`--network` outside the sandbox scripts |
| Builder iterations and USD spend per run are capped                  | `budget.ts` counts `skill-builder` calls and sums transcript usage (`MAX_BUILDER_ITERATIONS`, `BUDGET_USD_PER_RUN` in `.env`); over budget only a plain `tracker.ts` call and a Read of `work/<skill>/issue.json` pass                                                                                                                                                                                                                                                                                                                                                                              |
| User files reach a skill only read-only, never through the model    | `run-skill.ts --mount` mounts files read-only at `/input/<basename>` (same basename twice → error) only after `scripts/lib/mount-policy.ts` accepts them: real path (symlinks resolved) inside `INPUT_ALLOWED_ROOTS`, and never `.env*`, `*.pem`, `.git`, `.claude` (also inside a mounted directory), the repo's `scripts/` or `work/.locks/`, or the home directory (or an ancestor); `--output` must resolve inside `out/`, mounted read-write at `/output`; any violation exits 1 before the sandbox starts; `guard-files.ts` denies agent writes under `out/` |

Hooks fail closed: a PreToolUse hook error denies the tool call; a `capture-review.ts` error records no verdict, so
install keeps refusing. Every hook decision is appended to `logs/hooks.log` (tab-separated: time, hook,
`allow`/`deny`/`block`, short reason, command or file truncated to 200 chars). `guard-files.ts` also protects
`scripts/`, `registry.json`, the Claude settings files, `work/.run/`, `work/<skill>/review.json` and `out/`, matching
the target both as given and with symlinks resolved. `guard-bash.ts` also denies shell access to `.env`/`*.pem` (except
`.env.example`) and `work/.run/`, and creating symlinks or hard links. Shell entry points that always pass (exactly,
from the repo root):
`node scripts/{run-examples,run-skill,registry,lock,tracker,record-fixture,fix-skill,audit-run}.ts …`, `npm test`,
`npm run check`, `npm run typecheck`, `npm run sandbox:build` (npm ones without extra arguments) and read-only `git`
(`status`, `log`, `diff`, `show`, …). `.claude/settings.json` pre-approves only that read-only `git` subset and denies
`gh`, `git commit`/`tag`/`push` and reads of `.env`/`*.pem`: GitHub writes go through `scripts/tracker.ts` and
`scripts/registry.ts` as the bot.

```sh
node scripts/lock.ts <skill>                                  # after the user confirms examples.json
node scripts/fix-skill.ts <skill>                             # Biome safe fixes + lint report for work/<skill>
node scripts/registry.ts install <skill> [--issue <n>] [--network]
node scripts/registry.ts list [--json]                        # installed skills (agent may run it)
node scripts/registry.ts show <name> [--json]                 # history + version tags (agent may run it)
node scripts/run-skill.ts <skill> '<json>' [--mount <path>]... [--output <dir>]            # run an installed, enabled skill
node scripts/run-skill.ts <skill> --input-file <path> [--mount <path>]... [--output <dir>] # JSON input from a file
```

- `install` copies `work/<skill>` (without `progress.md`, `review.json`, `issue.json`) to `.claude/skills/<skill>`,
  bumps the version (`v1`, `v2`, …), updates `registry.json` (appending an `install` history entry with the cost of the
  current Claude Code session, `null` when unknown) and commits, tags `skill/<skill>@vN` and pushes as the bot.
  The issue defaults to `work/<skill>/issue.json`, written by `tracker.ts open`. Prints
  `{ "installed", "version", "commit" }` or `{ "installed": false, "reason" }` (exit 1). The bot credentials
  (`GITHUB_APP_*` in `.env`) are checked and resolved before anything changes; a failed copy, commit, tag or push
  restores the previous `.claude/skills/<skill>`, `registry.json`, index, HEAD and tag.
- `run-skill` runs `scripts/main.ts` in the sandbox without `FRANKENSTEIN_MODE=test`, with network per the registry
  entry; prints the skill's JSON output, full stderr in `logs/<name>/run-<timestamp>.log`. The JSON input is the
  argument or the `--input-file` content (exactly one; stdin is not read, and `guard-bash.ts` denies piping into
  entry points), and is passed to the skill on its stdin.
- `--mount <path>` (repeatable) mounts a file or directory read-only at `/input/<basename>` (the basename as given; the
  source is its real path); `--output <dir>` creates `<dir>` inside `out/` if needed and mounts it read-write at
  `/output`. The skill gets only the paths, in its JSON input, e.g.
  `node scripts/run-skill.ts bank-match '{"statement":"/input/bank.csv"}' --mount demo/data/bank.csv --output out/bank`.
  A path the policy refuses prints `{ "error": "mount denied: <path>: <reason>" }` (or `output denied: …`) and exits 1
  before anything starts; the run log lists every mount.
- Budget state lives in `work/.run/<session_id>.json`; `work/.run/current.json` points to the session of the latest tool
  call. Over budget, only `node scripts/tracker.ts` may run; `tracker.ts done` without `--usage` reports the usage of
  the session in `current.json`.

Known limitations:

- The verdict in `review.json` is still LLM output: the hook records whatever a `skill-reviewer` subagent ends with, and
  the main agent chooses the reviewer's prompt.
- `guard-bash.ts` is a heuristic second layer (quotes, chains, `sh -c`, substitutions, wrappers and dynamic command
  names are handled; code smuggled in as data for a non-interpreter tool is not). Entry points are trusted only
  without `cd`, substitutions, protected redirect targets or piped input.
- Spend only counts models priced in `scripts/lib/pricing.ts`; usage from any other model makes the budget hook deny
  every call (fail closed). 1-hour cache writes are priced at the 5-minute rate.
- Claude Code writes transcripts asynchronously, so spend lags by the messages not yet flushed (typically the current
  turn) and a run can overshoot the cap by that much.
- The hooks also apply to anyone editing this repo with Claude Code (`scripts/` is protected); maintainers disable them
  locally in `.claude/settings.local.json` (`"disableAllHooks": true`).
- `/output` is written by the container's `node` user. Docker Desktop (macOS, Windows) maps it to the host user; on a
  Linux host the output directory must be writable by uid 1000.

## Sandbox audit

```sh
node scripts/audit-run.ts [--session <id>]   # default: the session in work/.run/current.json; /audit in Claude Code
```

Deterministic (no LLM): parses the session's main and subagent transcripts (found via `work/.run/<id>.json`) and
cross-checks them with `logs/hooks.log` and the sandbox run logs started during the session. Prints one JSON line
`{ session, bashCommands, sandboxRuns, hostExecutions, denials, mounts: [{ log, mounts }], deniedMounts: [{ command, reason }], violations: [{ command, reason }] }`;
exits 1 when `hostExecutions > 0`, 2 when the audit cannot run.

- `hostExecutions`: shell calls that ran and executed code from `work/` or `.claude/skills/` (a runtime, package
  manager, shell, container CLI, script path or unverifiable command name, while the command line references skill code
  or runs inside a skill directory) other than through `node scripts/run-examples.ts` / `node scripts/run-skill.ts`
  from the repo root. Expected: 0.
- `denials`: tool calls rejected by a hook, a permission rule or the user (`permissionDecision` in the transcript).
- `mounts`: per run-skill log, its input and output mounts (`<host> -> <container> (ro|rw)`, read from the run records,
  never from the skill's stdout); logs without any are left out.
- `deniedMounts`: run-skill calls with `--mount`/`--output` that a hook, a permission rule or the user denied, or that
  the path policy refused (`mount denied: …` / `output denied: …`).
- `violations`: each host execution; executed shell calls without a `guard-bash` allow in `hooks.log`; hook denials
  missing from it; `run-examples` summaries whose log is missing or holds fewer sandbox records than passed examples;
  `run-skill` calls without a run log; run-skill logs without a sandbox record.
- `tracker.ts done` appends `**Sandbox audit:** sandbox runs N, host executions N, denials N, denied mounts N` to the
  closing comment (or why the audit was unavailable).
- Logs and hook decisions within 60 s of the session's first and last transcript line count as the session's; a
  concurrent session in the same repo blurs `sandboxRuns`.

## Operator control

A human inspects and overrides what the agent built, in a normal terminal (outside Claude Code, where the hooks do not
apply). `/skills [<name>]` in Claude Code is the read-only view: it runs `list`/`show` and names the terminal command
for any change.

```sh
npm run skills -- list [--json]                   # name, version, enabled, network, installed at, issue, total cost
npm run skills -- show <name> [--json]            # history + every tag skill/<name>@vN (commit, date, author)
npm run skills -- disable <name>                  # move to .claude/disabled-skills/, enabled: false
npm run skills -- enable <name>                   # move back, enabled: true
npm run skills -- rollback <name> [--to vN]       # restore from tag (default: previous tagged version)
npm run skills -- remove <name> [--delete-tags]   # delete skill + entry; with tags locally and on origin
npm run demo:reset [-- --yes]                     # remove --delete-tags for every skill; clear work/ and logs/
```

- Every `registry.json` entry carries `history`: `{ action, version, issue, costUsd, at, commit }` per `install`,
  `disable`, `enable` and `rollback`. `commit` is the HEAD the action was applied to (the action's own commit is its
  child and cannot name itself); entries from before `history` existed are migrated on read (`commit` and `costUsd`
  `null`).
- The changing commands need the bot credentials, commit as the bot (`chore(registry): <action> <name>`), push, and
  print one JSON line `{ action, name, ok, commit, version }` or `{ action, name, ok: false, reason }` (exit 1). A
  failure before the push restores the skill directories, `registry.json`, index and HEAD.
- `disable` moves the directory because Claude Code discovers skills from `.claude/skills/` by itself; `run-skill.ts`
  also refuses disabled skills, and `install` refuses a disabled skill until it is enabled or removed. A new Claude Code
  session picks up the change.
- `rollback` needs an enabled skill, restores `.claude/skills/<name>/` from `skill/<name>@vN` and aborts (restoring
  everything) unless `run-examples` passes on it; all tags stay.
- `demo:reset` asks for confirmation, then also deletes every leftover `skill/<name>@vN` tag (locally and on origin)
  of skills removed earlier without `--delete-tags`; a failed remove leaves the tags, `work/` and `logs/` untouched.
  GitHub issues are never touched.

## Build flow

After the intake locks a PRD-reviewed `work/<skill>/`, the main agent follows the "Build, review, install" section of
`.claude/skills/frankenstein/SKILL.md`: `tracker.ts open` → `skill-builder` loop (fresh context per call, state in
`progress.md`) → `skill-reviewer` (one extra build + review after a reject) → `registry.ts install` →
`tracker.ts done` → answers the user with the new skill via `run-skill.ts`. Any cap, a second reject, an `impossible`
builder or a refused install ends in `tracker.ts blocked`.
