# Run-of-show – 90 s video

Story: two fresh sessions. Session 1 has no skill, asks, builds and installs a payment-matching skill, answers.
Session 2 finds it, builds a reminder skill on top of it, answers – much cheaper.

Pitch line: **"Your bank data never passes through the model and never leaves a sandbox without network."**

## Before recording

1. Docker is running; `npm run sandbox:build` is fresh.
2. `.env` uses the **github-app** backend (the run log prints it), so the build issue appears on GitHub as the bot.
3. `npm run demo:reset -- --yes` (removes all skills and their tags, clears `work/` and `logs/`), then delete old
   results: `rm -rf out/*` (on Windows: `Remove-Item out\* -Recurse`).
4. `npm run skills -- list` shows no skills; `git status` is clean.
5. Terminal font large (≥ 16 pt), dark theme, notifications off, window 1920×1080.
6. Browser tab with the repo's issues filtered by the `skill-build` label, logged out or in a clean profile.

## Screen layout

```text
+-------------------------------+------------------------------+
|                               | B: builder log               |
|  A: Claude Code (agent pane)  +------------------------------+
|                               | C: docker ps loop            |
|                               +------------------------------+
|                               | D: registry / GitHub issue   |
+-------------------------------+------------------------------+
```

- **A** – `claude` in the repo root. Prompts from [tasks.md](tasks.md), answers from [answers.md](answers.md).
- **B** – every builder test result as one line (all skills; `latest.log` is truncated at each run):
  `while true; do clear; tail -n 12 logs/*/latest.log 2>/dev/null; sleep 1; done`
- **C** – sandbox containers while they run; the `NETWORKS` column says `none`:
  `while true; do clear; docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Networks}}'; sleep 1; done`
- **D** – `npm run skills -- list` before and after each session (or `registry.json` in an editor); switch to the
  browser for the closed GitHub issue with cost table and sandbox audit.

## Timeline

| Video time | Source moment                                                                 | On screen                | Edit            |
|------------|-------------------------------------------------------------------------------|--------------------------|-----------------|
| 0–8 s      | S1 prompt typed; agent: "no skill covers this"                                | A, D (empty registry)    | real time       |
| 8–20 s     | Questions in plain words; answers picked                                      | A                        | 4× speed        |
| 20–40 s    | Builder loop: test lines turn green in B, containers with `none` network in C | A, B, C                  | 8–16× speed     |
| 40–50 s    | Reviewer approves; install commit + tag by the bot; issue closed with cost    | A, D (registry), browser | 4× speed        |
| 50–58 s    | S1 answer: paid / partially paid / unpaid / overpaid, unmatched payment       | A                        | real time, zoom |
| 58–64 s    | S2 (fresh session) prompt; agent finds the payment-matching skill             | A, D                     | real time       |
| 64–78 s    | Fewer questions; reminder skill built on top; cost lower than S1              | A, B, C                  | 8–16× speed     |
| 78–85 s    | S2 answer: 4 debtors, 63 650 CZK, reminder drafts in `out/`; one draft opened | A, editor                | real time       |
| 85–90 s    | `/audit`: 0 host executions; side-by-side cost S1 vs S2; pitch line           | A, browser (two issues)  | still + caption |

Keep: the "no skill" line, one question with its options, green test lines, `none` in the network column, the bot's
install commit/tag, both cost tables, the final answers, `/audit` verdict. Cut: waiting for the model, subagent
chatter, repeated test runs, the file copy (if any).

## After each session

- Compare the answer with [answer-key.md](answer-key.md); a mismatch is a retake, never an edit of the agent's output.
- Run `/audit` in the same session and keep the verdict on screen for 2 s.
- Note duration, builder iterations and cost (closed issue) for the voice-over.
