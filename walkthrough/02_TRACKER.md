# Task: GitHub App token + issue tracker

Implement `scripts/github-app-token.ts` and `scripts/tracker.ts` (+ a small pricing module) in the already scaffolded
repo. Work on branch `feat/tracker` and open a PR when done. Follow the repo conventions from `CLAUDE.md`: Node 24, pure
ESM, TypeScript via native type stripping (no build), `.ts` import extensions, erasable syntax only, Biome/Ultracite
formatting.

## Context

Frankenstein is an agent that builds its own skills. Every skill build is tracked by one GitHub issue with three states:
**open** (what skill and why), **blocked** (why it failed), **done** (what was built + token usage and USD, issue
closed). Everything is written by a **GitHub App** (bot identity), never by a human account. The agent never writes to
GitHub directly – it only calls `tracker.ts` with short texts; numbers (tokens, USD) are filled in by the script.

The GitHub org and App already exist. Required env vars (in `.env`, never committed, never printed):
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_REPO` (owner/name).

## Hard rules

- Never print, log or return the installation token or the private key. Redact them in any error output.
- Call `gh` and `git` via `node:child_process` `execFile` with an argument array – no shell, no string concatenation
  (Windows quoting + injection).
- Pass issue and comment bodies via stdin (`--body-file -`), never as a CLI argument.
- No new dependencies. Use `node:crypto`, `node:util` (`parseArgs`), global `fetch`.
- Must work identically on Windows and macOS.

## 1. `scripts/github-app-token.ts`

Export (no CLI that prints the token):

- `createAppJwt(appId, privateKeyPem, now?)` – RS256 JWT, `iat = now - 60`, `exp = now + 540`, `iss = appId`, base64url,
  signed with `node:crypto`.
- `getInstallationToken()` – POST `https://api.github.com/app/installations/{id}/access_tokens` with
  `Authorization: Bearer <jwt>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`. Cache in
  memory until 5 minutes before `expires_at`. Single-flight: concurrent callers share one in-flight request; a failed
  request is not cached.
- `getBotIdentity()` – `GET /app` (JWT) for `slug`, then `GET /users/{slug}[bot]` for the bot user `id`. Returns
  `{ name: "<slug>[bot]", email: "<id>+<slug>[bot]@users.noreply.github.com" }`. Cached for the process lifetime, also
  single-flight.
- `botEnv()` – returns env vars for child processes: `GH_TOKEN`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
  `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, plus git isolation so the operator's git setup is never used:
  `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_ALLOW_PROTOCOL=https`, `GIT_ASKPASS=`,
  `GIT_TERMINAL_PROMPT=0` and `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` setting `commit.gpgSign`, `tag.gpgSign`,
  `tag.forceSignAnnotated`, `push.gpgSign` to `false`, `credential.helper` to only `!gh auth git-credential`, and
  `url.https://github.com/.insteadOf` for `git@github.com:` and `ssh://git@github.com/`.
- `runAsBot(cmd, args, { stdin? })` – `execFile` with `{ ...process.env without GIT_*, ...botEnv() }`, returns stdout,
  throws with redacted stderr.

## 2. `scripts/lib/pricing.ts`

- A price table per model (USD per 1M tokens): `input`, `cacheWrite`, `cacheRead`, `output`, for the models we use
  (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, with Haiku's long-prompt tier as `longPrompt` rates).
  Unknown models throw. Take the numbers from the official Anthropic pricing page and add the source URL + date as a
  comment.
- `computeCost(usage)` where usage is `Array<{ model, input, cacheWrite, cacheRead, output, longPrompt? }>` →
  `{ totalUsd, perModel, totals }`.

## 3. `scripts/tracker.ts` (CLI)

Use `parseArgs`. All commands accept `--dry-run`: print the `gh` invocations + bodies instead of executing them and
write no files (no `issue.json`, no budget state). Dry-run still loads `.env` when present, so it shows the real
`--repo`; without `GITHUB_REPO` it uses the placeholder `OWNER/REPO`. Output is JSON on stdout, one line.

```text
node scripts/tracker.ts open    --skill <name> --summary <text>
node scripts/tracker.ts blocked --issue <n> --reason <text>
node scripts/tracker.ts done    --issue <n> --summary <text> [--usage <path/to/usage.json>] [--version <vN>]
```

- `open` – ensure labels `skill-build` and `blocked` exist (`gh label create … --force`), create issue titled
  `skill: <name>` with label `skill-build`, body = `` ## Skill build: `<name>` `` heading + summary. Writes
  `work/<name>/issue.json` (`{ "issue": <n>, "url": "<url>" }`) for later steps (registry install). Output
  `{ "issue": <n>, "url": "<url>" }`.
- `blocked` – add label `blocked`, add comment `**Blocked:** <reason>`. Issue stays open. Output
  `{ "issue": <n>, "state": "blocked" }`.
- `done` – remove label `blocked` if present, comment with summary + a cost table (per model: input, cache write, cache
  read, output tokens, USD; plus total USD) + version if given, then close the issue. Usage comes from `--usage` if
  given, otherwise from the current Claude Code session tracked by the budget hook (`work/.run/current.json`, see
  `scripts/hooks/budget.ts`); dry-run reads that state without locking or rewriting it. Output
  `{ "issue": <n>, "state": "done", "totalUsd": <number> }`.
- Always pass `--repo $GITHUB_REPO`.
- Keep body/comment formatting in pure exported functions (`formatOpenBody`, `formatBlockedComment`,
  `formatDoneComment`) so they are unit-testable.

## 4. Tests (`node:test`, no network)

- `scripts/github-app-token.test.ts` – generate an RSA key pair with `crypto.generateKeyPairSync`, build a JWT with a
  fixed `now`, verify the signature and claims with the public key. With a stubbed `fetch`, concurrent cold `botEnv()`
  calls mint one token and look up the identity once; a failed mint is retried. `runAsBot("git", …)` in a temp repo
  whose global, local and `GIT_CONFIG_PARAMETERS` config demand signing makes unsigned, bot-authored commits and tags,
  resolves a `git@github.com:` origin to HTTPS and refuses an SSH push.
- `scripts/lib/pricing.test.ts` – cost calculation on a known usage sample.
- `scripts/tracker.test.ts` – formatting functions, `--dry-run` output of each command, `.env`/placeholder repo
  resolution, and session usage via `work/.run/current.json` (dry-run leaves the budget state untouched).

## 5. Manual verification (real GitHub, against our repo)

1. `node scripts/tracker.ts open --skill test-skill --summary "Tracker smoke test"` → issue appears, author is the bot.
2. `node scripts/tracker.ts blocked --issue <n> --reason "Smoke test of blocked state"` → label + bot comment.
3. Create a sample `usage.json`, run `done` → blocked label removed, cost comment, issue closed.
4. Report the issue URL to Vito, then leave the issue closed.

## 6. Docker check on Windows (separate, report results)

1. `npm run sandbox:build`
2. In PowerShell from repo root:
   `docker run --rm --network none -v "${PWD}\fixtures:/skill:ro" frankenstein-sandbox -e "console.log(require('node:fs').readdirSync('/skill'))"`
3. Report: did the build succeed, did the mount list the files, any path issues.

## Done when

- `npm run check`, `npm run typecheck`, `npm test` pass.
- Manual verification steps 1–3 succeeded and the issue shows the bot as author of every action.
- PR `feat: github app token + issue tracker` is open. (Merged as PR #3 on 2026-10-08.)
