---
name: frankenstein
description: Detects a missing capability in the current task and builds, tests, reviews and installs it as a new Agent Skill. Use when no existing skill covers what the task needs.
---

# Frankenstein

Lifecycle for building a new skill:

1. **Gap detection** – decide whether an existing skill covers the task. TODO
2. **PRD + questions** – delegate to the `prd` agent; relay its questions to the user. TODO
3. **Source of truth confirmed by user** – user confirms summary and `examples.json` (then locked). TODO
4. **PRD review** – delegate to the `prd-reviewer` agent. TODO
5. **Open issue** – `node scripts/tracker.ts` opens the GitHub issue as the bot. TODO
6. **Build loop** – invoke `skill-builder` repeatedly until tests pass or caps are hit. TODO
7. **Final review** – delegate to the `skill-reviewer` agent for approve/reject. TODO
8. **Install** – copy into `.claude/skills/<name>/`, commit and tag `skill/<name>@vN` as the bot. TODO
9. **Close issue with cost** – close the issue with total cost of the run. TODO
