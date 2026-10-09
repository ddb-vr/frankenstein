---
description: Deterministic sandbox audit of a run (current session by default)
argument-hint: "[--session <id>]"
allowed-tools: Bash(node scripts/audit-run.ts:*)
---

Run exactly one command from the repo root with the Bash tool, and nothing else:

```
node scripts/audit-run.ts $ARGUMENTS
```

It prints one JSON line
`{ session, bashCommands, sandboxRuns, hostExecutions, denials, mounts: [{ log, mounts }], deniedMounts: [{ command, reason }], violations: [{ command, reason }] }`
and exits 1 when `hostExecutions > 0` (exit 2 with `{ "error": … }` on stderr when the audit cannot run). Each
`mounts` entry is one run-skill log with its input and output mounts as `<host> -> <container> (ro|rw)`;
`deniedMounts` are run-skill calls with `--mount`/`--output` that a hook, a permission rule or the path policy refused.

Summarize it for the user in at most 8 lines, using only the JSON:

- Session id and verdict: **clean** when `hostExecutions` is 0 and `violations` is empty; **host execution** when
  `hostExecutions` > 0; otherwise **inconsistent logs**. When `deniedMounts` is not empty, never say just "clean":
  add the number of denied mount attempts to the verdict (e.g. "clean, 2 denied mount attempts").
- `bashCommands`, `sandboxRuns`, `hostExecutions` and `denials` as numbers.
- Mounted host paths: every `<host>` of `mounts[].mounts` with its mode (ro/rw), each once; "none" when `mounts` is
  empty.
- Each denied mount attempt as `command` (shortened to 80 characters) — `reason`.
- Each violation as `command` (shortened to 80 characters) — `reason`.
- On an error, quote it and stop.

Do not run other commands, read transcripts or logs, or interpret beyond the JSON.
