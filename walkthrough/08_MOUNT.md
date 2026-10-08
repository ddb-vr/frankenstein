# Task: Input and output files for skills (`--mount`, `--output`)

Work on branch `feat/mount`. Builds on current `main`. Follow `CLAUDE.md` conventions. No new dependencies.

## Why

A skill runs in a container that only sees its own directory, so it cannot read a user's bank statement or invoices.
Passing file contents inside the JSON argument would push sensitive data through the model's context (tokens + privacy).
Instead, files are mounted read-only into the container and the skill receives only paths. Pitch claim this must make
true: user data never passes through the model and never leaves an offline sandbox.

## 1. `scripts/sandbox.ts`

Extend `runInSandbox` / `buildDockerArgs` options:

- `mounts?: string[]` – host files or directories, each mounted read-only at `/input/<basename>`. Basename collision →
  error.
- `outputDir?: string` – host directory mounted read-write at `/output`.
- Log every mount (host path → container path, ro/rw) into the run log.

## 2. `scripts/run-skill.ts`

```text
node scripts/run-skill.ts <name> '<json>' [--mount <path>]... [--output <dir>]
node scripts/run-skill.ts <name> --input-file <file> [--mount <path>]... [--output <dir>]
```

Path policy, enforced in code (not only in the guard):

- Allowed roots from env `INPUT_ALLOWED_ROOTS` (comma-separated, default `demo/data,inputs`); every `--mount` path must
  resolve (after `realpath`, so symlinks cannot escape) inside one of them and exist.
- Always denied, even inside allowed roots: `.env*`, `*.pem`, `.git`, `.claude`, `scripts`, `work/.locks`, the user's
  home directory itself.
- `--output` must resolve inside `out/` (gitignored, created on demand). Default when omitted: no output mount.
- Violation → exit 1 with a clear reason, nothing is started.

## 3. `scripts/run-examples.ts`

No new flags. Test input files are part of the skill: `work/<skill>/fixtures/input/…`, referenced in `examples.json`
inputs as `/skill/fixtures/input/<file>`. The runner mounts a fresh temp directory as `/output` for every example (so
skills that write files do not fail in tests) and deletes it afterwards. Examples still compare stdout JSON only.

## 4. Skill contract update

Update every place that describes the contract (`SANDBOX.md`-derived docs, `scripts/lib/examples.ts` comments,
skill-builder and skill-reviewer agents, meta-skill, `CLAUDE.md`):

- Input files arrive as paths in the JSON input, under `/input/` at runtime and `/skill/fixtures/input/` in tests. Never
  hardcode either prefix – always use the path given in the input.
- If `/output` exists, large results go there as files; stdout stays a compact JSON summary (counts, totals, file
  names).
- Handle encodings explicitly: `TextDecoder` with the detected or stated encoding (e.g. `windows-1250` for Czech bank
  exports). Verify that `node:24-slim` decodes `windows-1250` correctly and note the result in the README.
- The reviewer checks that no path is hardcoded and that stdout stays compact.

Main agent rule in `CLAUDE.md` / meta-skill: **do not read user data files into context.** Pass them with `--mount`, ask
the skill for a summary, and point the user to the files in `out/`. The PRD subagent may look at the first few lines of
a file only to learn its format (headers, separator, encoding), never the whole file.

## 5. Guards and audit

- Bash guard: allow the new flags on `run-skill.ts`; nothing else changes.
- File guard: deny agent writes under `out/` (only skills write there via the container).
- `audit-run.ts`: include mounts per run and flag any denied mount attempt.
- `.gitignore`: add `out/` and `inputs/`.

## 6. Tests (`node:test`)

- `buildDockerArgs`: ro input mounts at `/input/<basename>`, rw output at `/output`, basename collision error.
- Path policy: allowed root, outside root, symlink escaping a root, `.env`, `.pem`, `.git`, `.claude`, home dir, output
  outside `out/`.
- run-examples: temp `/output` created and cleaned up.
- run-skill argument parsing with mounts and `--input-file`.

## 7. Manual verification

1. Put a small CSV into `demo/data/`, run a fixture skill that counts its lines via `--mount` → works, file visible only
   read-only (writing to `/input` fails).
2. `--mount .env` and `--mount ~` → refused with a reason.
3. `--output out/test` → files appear in `out/test`, stdout is a short summary.
4. A `windows-1250` file with diacritics decodes correctly inside the container.

## Done when

- `npm run check`, `npm run typecheck`, `npm test` pass.
- Manual verification 1–4 behaves as described.
- PR `feat: input/output mounts for skills` is open.
