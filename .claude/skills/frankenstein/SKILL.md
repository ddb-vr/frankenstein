---
name: frankenstein
description: Detects a missing capability in the current task and builds, tests, reviews and installs it as a new Agent Skill. Use when no existing skill covers what the task needs.
---

# Frankenstein

Lifecycle for building a new skill:

1. **Gap detection** – decide whether an existing skill covers the task; use an installed one only via `node scripts/run-skill.ts <skill> '<json>'`. TODO
2. **PRD + questions** – delegate to the `prd` agent; relay its questions to the user. TODO
3. **Source of truth confirmed by user** – user confirms summary and `examples.json`; then lock it with `node scripts/lock.ts <skill>` (hooks block any later edit).
4. **PRD review** – delegate to the `prd-reviewer` agent. TODO
5. **Build, review, install** – see [Build, review, install](#build-review-install).

## Intake

This covers lifecycle steps 1–4: gap detection, then a user-confirmed and reviewed source of truth (`work/<skill>/PRD.md` and `work/<skill>/examples.json`). Subagents never ask the user. You ask, and you relay the answers.

1. **Gap detection.** Read `registry.json` and `.claude/skills/*/SKILL.md`. If an enabled skill covers the task, run it with `node scripts/run-skill.ts <skill> '<json>'` (JSON input as the argument; for large inputs write it to a file and use `--input-file <path>` instead) and stop here. Otherwise tell the user in one line which capability is missing, then continue.
2. **Questions.** Delegate to the `prd` agent with `mode: questions`. Pass the user's request verbatim, all answers so far and the round number.
3. **Grill me.** Ask the user the returned questions with the built-in `AskUserQuestion` tool. It takes 1–4 questions per call and 2–4 options per question, and adds an "Other" row for free text. Put the recommended option first. If the tool is unavailable, ask in plain text with numbered options (`1) … 2) …`) and accept answers like `1b, 2a`.
   - Prefer offered options over open questions.
   - The cap is **3 rounds**. After each round, call `prd` again in `questions` mode only if it still has open points that would change the examples.
   - If the request is already precise (`prd` returns "No questions"), skip the grilling. Ask a single confirmation of its assumptions instead.
4. **Write.** Delegate to `prd` with `mode: write`. Pass the request, every question with its answer, and any corrections.
5. **Confirm.** Show the user the Goal sentence and a Markdown table of the examples (name | input | expected). Ask "Is this correct?" with the options *Yes, lock it* and *Needs changes*.
   - On *Yes*, run `node scripts/lock.ts <skill>`.
   - On corrections, go back to step 4 with them. The skill name stays the same. Then confirm again.
6. **PRD review.** Delegate to `prd-reviewer` with the skill name. Read the fenced `verdict` block.
   - `approve`: intake is done. Continue with the lifecycle at **Open issue**.
   - `reject`: go back to step 4 and pass the `reasons`. Show the user what changed and get a new *Yes* (step 5, which locks again). Then review again.
   - After 3 rejects, stop and show the user the reasons.

## Build, review, install

Starts once the intake hands over a locked, PRD-reviewed `work/<skill>/`. A hook denial is final: never retry the denied action, follow its reason.

1. **Open issue** – `node scripts/tracker.ts open --skill <skill> --summary "<goal + why>"`. It writes `work/<skill>/issue.json` (`{ "issue", "url" }`); take `<n>` from there in later steps.
2. **Build loop** – invoke the `skill-builder` agent with only `<skill>` as the prompt. It returns one line `{ "status": "pass" | "fail" | "impossible", "summary" }`. On `fail`, invoke it again: each call has a fresh context, state lives in `work/<skill>/progress.md`. The budget hook caps iterations and spend.
3. **Final review** – on `pass`, invoke the `skill-reviewer` agent with only `<skill>`. The capture-review hook records its `verdict` block in `work/<skill>/review.json`; read that file for the verdict.
4. **Reject** – put the reviewer's reasons on top of `work/<skill>/progress.md` (heading `Review rejected:`), invoke `skill-builder` once more and, if it returns `pass`, `skill-reviewer` once more. A second reject → blocked.
5. **Install** – `node scripts/registry.ts install <skill>`, plus `--network` when the PRD's Network section says network is needed. Bot commit + tag `skill/<skill>@vN`.
6. **Done** – `node scripts/tracker.ts done --issue <n> --summary "<what was built>" --version <vN>`. Usage and cost come from the current run automatically.
7. **Finish the user's task** – use the new skill via `node scripts/run-skill.ts <skill> '<json>'` (or `--input-file <path>` for large inputs), answer the user's original request and report the run cost (`totalUsd` from step 6).

**Blocked** – the budget or iteration hook denies, the second review rejects, the builder returns `impossible`, or install returns `"installed": false`: run `node scripts/tracker.ts blocked --issue <n> --reason "<short reason>"`, tell the user what failed and stop.
