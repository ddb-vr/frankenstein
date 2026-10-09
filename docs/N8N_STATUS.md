# n8n route â€“ status

Branch `spike/n8n-credentials`. Not merged into `main`.

## Implemented

- `scripts/n8n.ts` CLI: instance init/check, creds, lint, push, test, run, approve, go-live.
- `scripts/lib/n8n-client.ts`, `n8n-rules.ts`, `n8n-workflow.ts` (+ unit tests for rules and workflow, 38/38 pass).
- `registry.ts`: `workflow` field; `run-skill.ts`: dispatch to the n8n webhook.
- `guard-bash.ts`: allows `scripts/n8n.ts`; `.env.example`: N8N_BASE_URL, N8N_API_KEY, N8N_WEBHOOK_SECRET.
- `.claude/skills/frankenstein/N8N.md` + a pointer from SKILL.md Intake.
- Draft `work/daily-email-digest` (PRD, examples, workflow.json).

## Not implemented / not verified

- No end-to-end run against n8n Cloud: `n8n/instance.json` never created, no `.env` in the worktree.
- `daily-email-digest`: `digestTo` empty; instance init, creds, push, test, go-live not run.
- No tests for `scripts/n8n.ts` and `n8n-client.ts`.
- `.claude/agents/` not updated for n8n; N8N.md still refers to the `prd` agent (main renamed it `prd-writer`).
- README / docs do not mention the n8n route.

## Expected conflicts with main

`.claude/skills/frankenstein/SKILL.md`, `scripts/run-skill.ts`, `scripts/lib/registry.ts`, `.env.example`
(see `git merge-tree` output). The new n8n files do not conflict.