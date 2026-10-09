// `tracker/issues/<n>.md`: build issues of the `local` tracker backend (no
// GitHub credentials, see `selectTrackerBackend`). Written only by
// `scripts/tracker.ts`. Front matter holds title, state, labels and
// timestamps (values as JSON); below it the issue body, then each comment with
// its timestamp, in order. Comments are only ever appended.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const LOCAL_ISSUES_DIR = "tracker/issues";

/** The three states of a build issue: open, blocked, done (closed). */
export type LocalIssueState = "open" | "blocked" | "done";

const STATES: readonly LocalIssueState[] = ["open", "blocked", "done"];

export interface LocalIssue {
  /** Body and comments, verbatim. */
  body: string;
  closedAt: string | null;
  createdAt: string;
  labels: string[];
  state: LocalIssueState;
  title: string;
  updatedAt: string;
}

/** A planned write of a repo-relative issue file. */
export interface LocalIssueFile {
  content: string;
  path: string;
}

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;
const FIELD = /^([a-zA-Z]+): (.*)$/;
const ISSUE_FILE = /^([1-9]\d*)\.md$/;
const LEADING_NEWLINE = /^\n/;

/** Repo-relative path of issue `n`, also its "URL". */
export const localIssuePath = (issue: number): string =>
  `${LOCAL_ISSUES_DIR}/${issue}.md`;

export const formatLocalIssue = (issue: LocalIssue): string => {
  const header = [
    ["title", issue.title],
    ["state", issue.state],
    ["labels", issue.labels],
    ["createdAt", issue.createdAt],
    ["updatedAt", issue.updatedAt],
    ["closedAt", issue.closedAt],
  ].map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return ["---", ...header, "---", "", issue.body].join("\n");
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export const parseLocalIssue = (text: string, file: string): LocalIssue => {
  const match = FRONT_MATTER.exec(text);
  const fields: Record<string, unknown> = {};
  try {
    for (const line of match?.[1]?.split("\n") ?? []) {
      const [, key = "", value = ""] = FIELD.exec(line) ?? [];
      fields[key] = JSON.parse(value);
    }
  } catch {
    // Reported below as malformed.
  }
  const { title, state, labels, createdAt, updatedAt, closedAt } = fields;
  if (
    !(
      match &&
      typeof title === "string" &&
      STATES.includes(state as LocalIssueState) &&
      isStringArray(labels) &&
      typeof createdAt === "string" &&
      typeof updatedAt === "string" &&
      (closedAt === null || typeof closedAt === "string")
    )
  ) {
    throw new Error(`${file} is malformed`);
  }
  return {
    // The blank line `formatLocalIssue` puts after the front matter.
    body: text.slice(match[0].length).replace(LEADING_NEWLINE, ""),
    closedAt,
    createdAt,
    labels,
    state: state as LocalIssueState,
    title,
    updatedAt,
  };
};

/** `issue` with `comment` appended, timestamped `at`. */
export const withComment = (
  issue: LocalIssue,
  at: string,
  comment: string
): LocalIssue => ({
  ...issue,
  body: `${issue.body.trimEnd()}\n\n---\n\n**Comment** (${at})\n\n${comment.trim()}\n`,
  updatedAt: at,
});

/** One more than the highest existing issue number, 1 for none. */
export const nextLocalIssueNumber = (root: string): number => {
  let names: string[] = [];
  try {
    names = readdirSync(path.join(root, LOCAL_ISSUES_DIR));
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const numbers = names.map((name) => Number(ISSUE_FILE.exec(name)?.[1] ?? 0));
  return Math.max(0, ...numbers) + 1;
};

export const readLocalIssue = (root: string, issue: number): LocalIssue => {
  const file = localIssuePath(issue);
  let text: string;
  try {
    text = readFileSync(path.join(root, file), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`local issue #${issue} not found (${file})`, {
        cause: error,
      });
    }
    throw error;
  }
  return parseLocalIssue(text, file);
};

/** Writes `file`; `create` fails instead of replacing an existing issue. */
export const writeLocalIssue = (
  root: string,
  file: LocalIssueFile,
  create: boolean
): void => {
  const absolute = path.join(root, file.path);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, file.content, { flag: create ? "wx" : "w" });
};
