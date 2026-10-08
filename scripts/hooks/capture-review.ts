// SubagentStop hook (matcher `skill-reviewer`): records the reviewer's final
// verdict. The reviewer ends its answer with a fenced `verdict` block
// (`{ "skill", "verdict": "approve" | "reject", "reasons": [] }`); this hook
// writes it to `work/<skill>/review.json`, the file `registry.ts install`
// checks. File tools never write review.json (guard-files denies it).
//
// Rounds: a reject may be followed by one more review after another builder
// iteration. An approve, or the verdict of the last round, is final.
//
// A missing or malformed block blocks the stop once, so the reviewer fixes its
// answer; on the retry (`stop_hook_active`) the reviewer may stop and nothing
// is written, so install keeps refusing. Hook errors also write nothing.

import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPlainObject, SKILL_NAME } from "../lib/examples.ts";
import { REPO_ROOT } from "./lib.ts";

export const REVIEWER_AGENT = "skill-reviewer";
export const MAX_REVIEW_ROUNDS = 2;
const VERDICT_BLOCK = /```verdict[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g;
const BLOCK_FORMAT =
  'End your answer with exactly one fenced block:\n```verdict\n{ "skill": "<name>", "verdict": "approve" | "reject", "reasons": ["…"] }\n```';

export interface Verdict {
  reasons: string[];
  skill: string;
  verdict: "approve" | "reject";
}

export interface Review extends Verdict {
  reviewedAt: string;
  round: number;
}

export interface StopInput {
  agentType: string;
  message: string;
  stopHookActive: boolean;
}

export type CaptureOutcome =
  /** Keep the reviewer running; `reason` is its next instruction. */
  | { kind: "retry"; reason: string }
  /** Nothing written; `message` is shown to the user. */
  | { kind: "skipped"; message: string }
  | { kind: "written"; review: Review };

/** The last `verdict` block of a message; throws an actionable error. */
export const parseVerdict = (message: string): Verdict => {
  const blocks = [...message.matchAll(VERDICT_BLOCK)];
  const body = blocks.at(-1)?.[1];
  if (body === undefined) {
    throw new Error("no fenced `verdict` block found");
  }
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch (error) {
    throw new Error("the `verdict` block is not valid JSON", { cause: error });
  }
  if (!isPlainObject(data)) {
    throw new Error("the `verdict` block must be a JSON object");
  }
  const { skill, verdict, reasons } = data;
  if (typeof skill !== "string" || !SKILL_NAME.test(skill)) {
    throw new Error('"skill" must be the kebab-case skill name');
  }
  if (verdict !== "approve" && verdict !== "reject") {
    throw new Error('"verdict" must be "approve" or "reject"');
  }
  if (
    !(
      Array.isArray(reasons) &&
      reasons.every((reason) => typeof reason === "string")
    )
  ) {
    throw new Error('"reasons" must be an array of strings');
  }
  if (verdict === "reject" && reasons.length === 0) {
    throw new Error("a reject needs at least one actionable reason");
  }
  return { reasons, skill, verdict };
};

const reviewPath = (root: string, skill: string): string =>
  path.join(root, "work", skill, "review.json");

/** Round of the review already on disk; 0 when there is none. */
const previousRound = (
  file: string
): { round: number; verdict: unknown } | undefined => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { round: 0, verdict: undefined };
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return;
  }
  if (!isPlainObject(data)) {
    return;
  }
  const round =
    typeof data.round === "number" && Number.isInteger(data.round)
      ? data.round
      : 1;
  return { round, verdict: data.verdict };
};

export const captureReview = (
  input: StopInput,
  root: string,
  now: Date
): CaptureOutcome => {
  if (input.agentType !== REVIEWER_AGENT) {
    return { kind: "skipped", message: `not a ${REVIEWER_AGENT} stop` };
  }
  let verdict: Verdict;
  try {
    verdict = parseVerdict(input.message);
    if (!statSync(path.join(root, "work", verdict.skill)).isDirectory()) {
      throw new Error(`work/${verdict.skill} is not a directory`);
    }
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    if (input.stopHookActive) {
      return {
        kind: "skipped",
        message: `capture-review: no verdict recorded (${problem}); install stays blocked.`,
      };
    }
    const unknownSkill =
      error instanceof Error && "code" in error && error.code === "ENOENT";
    return {
      kind: "retry",
      reason: `Your verdict was not recorded: ${unknownSkill ? "work/<skill> does not exist; use the exact skill name" : problem}. ${BLOCK_FORMAT}`,
    };
  }
  const file = reviewPath(root, verdict.skill);
  const previous = previousRound(file);
  if (previous === undefined) {
    return {
      kind: "skipped",
      message: `capture-review: work/${verdict.skill}/review.json is malformed; not overwritten.`,
    };
  }
  if (previous.verdict === "approve" || previous.round >= MAX_REVIEW_ROUNDS) {
    return {
      kind: "skipped",
      message: `capture-review: work/${verdict.skill}/review.json is final (round ${previous.round}, ${String(previous.verdict)}); this review was not recorded.`,
    };
  }
  const review: Review = {
    ...verdict,
    reviewedAt: now.toISOString(),
    round: previous.round + 1,
  };
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(review, null, 2)}\n`);
  renameSync(temporary, file);
  return { kind: "written", review };
};

export const parseStopInput = (text: string): StopInput => {
  const data: unknown = JSON.parse(text);
  if (!isPlainObject(data)) {
    throw new Error("hook input is not a JSON object");
  }
  const {
    agent_type: agentType,
    last_assistant_message: message,
    stop_hook_active: stopHookActive,
  } = data;
  return {
    agentType: typeof agentType === "string" ? agentType : "",
    message: typeof message === "string" ? message : "",
    stopHookActive: stopHookActive === true,
  };
};

const outputFor = (outcome: CaptureOutcome): Record<string, string> => {
  switch (outcome.kind) {
    case "retry":
      return { decision: "block", reason: outcome.reason };
    case "skipped":
      return { systemMessage: outcome.message };
    default: {
      const { round, skill, verdict } = outcome.review;
      return {
        systemMessage: `capture-review: work/${skill}/review.json = ${verdict} (round ${round}/${MAX_REVIEW_ROUNDS}).`,
      };
    }
  }
};

if (import.meta.main) {
  let output: Record<string, string>;
  try {
    const input = parseStopInput(readFileSync(0, "utf8"));
    output = outputFor(captureReview(input, REPO_ROOT, new Date()));
  } catch (error) {
    // Nothing was written, so install keeps refusing (fails closed).
    output = {
      systemMessage: `capture-review failed, no verdict recorded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
