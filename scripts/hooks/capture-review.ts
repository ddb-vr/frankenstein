// Records the skill-reviewer's final verdict. The reviewer ends its report
// with exactly one fenced `verdict` block (`{ "skill", "verdict": "approve" |
// "reject", "reasons": [] }`); this hook writes `work/<skill>/review.json`
// (`{ skill, verdict, reasons, examplesHash, capturedAt }`, `examplesHash`
// from the examples lock), the file `registry.ts install` checks. File tools
// never write review.json (guard-files denies it). Two events carry the
// report:
// - SubagentStop (matcher `skill-reviewer`): `last_assistant_message`.
// - PreToolUse (matcher `SubagentHandback`): in auto mode the subagent hands
//   its report back through that tool (`tool_input.message`); its closing
//   text at SubagentStop is then not the report, so that stop is ignored.
//
// Each recorded review supersedes the previous review.json: a new review
// after a fix replaces an earlier approve or reject.
//
// A missing, duplicated or invalid block sends the reviewer back once (stop
// blocked, or hand-back denied; a `handback-<agentId>.retry` marker in
// work/.run bounds hand-backs). The second failure records
// `{ "verdict": "reject", "reasons": ["no valid verdict block"] }` for the
// skill its block names, so install refuses; when no existing skill is named,
// nothing is written. Every capture (written or retry) is appended to
// `logs/<skill>/reviews.log`. Hook errors write nothing.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { isPlainObject, SKILL_NAME } from "../lib/examples.ts";
import { readLock } from "../lock.ts";
import { type LogEntry, logDecision, REPO_ROOT } from "./lib.ts";

export const REVIEWER_AGENT = "skill-reviewer";
/** Reasons of the reject recorded when the reviewer never sends a valid block. */
export const NO_VALID_BLOCK = "no valid verdict block";
const VERDICT_BLOCK = /```verdict[^\S\n]*\n([\s\S]*?)\n[^\S\n]*```/g;
const SKILL_FIELD = /"skill"\s*:\s*"([^"]*)"/;
const HANDBACK_TOOL = "SubagentHandback";
const AGENT_ID = /^[A-Za-z0-9_-]+$/;
const BLOCK_FORMAT =
  'End your answer with exactly one fenced block:\n```verdict\n{ "skill": "<name>", "verdict": "approve" | "reject", "reasons": ["…"] }\n```';

export interface Verdict {
  reasons: string[];
  skill: string;
  verdict: "approve" | "reject";
}

export interface Review extends Verdict {
  capturedAt: string;
  /** sha256 of the locked examples the review covers; null when unlocked. */
  examplesHash: string | null;
}

export interface CaptureInput {
  /** `""` when absent. */
  agentId: string;
  agentType: string;
  /** The hand-back report, or the final text at stop. */
  message: string;
  /** False for a stop this hook already continued once. */
  retryAllowed: boolean;
  source: "handback" | "stop";
}

export type CaptureOutcome =
  /** Not a reviewer report: no output. */
  | { kind: "ignored" }
  /** Send the reviewer back; `reason` is its next instruction. */
  | { kind: "retry"; reason: string }
  /** Nothing written; `message` is shown to the user. */
  | { kind: "skipped"; message: string }
  /** `problem`: no valid block, so a fail-closed reject was recorded. */
  | { kind: "written"; problem?: string; review: Review };

/** Marks a reviewer whose verdict arrived by hand-back (its stop is ignored). */
const handbackMarker = (root: string, agentId: string): string =>
  path.join(root, "work", ".run", `handback-${agentId}`);

/** Marks a reviewer whose hand-back was already sent back once. */
const retryMarker = (root: string, agentId: string): string =>
  `${handbackMarker(root, agentId)}.retry`;

const touch = (file: string, content: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
};

/** The message's only `verdict` block; throws an actionable error. */
export const parseVerdict = (message: string): Verdict => {
  const blocks = [...message.matchAll(VERDICT_BLOCK)];
  if (blocks.length > 1) {
    throw new Error(
      `found ${blocks.length} fenced \`verdict\` blocks; send exactly one`
    );
  }
  const body = blocks[0]?.[1];
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

const isSkillDir = (root: string, skill: string): boolean =>
  statSync(path.join(root, "work", skill), {
    throwIfNoEntry: false,
  })?.isDirectory() === true;

/** A valid verdict for an existing `work/<skill>`; throws otherwise. */
const validVerdict = (message: string, root: string): Verdict => {
  const verdict = parseVerdict(message);
  if (!isSkillDir(root, verdict.skill)) {
    throw new Error(
      `work/${verdict.skill} does not exist; use the exact skill name`
    );
  }
  return verdict;
};

/** The one existing skill the message's (possibly invalid) blocks name. */
const namedSkill = (message: string, root: string): string | undefined => {
  const names = new Set<string>();
  for (const [, body = ""] of message.matchAll(VERDICT_BLOCK)) {
    const name = SKILL_FIELD.exec(body)?.[1];
    if (name !== undefined && SKILL_NAME.test(name) && isSkillDir(root, name)) {
      names.add(name);
    }
  }
  return names.size === 1 ? [...names][0] : undefined;
};

/** Appends one JSON line; a broken log never changes the outcome. */
const logReview = (
  root: string,
  skill: string,
  entry: Record<string, unknown>
): void => {
  try {
    const file = path.join(root, "logs", skill, "reviews.log");
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // The decision itself is still logged to logs/hooks.log.
  }
};

/** Writes review.json atomically, replacing any earlier review. */
const writeReview = (root: string, verdict: Verdict, now: Date): Review => {
  const review: Review = {
    capturedAt: now.toISOString(),
    examplesHash: readLock(root, verdict.skill)?.sha256 ?? null,
    reasons: verdict.reasons,
    skill: verdict.skill,
    verdict: verdict.verdict,
  };
  const file = path.join(root, "work", verdict.skill, "review.json");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(review, null, 2)}\n`);
  renameSync(temporary, file);
  return review;
};

/** A missing, duplicated or invalid block: one retry, then a reject. */
const captureFailure = (
  input: CaptureInput,
  root: string,
  now: Date,
  problem: string
): CaptureOutcome => {
  const handbackAgent = input.source === "handback" && input.agentId !== "";
  const retryAllowed =
    input.retryAllowed &&
    (input.source === "stop" ||
      (handbackAgent && !existsSync(retryMarker(root, input.agentId))));
  const skill = namedSkill(input.message, root);
  const logged = {
    agentId: input.agentId,
    problem,
    source: input.source,
    time: now.toISOString(),
  };
  if (retryAllowed) {
    if (handbackAgent) {
      touch(retryMarker(root, input.agentId), `${skill ?? ""}\n`);
    }
    if (skill !== undefined) {
      logReview(root, skill, { ...logged, outcome: "retry" });
    }
    return {
      kind: "retry",
      reason: `Your verdict was not recorded: ${problem}. ${BLOCK_FORMAT}`,
    };
  }
  // The hand-back was this reviewer's report: ignore its closing stop.
  if (handbackAgent) {
    touch(handbackMarker(root, input.agentId), `${skill ?? ""}\n`);
  }
  if (skill === undefined) {
    return {
      kind: "skipped",
      message: `capture-review: no verdict recorded (${problem}) and no existing work/<skill> is named, so no review.json changed.`,
    };
  }
  const review = writeReview(
    root,
    { reasons: [NO_VALID_BLOCK], skill, verdict: "reject" },
    now
  );
  logReview(root, skill, { ...logged, outcome: "written", review });
  return { kind: "written", problem, review };
};

export const captureReview = (
  input: CaptureInput,
  root: string,
  now: Date
): CaptureOutcome => {
  if (input.agentType !== REVIEWER_AGENT) {
    return { kind: "ignored" };
  }
  if (
    input.source === "stop" &&
    input.agentId !== "" &&
    existsSync(handbackMarker(root, input.agentId))
  ) {
    return { kind: "ignored" };
  }
  let verdict: Verdict;
  try {
    verdict = validVerdict(input.message, root);
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    return captureFailure(input, root, now, problem);
  }
  // The hand-back was this reviewer's report: ignore its closing stop.
  if (input.source === "handback" && input.agentId !== "") {
    touch(handbackMarker(root, input.agentId), `${verdict.skill}\n`);
  }
  const review = writeReview(root, verdict, now);
  logReview(root, verdict.skill, {
    agentId: input.agentId,
    outcome: "written",
    review,
    source: input.source,
    time: now.toISOString(),
  });
  return { kind: "written", review };
};

export const parseCaptureInput = (text: string): CaptureInput => {
  const data: unknown = JSON.parse(text);
  if (!isPlainObject(data)) {
    throw new Error("hook input is not a JSON object");
  }
  const { agent_id: agentId, agent_type: agentType } = data;
  const common = {
    agentId:
      typeof agentId === "string" && AGENT_ID.test(agentId) ? agentId : "",
    agentType: typeof agentType === "string" ? agentType : "",
  };
  if (data.hook_event_name === "SubagentStop") {
    const message = data.last_assistant_message;
    return {
      ...common,
      message: typeof message === "string" ? message : "",
      retryAllowed: data.stop_hook_active !== true,
      source: "stop",
    };
  }
  if (
    data.hook_event_name === "PreToolUse" &&
    data.tool_name === HANDBACK_TOOL &&
    isPlainObject(data.tool_input)
  ) {
    const { message } = data.tool_input;
    return {
      ...common,
      message: typeof message === "string" ? message : "",
      retryAllowed: true,
      source: "handback",
    };
  }
  throw new Error(
    `unexpected event ${String(data.hook_event_name)} / ${String(data.tool_name)}`
  );
};

const outputFor = (
  outcome: CaptureOutcome,
  source: CaptureInput["source"]
): Record<string, unknown> | undefined => {
  switch (outcome.kind) {
    case "ignored":
      return;
    case "retry":
      return source === "stop"
        ? { decision: "block", reason: outcome.reason }
        : {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: outcome.reason,
            },
          };
    case "skipped":
      return { systemMessage: outcome.message };
    default: {
      const { skill, verdict } = outcome.review;
      const why =
        outcome.problem === undefined
          ? ""
          : ` (${NO_VALID_BLOCK}: ${outcome.problem})`;
      return {
        systemMessage: `capture-review: work/${skill}/review.json = ${verdict}${why}.`,
      };
    }
  }
};

const logEntryFor = (
  outcome: CaptureOutcome,
  input: CaptureInput
): LogEntry => {
  const event = input.source === "stop" ? "SubagentStop" : HANDBACK_TOOL;
  const entry = {
    hook: "capture-review",
    subject: `${event} ${input.agentType || "(no agent type)"}`,
  };
  switch (outcome.kind) {
    case "ignored":
      return { ...entry, decision: "allow", reason: "not a reviewer report." };
    case "retry":
      return {
        ...entry,
        decision: input.source === "stop" ? "block" : "deny",
        reason: outcome.reason,
      };
    case "skipped":
      return { ...entry, decision: "allow", reason: outcome.message };
    default: {
      const { skill, verdict } = outcome.review;
      const why = outcome.problem === undefined ? "" : ` (${NO_VALID_BLOCK})`;
      return {
        ...entry,
        decision: "allow",
        reason: `recorded ${skill} ${verdict}${why}.`,
      };
    }
  }
};

if (import.meta.main) {
  let output: Record<string, unknown> | undefined;
  try {
    const input = parseCaptureInput(readFileSync(0, "utf8"));
    const outcome = captureReview(input, REPO_ROOT, new Date());
    logDecision(logEntryFor(outcome, input));
    output = outputFor(outcome, input.source);
  } catch (error) {
    // Nothing was written, so install keeps refusing (fails closed).
    const message = `capture-review failed, no verdict recorded: ${
      error instanceof Error ? error.message : String(error)
    }`;
    logDecision({
      decision: "allow",
      hook: "capture-review",
      reason: `${message}.`,
      subject: "(unreadable hook input)",
    });
    output = { systemMessage: message };
  }
  if (output !== undefined) {
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}
