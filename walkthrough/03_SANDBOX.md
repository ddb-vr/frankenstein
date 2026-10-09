# Task: Sandbox + skill test runner

Implement `scripts/sandbox.ts` and `scripts/run-examples.ts`, define the skill contract and verify everything on a
fixture skill. Work on branch `feat/sandbox`. Follow the repo conventions from `CLAUDE.md` (Node 24, pure ESM, native
type stripping, `.ts` imports, erasable syntax only, Biome/Ultracite). No new dependencies.

## Context

Hackathon hard rules this task enforces:

- Generated code runs in a sandbox, never on a host holding credentials.
- No install without passing tests; the test run is visible in the log.

Token efficiency: the agent calls the runner through its Bash tool and sees everything printed. So the runner prints
only a one-line JSON summary to stdout. The full test output goes to a log file, which a human watches in a split
terminal (`tail -f` / `Get-Content -Wait`).

## 1. Skill contract

A skill directory looks like this (same layout in `.claude/skills/<name>/` and `work/<name>/`):

```text
<skill>/
├── SKILL.md
├── examples.json        # source of truth, written by the PRD subagent, locked during build
├── scripts/
│   └── main.ts          # entry point
├── tests/               # unit tests for scripts (node:test), optional for trivial skills; if present, needs ≥1 *.test.ts
│   └── *.test.ts
└── fixtures/            # recorded HTTP responses for offline tests, optional
```

Entry point contract (`scripts/main.ts`):

- Reads a single JSON value from stdin, writes a single JSON value to stdout, exit code 0.
- On a handled error writes `{ "error": "<message>" }` to stdout and exits with code 1.
- When `FRANKENSTEIN_MODE=test`, it must not touch the network; skills that call APIs read recorded responses from
  `/skill/fixtures/`.

`examples.json` schema (export a TypeScript type + a runtime validator in `scripts/lib/examples.ts`):

```json
{
  "skill": "skill-name",
  "entry": "scripts/main.ts",
  "examples": [
    {
      "name": "short description",
      "input": {},
      "expected": {},
      "match": "exact"
    }
  ]
}
```

- `entry`: must be exactly `"scripts/main.ts"` (the file `run-skill` executes for installed skills); any other value
  fails validation.
- `match`: `"exact"` (deep equal) or `"subset"` (every key in `expected` must deep-equal the same key in the output;
  extra output keys allowed). Default `"exact"`.
- An example expecting an error has `"expected": { "error": true }`: passes when the script exits 1 and outputs an
  object with an `error` string.

## 2. `scripts/sandbox.ts`

Export:

- `resolveSkillDir(skillDir)` – real path (symlinks resolved) of a skill directory; throws unless it is a direct child
  of `<repo>/work`, `<repo>/fixtures/skills` or `<repo>/.claude/skills` with a kebab-case name.
- `buildDockerArgs(options)` – pure function returning the `docker run` argument array. Testable without Docker.
- `runInSandbox(options)` – resolves `skillDir` with `resolveSkillDir`, then runs it via `execFile` (no shell), returns
  `{ exitCode, stdout, stderr, timedOut, durationMs }`.

Options:
`{ skillDir, command: string[], stdin?, network?: boolean (default false), env?: Record<string,string>, testMode?: boolean (default true), timeoutMs? (default 30000), onRunLog? }`.
`testMode: false` is only for real runs of installed skills (`run-skill`).

Docker arguments (always):

```text
run --rm -i --name frk-<random>
--network none                      # unless network: true
--read-only --tmpfs /tmp
--cap-drop ALL --security-opt no-new-privileges
--pids-limit 128 --cpus 1 --memory 512m
--user node
-v <absolute skillDir>:/skill:ro
-e FRANKENSTEIN_MODE=test          # only when testMode (default); plus only explicitly passed env vars
frankenstein-sandbox <command...>
```

- Never forward `process.env`, never pass `--env-file`.
- Never mount the repo root or home: `runInSandbox` accepts only skill directories (`resolveSkillDir`), and
  `buildDockerArgs` refuses the repo root, the home directory and any ancestor of either.
- `skillDir` is resolved with `path.resolve` (works on Windows paths with Docker Desktop).
- On timeout, run `docker kill frk-<name>` (killing the docker CLI alone leaves the container running).
- Image ENTRYPOINT is `node`, so `command` is e.g. `["/skill/scripts/main.ts"]` or
  `["--test", "--test-reporter=spec", "/skill/tests/**/*.test.ts"]`.

## 3. `scripts/run-examples.ts` (CLI)

```text
node scripts/run-examples.ts <skillDir>
```

`<skillDir>` must be `work/<skill>`, `fixtures/skills/<skill>` or `.claude/skills/<skill>` (symlinks resolved); anything
else (e.g. `.` or `~`) exits 2 with a message on stderr and no summary.

Steps:

1. Validate `examples.json` and that `SKILL.md` and the entry exist. Invalid → FAIL with reason.
2. If `tests/` exists: run unit tests in the sandbox (`node --test --test-reporter=spec /skill/tests/**/*.test.ts`). A
   `tests/` directory without any `*.test.ts` file → FAIL at stage `unit`. No `tests/` → `"unit": "skipped"`.
3. Run every example in the sandbox: input JSON via stdin, compare output per `match`.
4. Stop at the first failure only for the summary; still log every example result.

Logging:

- Full output (each step, each example: input, expected, actual, pass/fail, duration, raw stderr) goes to
  `logs/<skill>/<ISO timestamp>.log`.
- Also append one line per result to `logs/<skill>/latest.log` (truncate at run start) so a human can `tail -f` it.

stdout = exactly one JSON line, exit code 0 on PASS, 1 on FAIL:

```json
{"status": "PASS", "unit": "pass", "examples": {"passed": 4, "total": 4}, "log": "logs/x/2026-10-08T21-30-00.log"}
{
  "status": "FAIL",
  "stage": "examples",
  "example": "invalid checksum",
  "reason": "expected {...} got {...}",
  "log": "logs/x/..."
}
```

`reason` is truncated to 500 characters.

## 4. Fixture skill (internal only, never installed, never demoed)

`fixtures/skills/text-stats/` – trivial skill: input `{ "text": string }` → output
`{ "words": number, "chars": number }`, error when `text` is missing. Include SKILL.md, `scripts/main.ts`, one unit
test, and `examples.json` with 3 examples (one error case).

Also add `fixtures/skills/text-stats-broken/` – same skill with one wrong expected value in `examples.json`, to verify
the FAIL path.

## 5. Tests (`node:test`, no Docker required)

- `scripts/lib/examples.test.ts` – schema validation (including the pinned entry), `exact` and `subset` matching,
  error-case matching.
- `scripts/sandbox.test.ts` – `buildDockerArgs`: offline by default, network only when requested, no env leakage,
  read-only mount, absolute path, refuses repo root/home/ancestors; `resolveSkillDir`: only direct children of the skill
  roots, symlinks resolved.
- `scripts/run-examples.test.ts` – summary formatting, reason truncation, unit test discovery (`findUnitTests`).

## 6. Manual verification

1. `npm run sandbox:build`
2. `node scripts/run-examples.ts fixtures/skills/text-stats` → PASS, log file written.
3. `node scripts/run-examples.ts fixtures/skills/text-stats-broken` → FAIL with the right example name.
4. Add a temporary example whose script tries `fetch('https://example.com')` → must fail (no network). Remove it
   afterwards.
5. Check that `env` inside the container shows no host secrets.

## Done when

- `npm run check`, `npm run typecheck`, `npm test` pass.
- Manual verification 1–5 behaves as described on macOS; ask the teammate to run step 2 on Windows.
- PR `feat: sandbox + skill test runner` (PR #1 from `feat/sandbox`) is merged.
