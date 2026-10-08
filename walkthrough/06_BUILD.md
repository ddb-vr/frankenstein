# Task: Build loop, skill review, end-to-end orchestration

Work on branch `feat/build`. Builds on merged `feat/sandbox`, `feat/tracker`, `feat/hooks`; the teammate is finishing `feat/intake` in parallel (intake section of the meta-skill, `prd` agents). Follow `CLAUDE.md` conventions. No new dependencies.

Goal: the first full end-to-end run – from a vague user request to an installed, bot-committed skill and a closed issue with cost – using the internal IČO validation (never demoed, reset afterwards).

## Flow (after the intake hands over a locked, PRD-reviewed spec)

1. **Open issue** – `node scripts/tracker.ts open --skill <name> --summary "<goal + why>"`.
2. **Build loop** – main agent invokes `skill-builder` repeatedly; each invocation has a fresh context, state lives in files. Hard caps come from the budget hook.
3. **Final review** – on builder status `pass`, invoke `skill-reviewer`; the `capture-review` hook writes `review.json`.
4. **Reject** – append reviewer reasons to `progress.md`, one more builder invocation, one more review. Second reject → blocked.
5. **Install** – `node scripts/registry.ts install <name>` (bot commit + tag).
6. **Done** – `node scripts/tracker.ts done --issue <n> --summary "<what was built>"`; usage taken from the current run automatically.
7. **Finish the user's task** – use the new skill via `node scripts/run-skill.ts`, answer the user, report the run cost.

Blocked paths: budget or iteration hook denies, second reject, or builder reports it cannot satisfy the PRD → `node scripts/tracker.ts blocked --issue <n> --reason "<short reason>"`, tell the user what failed and stop.

## 1. `.claude/agents/skill-builder.md` (Sonnet)

Input from the main agent: only the skill name. Prompt must state:

- Read `work/<skill>/PRD.md`, `examples.json` (read-only, locked), `progress.md` if present.
- Write only inside `work/<skill>/`: `SKILL.md`, `scripts/*.ts`, `tests/*.test.ts`. Every script in `scripts/` gets unit tests.
- Follow the skill contract (stdin/stdout JSON, exit codes, `FRANKENSTEIN_MODE=test` = offline, fixtures from `/skill/fixtures/`). Node 24 built-ins only, `.ts` imports, erasable syntax.
- Need API data for tests → `node scripts/record-fixture.ts <skill> <name> <url>`; never fetch in code during tests.
- Verify only via `node scripts/run-examples.ts work/<skill>`; read `logs/<skill>/latest.log` only when the summary is not enough, and only the relevant part.
- At most 3 runner calls per invocation. Then update `progress.md` (done / failed / next step, max 15 lines, newest on top) and return exactly one line: `{ "status": "pass" | "fail" | "impossible", "summary": "…" }`.
- `SKILL.md` requirements: frontmatter `name` + a precise `description` (what it does and when to use it – this is what makes the skill discoverable in a new session), usage via `node scripts/run-skill.ts <name> '<json>'`, input/output shape, 2 short examples, network requirement. If the skill builds on another installed skill, say so in a `## Composes with` section (composition happens at the agent level: the agent calls both skills).

## 2. `.claude/agents/skill-reviewer.md` (Opus)

Input: the skill name. Read PRD.md, examples.json, SKILL.md, scripts, tests, and run `node scripts/run-examples.ts work/<skill>` once. Check:

- behavior matches the PRD goal and every example, not just the letter of the tests,
- each script has meaningful unit tests (not trivial asserts),
- no network or filesystem access outside the contract, no hidden hardcoding of example outputs,
- SKILL.md description is precise enough for discovery in a fresh session,
- scope matches the PRD (nothing extra).

End with the fenced `verdict` block (already defined in `feat/hooks`). Reasons must be actionable for the builder.

## 3. Meta-skill and CLAUDE.md – build/review/install section

Add the flow above as its own section in `.claude/skills/frankenstein/SKILL.md` (the teammate owns the intake section – don't rewrite it). Keep it short; it is loaded on every skill build. In `CLAUDE.md` add a pointer and the rule: after any hook denial, do not retry the same action – follow the reason in the denial.

## 4. Script changes

- `tracker.ts open`: also write `work/<skill>/issue.json` (`{ "issue": n, "url": "…" }`) so later steps don't depend on the agent remembering the number.
- Budget hook: maintain `work/.run/current.json` pointing to the active session's usage state.
- `tracker.ts done`: when `--usage` is omitted, read usage from `work/.run/current.json` via `getRunUsage`.
- Optional, only if time allows: `run-examples.ts --live` – runs examples with network and without test mode, only for skills whose PRD says network is needed; the reviewer may use it as an end-to-end check.

## 5. End-to-end verification (internal IČO run)

1. Fresh Claude Code session, empty `registry.json`. Prompt something vague, e.g. „Potřebuju ověřovat IČO dodavatelů, jestli dávají smysl.“
2. Expect: gap detected → questions → confirmation → lock → PRD review → issue opened by the bot → builder iterations visible in `logs/<skill>/latest.log` → review captured → install commit + tag by the bot → issue closed with a cost table → the agent answers the original request using the skill.
3. New session: ask a related question → the agent finds and uses the installed skill without building anything; note the cost difference.
4. Force a block: set `MAX_BUILDER_ITERATIONS=1` and a PRD the builder cannot satisfy in one go → issue gets `blocked` with a reason.
5. Repeat step 1 in the Claude desktop app (at least up to the first builder invocation).
6. Write a short `demo/e2e-notes.md`: cost of the build run vs. the reuse run, number of iterations, anything flaky.
7. Reset for the demo: remove the IČO skill from `.claude/skills/` and `registry.json` on main, delete its tag, keep the closed issues (they are honest history).

## Done when

- `npm run check`, `npm run typecheck`, `npm test` pass.
- Steps 1–4 work end to end; step 5 at least partially.
- PR `feat: build loop, skill review, e2e orchestration` is open with `demo/e2e-notes.md`.
