---
name: frankenstein
description: Detects a missing capability in the current task and builds, tests, reviews and installs it as a new Agent Skill. Use when no existing skill covers what the task needs.
---

# Frankenstein

Lifecycle for building a new skill:

1. **Gap detection** – decide whether an existing skill covers the task; use an installed one only via `node scripts/run-skill.ts <name> '<json>'`. TODO
2. **PRD + questions** – delegate to the `prd` agent; relay its questions to the user. TODO
3. **Source of truth confirmed by user** – user confirms summary and `examples.json`; then lock it with `node scripts/lock.ts <skill>` (hooks block any later edit).
4. **PRD review** – delegate to the `prd-reviewer` agent. TODO
5. **Open issue** – `node scripts/tracker.ts` opens the GitHub issue as the bot. TODO
6. **Build loop** – invoke `skill-builder` repeatedly until `node scripts/run-examples.ts work/<skill>` passes. Hooks deny the call past `MAX_BUILDER_ITERATIONS` or once `BUDGET_USD_PER_RUN` is spent: then mark the issue blocked (`node scripts/tracker.ts blocked`).
7. **Final review** – delegate to the `skill-reviewer` agent; it writes `work/<skill>/review.json`. TODO
8. **Install** – `node scripts/registry.ts install <skill> --issue <n> [--network]` checks lock, approval and a fresh test run, then copies into `.claude/skills/<name>/`, commits and tags `skill/<name>@vN` as the bot.
9. **Close issue with cost** – `node scripts/tracker.ts done --issue <n> --summary <text> --version <vN>` attaches this session's real token usage and cost.

## Intake

This covers lifecycle steps 1–4: gap detection, then a user-confirmed and reviewed source of truth (`work/<skill>/PRD.md` and `work/<skill>/examples.json`). Subagents never ask the user. You ask, and you relay the answers.

1. **Gap detection.** Read `registry.json` and `.claude/skills/*/SKILL.md`. If an enabled skill covers the task, run it with `node scripts/run-skill.ts <skill>` (JSON input on stdin) and stop here. Otherwise tell the user in one line which capability is missing, then continue.
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
