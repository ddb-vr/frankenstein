# Task: Hooks – lock, install gate, sandbox enforcement, budget

Enforce the hackathon hard rules in code via Claude Code hooks and permissions. Work on branch `feat/hooks`. Builds on `feat/sandbox` (runner) and `feat/tracker` (`pricing.ts`, `runAsBot`); merge or rebase on them first. Follow `CLAUDE.md` conventions. No new dependencies.

## Rules to enforce

| Rule | Mechanism |
| --- | --- |
| examples.json is locked once the user confirms the source of truth | lock file + PreToolUse deny |
| Nothing lands in `.claude/skills/` except through the install script | permissions deny + PreToolUse deny |
| Install only with passing tests and an approve verdict | checks inside `registry.ts install` |
| Generated code never executes on the host | PreToolUse deny on Bash |
| Builder iterations and USD spend per run are capped | PreToolUse budget hook |

## 0. Verify hook API first

Before writing code, check the current Claude Code hooks docs and confirm: hook input fields (`session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input`), how a PreToolUse hook denies (exit code 2 + stderr, or JSON `permissionDecision: "deny"`), the current name of the subagent tool (`Task` or `Agent` – match both), and where subagent transcripts are stored. Put findings as a short comment at the top of `scripts/hooks/lib.ts`.

## 1. Shared hook library – `scripts/hooks/lib.ts`

- `readHookInput()` – parse stdin JSON, typed.
- `deny(reason)` – the documented deny output; reason is short and tells the agent what to do instead.
- `allow()` – exit 0, no output.
- Path helpers that normalize Windows and POSIX separators before matching.
- Any unexpected error inside a hook → deny with the error message (fail closed), never crash silently.

## 2. Lock – `scripts/lock.ts` + `scripts/hooks/guard-files.ts`

`node scripts/lock.ts <skill>` – called by the main agent after the user confirms the source of truth. Writes `work/.locks/<skill>.json` with the sha256 of `work/<skill>/examples.json` and a timestamp.

`guard-files.ts` (PreToolUse, matcher `Write|Edit|MultiEdit|NotebookEdit`) denies:

- any write to `work/<skill>/examples.json` while `work/.locks/<skill>.json` exists,
- any write under `work/.locks/`,
- any write under `.claude/skills/`, `.claude/settings.json`, `scripts/`, `registry.json`.

## 3. Bash guard – `scripts/hooks/guard-bash.ts`

PreToolUse, matcher `Bash`. Deny when the command:

- references `examples.json`, `work/.locks`, `.claude/skills`, `.claude/settings.json` or `registry.json` (except the allowed scripts below),
- executes code from `work/` or `.claude/skills/` on the host (`node`, `npx`, `tsx`, `deno`, `bun`, `python` followed by such a path),
- contains `--network` or `docker run` (only our sandbox script may start containers).

Allowed entry points (match exactly at the start of the command):
`node scripts/run-examples.ts`, `node scripts/run-skill.ts`, `node scripts/registry.ts`, `node scripts/lock.ts`, `node scripts/tracker.ts`, `npm test`, `npm run check`, `npm run typecheck`, read-only `git` commands.

This is a heuristic second layer; keep the rules simple and well tested.

## 4. Run an installed skill – `scripts/run-skill.ts`

`node scripts/run-skill.ts <name> '<json input>'` – the only way the agent uses an installed skill. Looks it up in `registry.json` (must be enabled), runs `scripts/main.ts` via `runInSandbox` without `FRANKENSTEIN_MODE=test`, with `network` from the registry entry. Prints the skill's JSON output; full stderr goes to `logs/<skill>/run-<timestamp>.log`.

## 5. Install – `scripts/registry.ts install <skill>`

Only `install` in this task (list / disable / rollback come next). Steps, all must pass:

1. `work/.locks/<skill>.json` exists and its hash matches the current `examples.json`.
2. Fresh `run-examples` on `work/<skill>` returns PASS.
3. `work/<skill>/review.json` exists with `{ "verdict": "approve" }` written by the skill-reviewer.
4. Copy `work/<skill>` to `.claude/skills/<skill>` (excluding `progress.md`, `review.json`), bump version (`v1`, `v2`, …).
5. Update `registry.json` entry: `name`, `version`, `enabled: true`, `network`, `examplesHash`, `installedAt`, `issue`.
6. Commit and tag `skill/<skill>@vN` via `runAsBot`, push both.

Output one JSON line: `{ "installed": "<skill>", "version": "vN", "commit": "<sha>" }`. On any failed check output `{ "installed": false, "reason": "…" }` and exit 1.

Known limitation (note it in README): `review.json` is written by an LLM subagent; for the hackathon the guard prevents edits after it is written, but not a forged first write.

## 6. Budget – `scripts/hooks/budget.ts`

PreToolUse, matcher `*` (must stay fast).

- State in `work/.run/<session_id>.json`: builder invocations, last read byte offset per transcript file, accumulated usage per model.
- Iterations: when the tool is the subagent tool with `subagent_type` `skill-builder`, increment; deny above `MAX_BUILDER_ITERATIONS` with a reason telling the agent to mark the issue blocked.
- Spend: read only new lines of the main transcript and subagent transcripts of the session (incremental by offset), sum `usage` per model, compute USD via `computeCost` from `scripts/lib/pricing.ts`. Deny every tool call except `node scripts/tracker.ts` once spend ≥ `BUDGET_USD_PER_RUN`.
- Also export `getRunUsage(sessionId)` so `tracker.ts done` can attach the real numbers.

## 7. Wiring – `.claude/settings.json`

- Register the hooks above with `node scripts/hooks/<file>.ts` commands (no bash, Windows-safe).
- Permissions deny as a first layer: edits under `.claude/skills/**`, `work/.locks/**`, `.claude/settings.json`; reading `.env` and `*.pem`.

## 8. Tests (`node:test`, no Docker, no Claude)

Feed recorded hook input JSON into each hook and assert allow/deny:

- guard-files: locked vs unlocked examples, `.claude/skills/` write, Windows-style paths.
- guard-bash: allowed scripts, `node work/x/scripts/main.ts`, `cat examples.json`, `docker run`, sneaky variants (`./node`, `&&` chains).
- budget: iteration cap, spend cap from a sample transcript JSONL, incremental offset reading.
- registry install: each failing precondition returns the right reason (stub `runAsBot` and the runner).

## 9. Manual verification in Claude Code

1. Ask Claude to edit a locked `examples.json` → denied.
2. Ask Claude to run `node fixtures/skills/text-stats/scripts/main.ts` → denied; via `run-examples` → allowed.
3. Set `MAX_BUILDER_ITERATIONS=1`, invoke skill-builder twice → second denied.
4. Repeat steps 1–2 in the Claude desktop app – hooks must behave the same.

## Done when

- `npm run check`, `npm run typecheck`, `npm test` pass.
- Manual verification 1–4 behaves as described.
- PR `feat: hooks, lock, install gate, budget` is open.
