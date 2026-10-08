# Task: Operator control – list, show, disable, enable, rollback, remove

Work on branch `feat/operator`. Builds on current `main` (install, run-skill, hooks, audit). Follow `CLAUDE.md`
conventions. No new dependencies.

## Context

Hackathon rules ask for "a persistent tool registry with versions and rollback" and "real operator control". Operator
control means a **human** can inspect and override what the agent built. So the mutating commands are for the human in a
terminal; the agent may only read.

## 1. Registry model

Extend `registry.json` entries (migrate existing ones):

```json
{
  "name": "skill-name",
  "version": "v2",
  "enabled": true,
  "network": false,
  "examplesHash": "…",
  "issue": 12,
  "installedAt": "…",
  "history": [
    {"version": "v1", "commit": "…", "issue": 12, "costUsd": 0.9, "at": "…", "action": "install"},
    {"version": "v2", "commit": "…", "issue": 15, "costUsd": 0.4, "at": "…", "action": "install"}
  ]
}
```

`action` is one of `install`, `disable`, `enable`, `rollback`, `remove`.

## 2. Commands – `scripts/registry.ts` (+ `npm run skills -- <command>`)

All mutating commands commit as the bot via `runAsBot` with a conventional message (`chore(registry): disable <name>`),
push, and print one JSON line. Human-readable table output for `list` and `show` unless `--json`.

| Command                         | Who          | What                                                                                                                                                                                 |
|---------------------------------|--------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `list [--json]`                 | human, agent | name, version, enabled, network, installed at, issue, total cost                                                                                                                     |
| `show <name> [--json]`          | human, agent | history + all git tags `skill/<name>@v*` with commit, date, author                                                                                                                   |
| `disable <name>`                | human only   | move `.claude/skills/<name>/` to `.claude/disabled-skills/<name>/`, `enabled: false`                                                                                                 |
| `enable <name>`                 | human only   | move it back, `enabled: true`                                                                                                                                                        |
| `rollback <name> [--to vN]`     | human only   | restore the skill directory from tag `skill/<name>@vN` (default: previous version), run `run-examples` on it – abort if not PASS, set `version` to vN, append history, keep all tags |
| `remove <name> [--delete-tags]` | human only   | delete the skill directory and registry entry; with `--delete-tags` delete local and remote tags (demo reset)                                                                        |

Why `disable` moves the directory: Claude Code discovers skills from `.claude/skills/` by itself, so a registry flag
alone would not hide the skill from the agent. `run-skill.ts` must also refuse disabled skills.

## 3. Guards

- Bash guard: the agent may run `node scripts/registry.ts list`, `show`, `install`; deny `disable`, `enable`,
  `rollback`, `remove` with the reason "operator command – ask the user to run it in a terminal".
- File guard: deny agent writes under `.claude/disabled-skills/`.
- The human runs the mutating commands in a normal terminal, outside Claude Code, where hooks do not apply.

## 4. Operator entry point in Claude Code (read-only)

`.claude/commands/skills.md` – runs `node scripts/registry.ts list --json` (and `show` when a name is given) and
summarizes it. For mutating actions it tells the user the exact `npm run skills -- …` command to run in a terminal.

## 5. Demo reset

`npm run demo:reset` – for every skill in the registry: `remove <name> --delete-tags`; clear `work/` (except `.gitkeep`)
and `logs/`. Asks for confirmation (`--yes` to skip). Never touches GitHub issues (closed issues stay as honest
history).

## 6. Tests (`node:test`, temp git repo fixture, `runAsBot` stubbed)

- list/show output from a sample registry with history and tags,
- disable → directory moved, `run-skill` refuses; enable → restored,
- rollback to previous version restores files and appends history; rollback aborts when tests fail,
- remove with and without tags,
- guard: agent denied on mutating commands, allowed on list/show/install,
- registry migration of entries without `history`.

## 7. Manual verification

1. Install a skill twice (v1, v2) via the normal flow or the internal IČO run.
2. `npm run skills -- list` and `show` – versions and tags visible, author is the bot.
3. `disable` → new Claude Code session does not see the skill; `enable` → it does.
4. `rollback` → v1 files restored, tests pass, bot commit visible.
5. Ask the agent in Claude Code to roll back a skill → denied, and it tells you the terminal command.
6. `npm run demo:reset -- --yes` → empty registry, no skill tags left.

## Done when

- `npm run check`, `npm run typecheck`, `npm test` pass.
- Manual verification 1–6 behaves as described.
- PR `feat: operator control for the skill registry` is open.
