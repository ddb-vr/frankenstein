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
