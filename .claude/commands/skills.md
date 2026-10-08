---
description: Show the installed skills (read-only); tells you the terminal command for operator actions
argument-hint: "[<name>] [disable|enable|rollback|remove]"
allowed-tools: Bash(node scripts/registry.ts list:*), Bash(node scripts/registry.ts show:*)
---

Arguments: `$ARGUMENTS` (optional skill name, optional action).

Run from the repo root with the Bash tool, and nothing else:

```
node scripts/registry.ts list --json
```

and, when a skill name is given:

```
node scripts/registry.ts show <name> --json
```

`list` prints `{ "skills": [{ name, version, enabled, network, installedAt, issue, totalCostUsd }] }`. `show` prints
`{ name, entry, tags }`: `entry` is the registry entry with its `history` (`action`, `version`, `issue`, `costUsd`,
`at`, `commit`), or `null` once removed; `tags` lists every `skill/<name>@vN` with `commit`, `date` and `author`. On
failure it prints `{ "error": … }`: quote it and stop.

Summarize using only the JSON:

- Without a name: one line per skill – name, version, enabled/disabled, network yes/no, issue `#n`, total cost in USD
  (`–` when `null`). Say so when there are none.
- With a name: the current version and state, the history in order (action, version, date, cost) and the tags (version,
  short commit, date, author).

You never change the registry. `disable`, `enable`, `rollback` and `remove` are operator commands: the hooks deny them
to you. When the user asks for one, give the exact command to run in a normal terminal, outside Claude Code:

- `npm run skills -- disable <name>` – hides the skill from Claude Code (moves it to `.claude/disabled-skills/`).
- `npm run skills -- enable <name>` – restores it.
- `npm run skills -- rollback <name>` – back to the previous tagged version; `--to vN` for a specific one. Aborts unless
  the restored version passes `run-examples`.
- `npm run skills -- remove <name>` – deletes the skill and its registry entry; `--delete-tags` also deletes its version
  tags locally and on origin.
- `npm run demo:reset` – removes every skill with its tags and clears `work/` and `logs/` (asks first; `-- --yes` skips
  the question).

Mention that a new Claude Code session is needed before a disabled or enabled skill disappears or reappears.
