// Test helper: installs a recorded session from `fixtures/audit/<name>/` into
// a scratch directory, as Claude Code and the hooks would have left it.
//
// Fixture layout: `transcripts/<session>.jsonl` (+ `<session>/subagents/`)
// and `repo/logs/` (hooks.log, sandbox run logs). `__ROOT__` stands for the
// repo root; it becomes `<dir>/repo`. The budget state and `current.json`
// that point the audit at the session are written here.

import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FIXTURES = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "audit"
);
const ROOT_PLACEHOLDER = "__ROOT__";
const SESSION_FILE = /^(.+)\.jsonl$/;

export interface InstalledSession {
  root: string;
  sessionId: string;
}

export const installAuditFixture = async (
  name: string,
  dir: string
): Promise<InstalledSession> => {
  await cp(path.join(FIXTURES, name), dir, { recursive: true });
  const root = path.join(dir, "repo");
  const files = await readdir(dir, { recursive: true });
  await Promise.all(
    files
      .filter((file) => file.endsWith(".jsonl") || file.endsWith(".log"))
      .map(async (file) => {
        const full = path.join(dir, file);
        const text = await readFile(full, "utf8");
        // Transcripts are JSON: a Windows root needs escaped backslashes.
        const replacement = file.endsWith(".jsonl")
          ? JSON.stringify(root).slice(1, -1)
          : root;
        await writeFile(full, text.replaceAll(ROOT_PLACEHOLDER, replacement));
      })
  );
  const transcripts = path.join(dir, "transcripts");
  const sessionId = (await readdir(transcripts))
    .map((entry) => SESSION_FILE.exec(entry)?.[1])
    .find((id) => id !== undefined);
  if (sessionId === undefined) {
    throw new Error(`fixture ${name} has no session transcript`);
  }
  const runDir = path.join(root, "work", ".run");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, `${sessionId}.json`),
    JSON.stringify({
      builderInvocations: 0,
      files: {},
      sessionId,
      transcriptPath: path.join(transcripts, `${sessionId}.jsonl`),
      usage: {},
    })
  );
  await writeFile(
    path.join(runDir, "current.json"),
    JSON.stringify({ sessionId, state: `work/.run/${sessionId}.json` })
  );
  return { root, sessionId };
};
