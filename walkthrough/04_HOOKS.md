# Task: Hooks – lock, install gate, sandbox enforcement, budget

Enforce the hackathon hard rules in code via Claude Code hooks and permissions. Work on branch `feat/hooks`. Builds on `feat/sandbox` (runner) and `feat/tracker` (`pricing.ts`, `runAsBot`); merge or rebase on them first. Follow `CLAUDE.md` conventions. No new dependencies.

## Rules to enforce

| Rule | Mechanism |
| --- | --- |
| examples.json is locked once the user confirms the source of truth | lock file + PreToolUse deny |
| Nothing lands in `.claude/skills/` except through the install script | permissions deny + PreToolUse deny |
| Install only with passing tests and an approve verdict | checks inside `registry.ts install` |
| The review verdict cannot be forged by any agent | `review.json` written only by a SubagentStop hook; writes denied to everyone |
| Generated code never executes on the host | PreToolUse deny on Bash |
| Builder iterations and USD spend per run are capped | PreToolUse budget hook |

## 0. Verify hook API first

Before writing code, check the current Claude Code hooks docs and confirm: hook input fields (`session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input`), how a PreToolUse hook denies (exit code 2 + stderr, or JSON `permissionDecision: "deny"`), the current name of the subagent tool (`Task` or `Agent` – match both), and where subagent transcripts are stored. Also confirm what a `SubagentStop` hook receives: it must let us identify that the finished subagent was `skill-reviewer` and read its final message (transcript path or equivalent). Put findings as a short comment at the top of `scripts/hooks/lib.ts`. If `SubagentStop` cannot identify the subagent or reach its final message, stop and report back before implementing section 6a.

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
- any write to `work/<skill>/review.json` (only the SubagentStop hook writes it, see 6a),
- any write under `.claude/skills/`, `.claude/settings.json`, `scripts/`, `registry.json`.

## 3. Bash guard – `scripts/hooks/guard-bash.ts`

PreToolUse, matcher `Bash`. Deny when the command:

- references `examples.json`, `review.json`, `work/.locks`, `.claude/skills`, `.claude/settings.json` or `registry.json` (except the allowed scripts below),
- invokes an interpreter or package manager (`node`, `npx`, `tsx`, `ts-node`, `bun`, `deno`, `python`, `npm`, …) that is not exactly an allowed entry point – also inside `&&`, `;`, `|`, subshells, `$(…)`, `bash -c`/`sh -c` and wrappers (`env`, `xargs`, `find -exec`, `timeout`, …),
- uses inline code (`node -e/--eval/-p/--print/--input-type`, `python -c`) or `node --test` outside `npm test`,
- sets code-loading variables (`NODE_OPTIONS`, `NODE_PATH`, `PYTHONPATH`, `LD_PRELOAD`, `DYLD_*`, `BASH_ENV`, `npm_config_*`),
- builds the command name dynamically (`$X`, globs, xargs/find placeholders) or feeds a shell without `-c` (script file, stdin, `source`),
- `cd`s into `work/`, `.claude/skills/` or `fixtures/skills/`, or runs an interpreter while the hook input's `cwd` is inside them,
- contains `--network` or `docker run` (only our sandbox script may start containers).

Allowed entry points (exact command, from the repo root):
`node scripts/run-examples.ts …`, `node scripts/run-skill.ts …`, `node scripts/registry.ts …`, `node scripts/lock.ts …`, `node scripts/tracker.ts …`, `node scripts/record-fixture.ts …`, and without extra arguments `npm test`, `npm run check`, `npm run typecheck`, `npm run sandbox:build`; read-only `git` commands.

Every decision of every hook is appended to `logs/hooks.log` (time, hook, decision, short reason, command truncated to 200 chars).

This is a heuristic second layer; keep the rules simple and well tested.

## 4. Run an installed skill – `scripts/run-skill.ts`

The only way the agent uses an installed skill. Canonical forms:

```text
node scripts/run-skill.ts <name> '<json input>'
node scripts/run-skill.ts <name> --input-file <path to .json>
```

- Exactly one of the inline JSON argument or `--input-file` must be given; otherwise exit 1 with a clear error. Use `--input-file` for larger inputs (e.g. a list of suppliers).
- Looks the skill up in `registry.json` (must be enabled), runs `scripts/main.ts` via `runInSandbox` without `FRANKENSTEIN_MODE=test`, with `network` from the registry entry, and passes the JSON to the skill on stdin inside the container (the skill contract is unchanged).
- Prints the skill's JSON output; full stderr goes to `logs/<skill>/run-<timestamp>.log`.
- Every description of skill usage in the repo (meta-skill intake and build sections, `CLAUDE.md`, the usage section the skill-builder writes into generated `SKILL.md` files) must use exactly these forms.

## 5. Install – `scripts/registry.ts install <skill>`

Only `install` in this task (list / disable / rollback come next). Steps, all must pass:

1. `work/.locks/<skill>.json` exists and its hash matches the current `examples.json`.
2. Fresh `run-examples` on `work/<skill>` returns PASS.
3. `work/<skill>/review.json` exists with `{ "verdict": "approve" }`, written by the SubagentStop hook (6a), and its `examplesHash` matches the lock.
4. Copy `work/<skill>` to `.claude/skills/<skill>` (excluding `progress.md`, `review.json`), bump version (`v1`, `v2`, …).
5. Update `registry.json` entry: `name`, `version`, `enabled: true`, `network`, `examplesHash`, `installedAt`, `issue`.
6. Commit and tag `skill/<skill>@vN` via `runAsBot`, push both.

Output one JSON line: `{ "installed": "<skill>", "version": "vN", "commit": "<sha>" }`. On any failed check output `{ "installed": false, "reason": "…" }` and exit 1.

## 6a. Review verdict capture – `scripts/hooks/capture-review.ts`

No agent can write the verdict; the host captures it.

- Update `.claude/agents/skill-reviewer.md`: the reviewer must end its final message with exactly one fenced block:

  ````text
  ```verdict
  { "skill": "<name>", "verdict": "approve" | "reject", "reasons": ["…"] }
  ```
  ````

- `capture-review.ts` runs on `SubagentStop`. If the finished subagent is not `skill-reviewer`, allow and exit. Otherwise read the reviewer's final message, extract the last `verdict` block, validate it, and write `work/<skill>/review.json` with `{ skill, verdict, reasons, examplesHash (from the lock), capturedAt }`.
- Missing, duplicated or invalid block → write `{ "verdict": "reject", "reasons": ["no valid verdict block"] }`. Fail closed.
- Each capture overwrites the previous `review.json` (a new review after a fix supersedes the old one).
- Log every capture to `logs/<skill>/reviews.log` so the verdict history is visible.

## 6. Budget – `scripts/hooks/budget.ts`

PreToolUse, matcher `*` (must stay fast).

- State in `work/.run/<session_id>.json`: builder invocations, last read byte offset per transcript file, accumulated usage per model.
- Iterations: when the tool is the subagent tool with `subagent_type` `skill-builder`, increment; deny above `MAX_BUILDER_ITERATIONS` with a reason telling the agent to mark the issue blocked.
- Spend: read only new lines of the main transcript and subagent transcripts of the session (incremental by offset), sum `usage` per model, compute USD via `computeCost` from `scripts/lib/pricing.ts`. Deny every tool call except `node scripts/tracker.ts` once spend ≥ `BUDGET_USD_PER_RUN`.
- Also export `getRunUsage(sessionId)` so `tracker.ts done` can attach the real numbers.

## 7. Wiring – `.claude/settings.json`

- Register the hooks above with `node scripts/hooks/<file>.ts` commands (no bash, Windows-safe), including `capture-review.ts` on `SubagentStop`.
- Permissions deny as a first layer: edits under `.claude/skills/**`, `work/.locks/**`, `.claude/settings.json`; reading `.env` and `*.pem`.

## 8. Tests (`node:test`, no Docker, no Claude)

Feed recorded hook input JSON into each hook and assert allow/deny:

- guard-files: locked vs unlocked examples, `.claude/skills/` write, Windows-style paths.
- guard-bash: allowed scripts (including both `run-skill.ts` forms and `record-fixture.ts`), `node work/x/scripts/main.ts`, `cat examples.json`, `docker run`, sneaky variants (`./node`, `&&` chains, `echo … | node scripts/run-skill.ts`).
- run-skill: inline JSON, `--input-file`, both given, neither given, invalid JSON, disabled skill.
- budget: iteration cap, spend cap from a sample transcript JSONL, incremental offset reading.
- registry install: each failing precondition returns the right reason (stub `runAsBot` and the runner).
- capture-review: approve block, reject block, missing block, two blocks, invalid JSON, non-reviewer subagent ignored; guard-files denies a direct write to `review.json`.

## 9. Manual verification in Claude Code

1. Ask Claude to edit a locked `examples.json` → denied.
2. Ask Claude to run `node fixtures/skills/text-stats/scripts/main.ts` → denied; via `run-examples` → allowed.
3. Set `MAX_BUILDER_ITERATIONS=1`, invoke skill-builder twice → second denied.
4. Ask the main agent to write `{ "verdict": "approve" }` into a `review.json` itself → denied. Invoke the skill-reviewer on the fixture skill → `review.json` appears, written by the hook.
5. Repeat steps 1, 2 and 4 in the Claude desktop app – hooks must behave the same.

## Done when

- `npm run check`, `npm run typecheck`, `npm test` pass.
- Manual verification 1–5 behaves as described.
- PR `feat: hooks, lock, install gate, budget` is open.
