# Task: Intake (gap detection → PRD → source of truth), fixture recorder, demo prep

Work on branch `feat/intake`. Follow `CLAUDE.md` conventions. Read the skill contract and the `examples.json` schema in `03_SANDBOX.md` section 1 (or `scripts/lib/examples.ts` if merged) – everything you write must produce files in exactly that format. No new dependencies.

## Context

When the main agent (frankenstein) meets a task it cannot do with installed skills, it must turn a vague user request into a precise, user-confirmed spec before anything gets built. That spec is the source of truth for tests and for both reviews. Most of this task is prompt and process design, not code.

Flow you are implementing:

1. **Gap detection** (main agent): read `registry.json` / installed skills; decide whether an enabled skill covers the task. If yes → use it via `node scripts/run-skill.ts`. If no → continue.
2. **Intent + questions** (prd subagent, Sonnet, fresh context): estimate what the user wants and why, return 0–6 rounds of questions to the main agent. The subagent never asks the user directly. create own skill and inspire from the original https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md, but make it more practical for non technical user, so it asks question he will understand.
3. **Grill me** (main agent, main session): ask the user the questions, prefer offered options over open questions, max 6 rounds; skip or just confirm when the request is already precise.
4. **Source of truth** (`prd` subagent): write `work/<skill>/PRD.md` and `work/<skill>/examples.json`.
5. **Confirmation** (main agent): show the user the one-sentence goal and the examples in a readable table; on "yes" run `node scripts/lock.ts <skill>`; on corrections go back to step 4.
6. **PRD review** (`prd-reviewer` subagent, Opus): approve or reject with reasons; on reject the main agent fixes via step 4 and re-confirms with the user.

## 1. Agent definitions

Fill in `.claude/agents/prd.md` and `.claude/agents/prd-reviewer.md` (keep the frontmatter; models stay sonnet / opus). Keep prompts short and concrete – they cost tokens on every call.

`prd` must:

- Work in two modes stated in its prompt: `questions` (return questions only) and `write` (write PRD.md + examples.json).
- In `questions` mode return a compact list: question, 2–4 suggested options, why it matters. Focus on input format, output shape, edge cases, error behavior, whether network/API access is needed.
- In `write` mode produce `PRD.md` with sections: Goal (one sentence: „The user expects that at the end …“), Inputs, Outputs, Edge cases, Errors, Network (needed or not, which domains), Out of scope.
- Produce 4–8 examples covering normal, edge and error cases, every one traceable to a user answer. Never invent expectations the user did not confirm; list open points in PRD.md instead.
- Choose a kebab-case skill name.

`prd-reviewer` must check: the goal is testable, examples are consistent with PRD.md and with each other, the skill is implementable within the contract (stdin/stdout JSON, offline tests with fixtures, no new npm deps), and scope is small enough for one skill. End with a fenced `verdict` block in the same format as the skill-reviewer (`{ "skill", "verdict": "approve" | "reject", "reasons": [] }`).

## 2. Main agent intake instructions

Write the intake part (steps 1–6 above) into `.claude/skills/frankenstein/SKILL.md`, and a short pointer in `CLAUDE.md`. Check the current Claude Code docs for a built-in tool that asks the user structured multiple-choice questions and use it if available; otherwise ask in plain text with numbered options. Coordinate with Vito: he owns the build/review/install part of the same files – add your part as its own section, don't rewrite his.

## 3. `scripts/record-fixture.ts`

The agent needs real API responses for offline tests, but generated code must not touch the network on the host. This script is our (non-generated) way to record them:

```text
node scripts/record-fixture.ts <skill> <name> <url>
```

- GET only, 10 s timeout, max 1 MB response.
- Domain allowlist from env `FIXTURE_ALLOWED_DOMAINS` (comma-separated); anything else → error.
- Saves `work/<skill>/fixtures/<name>.json` as `{ url, status, headers (content-type only), body, recordedAt }`.
- Prints one JSON line: `{ "recorded": "<path>", "status": <code> }`.
- Unit tests for allowlist, size limit and output format (mock `fetch`).
- Tell Vito to add `node scripts/record-fixture.ts` to the Bash guard allowlist.

## 4. Demo prep (no code, no skills)

Hard rule: nothing here may contain skill code. Only data and texts.

- Verify what the ARES public API actually returns for a company lookup by IČO (identity, address, legal form, and whether VAT registration status is available there). Write findings to `demo/ares-notes.md`. If VAT payer status is not in ARES, propose an adjusted demo task wording that matches what the API can really answer.
- `demo/tasks.md`: the exact natural-language tasks for the demo (task 1: verify one supplier from an invoice; task 2 in a new session: check a whole list of suppliers), written like a real user would type them – never "build tool X".
- `demo/answers.md`: prepared answers to the questions the agent is likely to ask during grill me, so the demo stays fast.
- `demo/suppliers.csv`: a small realistic list of 5–8 Czech companies (public IČO of real, well-known companies) for task 2, including one invalid IČO.

## Done when

- `npm run check`, `npm run typecheck`, `npm test` pass.
- Dry run in Claude Code with a vague request (e.g. „potřebuju kontrolovat IČO dodavatelů“): the agent detects the gap, asks max 6 rounds of questions, shows a confirmation, and after "yes" produces a valid `PRD.md`, `examples.json` and a lock file. Paste the transcript summary into the PR.
- PR `feat: intake flow, fixture recorder, demo prep` is open.
