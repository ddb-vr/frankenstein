---
name: frankenstein
description: Detects a missing capability in the current task and builds, tests, reviews and installs it as a new Agent Skill. Use when no existing skill covers what the task needs.
---

# Frankenstein

Lifecycle for building a new skill:

1. **Gap detection** – decide whether an enabled skill covers the task; use an installed one only via
   `node scripts/run-skill.ts <skill> '<json>'`. See [Intake](#intake) step 1.
2. **PRD + questions** – the `prd` agent drafts plain-language questions, you ask the user, then `prd` writes
   `PRD.md` and `examples.json`. See [Intake](#intake) steps 2–4.
3. **PRD review** – the `prd-reviewer` agent approves or rejects before anything is locked. See [Intake](#intake)
   step 5.
4. **Source of truth confirmed by user** – user confirms the goal and `examples.json`; then lock it with
   `node scripts/lock.ts <skill>` (hooks block any later edit). See [Intake](#intake) step 6.
5. **Build, review, install** – see [Build, review, install](#build-review-install).

## Intake

This covers lifecycle steps 1–4: gap detection, then a reviewed and user-confirmed source of truth
(`work/<skill>/PRD.md` and `work/<skill>/examples.json`). Subagents never ask the user. You ask, and you relay the
answers. Nothing is locked until the last step, so every loop back to **Write** can still change the examples.

1. **Gap detection.** Read `registry.json` and `.claude/skills/*/SKILL.md`. Only skills listed in `registry.json` with
   `"enabled": true` are user capabilities; `frankenstein` and `grill-me` are lifecycle skills and never cover a task.
   If an enabled skill covers the task, run it with `node scripts/run-skill.ts <skill> '<json>'` (JSON input as the
   argument; for large inputs write it to a file and use `--input-file <path>` instead) and stop here. Otherwise tell
   the user in one line which capability is missing, then continue. If the task is recurring and started by something
   outside the chat (schedule, new email, webhook), build an n8n workflow instead: follow [N8N.md](N8N.md).
2. **Questions.** Delegate to the `prd` agent with `mode: questions`. Pass the user's request verbatim, all answers so
   far and the round number.
3. **Grill me.** Follow the `grill-me` skill (`.claude/skills/grill-me/SKILL.md`): plain words in the user's language,
   no technical terms. Ask the returned questions with the built-in `AskUserQuestion` tool. It takes 1–4 questions per
   call and 2–4 options per question, and adds an "Other" row for free text. Put the recommended option first. If the
   tool is unavailable, ask in plain text in the `grill-me` fallback format (numbered questions, lettered options
   `a) … b) …`) and accept answers like `1b, 2a`, or `yes` for all recommended options.
   - Prefer offered options over open questions.
   - The cap is **6 rounds**. After each round, call `prd` again in `questions` mode only if it still has open points
     that would change the examples.
   - If the request is already precise (`prd` returns "No questions"), skip the grilling. Ask a single confirmation of
     its assumptions instead.
4. **Write.** Delegate to `prd` with `mode: write`. Pass the request, every question with its answer, and any
   corrections or reviewer reasons. On a rewrite, also pass the skill name so it stays the same.
5. **PRD review.** Delegate to `prd-reviewer` with the skill name. Read the fenced `verdict` block.
   - `approve`: continue with step 6.
   - `reject`: go back to step 4 and pass the `reasons`. For reasons starting with `Ask the user:`, ask the user first
     (step 3 format) and pass the answers too. Then review again.
   - After 3 rejects, stop and show the user the reasons.
6. **Confirm and lock.** Read `work/<skill>/examples.json` (the file that gets locked, not the `prd` reply) and show
   the user the Goal sentence from `PRD.md` and a Markdown table of its examples (name | input | expected). Ask "Is
   this correct?" with the options *Yes, lock it* and *Needs changes*.
   - On *Yes*, run `node scripts/lock.ts <skill>`. Intake is done. Continue with the lifecycle at **Open issue**.
   - On corrections, go back to step 4 with them, then step 5 (review again), then confirm again.
   - If the PRD's Network section says Needed, tell the user that every listed domain must be in
     `FIXTURE_ALLOWED_DOMAINS` in `.env` before the build (you cannot read `.env`; the fixture recorder refuses other
     domains).

## Build, review, install

Starts once the intake hands over a locked, PRD-reviewed `work/<skill>/`. A hook denial is final: never retry the denied
action, follow its reason.

1. **Open issue** – `node scripts/tracker.ts open --skill <skill> --summary "<goal + why>"`. It writes
   `work/<skill>/issue.json` (`{ "issue", "url" }`); take `<n>` from there in later steps.
2. **Build loop** – invoke the `skill-builder` agent with only `<skill>` as the prompt. It returns one line
   `{ "status": "pass" | "fail" | "impossible", "summary" }`. On `fail`, invoke it again: each call has a fresh context,
   state lives in `work/<skill>/progress.md`. The budget hook caps iterations and spend. `pass` means
   `run-examples` passed every stage, including `lint` (the repo's Biome rules and type check, so the installed
   skill keeps `npm run check` and `npm run typecheck` green).
3. **Final review** – on `pass`, invoke the `skill-reviewer` agent with only `<skill>`. The capture-review hook records
   its `verdict` block in `work/<skill>/review.json`; read that file for the verdict.
4. **Reject** – put the reviewer's reasons on top of `work/<skill>/progress.md` (heading `Review rejected:`), invoke
   `skill-builder` once more and, if it returns `pass`, `skill-reviewer` once more. Each new verdict replaces
   `review.json`. If that builder call returns `fail` or `impossible` → blocked (do not loop back to step 2). A second
   reject → blocked.
5. **Install** – `node scripts/registry.ts install <skill>`, plus `--network` when the PRD's Network section says
   network is needed. Bot commit + tag `skill/<skill>@vN`.
6. **Done** – `node scripts/tracker.ts done --issue <n> --summary "<what was built>" --version <vN>`. Usage and cost
   come from the current run automatically.
7. **Finish the user's task** – use the new skill via `node scripts/run-skill.ts <skill> '<json>'` (or
   `--input-file <path>` for large inputs), answer the user's original request and report the run cost (`totalUsd` from
   step 6).

**Blocked** – the budget or iteration hook denies, the post-reject builder call does not return `pass`, the second
review rejects, the builder returns `impossible`, or install returns `"installed": false`: run
`node scripts/tracker.ts blocked --issue <n> --reason "<short reason>"`, tell the user what failed and stop. Take `<n>`
from `work/<skill>/issue.json`; over budget the hook still allows reading that file and the tracker call, nothing else.
