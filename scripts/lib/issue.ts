// `work/<skill>/issue.json`: the build issue of a skill, written by
// `tracker.ts open` so later steps (`registry.ts install`) don't depend on the
// agent remembering the number.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPlainObject } from "./examples.ts";

export interface IssueRecord {
  issue: number;
  url: string;
}

export const issueRecordPath = (root: string, skill: string): string =>
  path.join(root, "work", skill, "issue.json");

export const writeIssueRecord = (
  root: string,
  skill: string,
  record: IssueRecord
): void => {
  const file = issueRecordPath(root, skill);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
};

/** The skill's build issue, or `undefined` when none was opened. */
export const readIssueRecord = (
  root: string,
  skill: string
): IssueRecord | undefined => {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(issueRecordPath(root, skill), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    !(
      isPlainObject(data) &&
      Number.isInteger(data.issue) &&
      typeof data.issue === "number" &&
      data.issue > 0 &&
      typeof data.url === "string"
    )
  ) {
    throw new Error(`work/${skill}/issue.json is malformed`);
  }
  return { issue: data.issue, url: data.url };
};
