---
name: grill-me
description: Plain-language clarifying questions for a non-technical user, in rounds of multiple-choice questions with a recommended answer. Used by the frankenstein Intake (prd-writer questions mode and the grill me step); it is a lifecycle skill, not a user capability, so never pick it to solve a task.
---

# Grill me (plain language)

Turn a vague request into a shared understanding by asking the user questions they can answer without technical
knowledge. Adapted from Matt Pocock's
[grilling skill](https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md) for people who
do not write code.

## How to choose the questions

- **Decision tree.** Every decision opens the decisions that hang off it. Ask only the questions the current answers
  already allow (the *frontier*). A question that depends on another question still open in this round belongs to a
  later round.
- **Rounds.** Ask the whole frontier in one round, at most 4 questions per round, at most 6 rounds in total. Then wait
  for the answers and recompute the frontier.
- **Facts are your job, decisions are the user's.** Never ask the user for something you can look up yourself: API
  fields, which website or service has the data, file formats, how a check digit works. Look it up in the files and
  docs you can read and turn it into a recommended option instead. If you cannot look it up, recommend the usual
  choice and list it as an assumption. Ask only what the user wants.

## How to word them

- Use the user's language (reply in Czech when the user writes Czech) and everyday words.
- No technical terms: not JSON, stdin, stdout, schema, field, API, endpoint, HTTP, regex, exit code, null, boolean.
  Talk about what the user sees and does instead: "the list of suppliers you paste in", "what you see at the end",
  "the company name and address", "a message saying the number is wrong".
- Use concrete examples from the user's world (an invoice, a spreadsheet column, a real company) rather than abstract
  cases.
- Offer 2–4 options per question, recommended option first and marked "(recommended)". Word the question so "yes"
  accepts the recommended option.
- Add one short *Why* line per question in plain words: what changes in the result depending on the answer.
- Prefer options over open questions. The user can always answer in their own words.

## Format

With the `AskUserQuestion` tool: one tool question per question, options as listed, recommended option first.

Plain-text fallback (also the format the `prd-writer` agent returns):

```text
1. <question in plain words>
   a) <recommended option> (recommended)  b) <option>  c) <option>
   Why: <one line in plain words>
```

Accept answers like `1a, 2c`, free text, or `yes` (all recommended options).

## Example

Bad: "Should the output JSON include the `dic` field, or null when absent?"

Good:

```text
1. Should the result also show the company's VAT number (DIČ)?
   a) Yes, when the company has one (recommended)  b) No, name and address are enough
   Why: some companies have no VAT number, so the result would say "none" for them.
```

## Done

The grilling is done when the frontier is empty (every decision answered, nothing silently assumed) or the round cap is
reached. Unanswered points become open points; never fill them with guesses.
