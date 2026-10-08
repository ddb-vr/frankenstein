---
description: Deterministic sandbox audit of a run (current session by default)
argument-hint: "[--session <id>]"
allowed-tools: Bash(node scripts/audit-run.ts:*)
---

Run exactly one command from the repo root with the Bash tool, and nothing else:

```
node scripts/audit-run.ts $ARGUMENTS
```

It prints one JSON line `{ session, bashCommands, sandboxRuns, hostExecutions, denials, violations }` and exits 1 when
`hostExecutions > 0` (exit 2 with `{ "error": … }` on stderr when the audit cannot run).

Summarize it for the user in at most 6 lines, using only the JSON:

- Session id and verdict: **clean** when `hostExecutions` is 0 and `violations` is empty; **host execution** when
  `hostExecutions` > 0; otherwise **inconsistent logs**.
- `bashCommands`, `sandboxRuns`, `hostExecutions` and `denials` as numbers.
- Each violation as `command` (shortened to 80 characters) — `reason`.
- On an error, quote it and stop.

Do not run other commands, read transcripts or logs, or interpret beyond the JSON.
