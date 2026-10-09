# Task: Demo case – payment matching and reminders

Work on branch `feat/demo`. Follow `CLAUDE.md` conventions. Feature freeze is on: no product changes in this task, only
demo material.

**Hard rule: no skill code, nothing the agent is supposed to build.** You prepare only data, texts and a run-of-show.
Anything the team pre-writes in place of the agent is "the one unforgivable fake".

## The story

The agent's ecosystem grows across fresh sessions:

1. **Session 1:** "Here is my bank statement and my issued invoices. Which ones are paid?" → the agent has no skill,
   asks a few questions, builds a payment-matching skill, answers.
2. **Session 2 (new):** "Who owes me more than 30 days? Prepare reminders." → the agent finds skill 1, builds a
   reminder-drafting skill on top of it, answers. Much cheaper than session 1.

Pitch line: bank data never passes through the model and never leaves a sandbox without network.

## 0. Preparation rules

1. **Encoding.** The Write tool always writes UTF-8. Write the statement as `demo/data/bank-statement.utf8.csv`, then
   ask the user (Vito, on macOS) to convert it:
   `iconv -f UTF-8 -t WINDOWS-1250 demo/data/bank-statement.utf8.csv > demo/data/bank-statement.csv`
   and verify with `file -I demo/data/bank-statement.csv` (must not say utf-8). Then delete the `.utf8.csv` file. Do not
   write helper scripts for this – the Bash guard will block interpreter calls, which is expected.
2. **Answer key is checked by a human.** After writing `answer-key.md`, stop and ask the user to verify by hand at
   least: the partial payment, the overpayment, the wrong VS, the missing VS, the payment with no invoice, the
   two-invoices-in-one-transfer case and the outgoing payment. Add a line `Checked by: <name>` at the top only after the
   user confirms.
3. **Only data and texts in the repo.** If you generate data with any helper code, do not save or commit it. Nothing
   under `demo/` may be executable code – judges must not mistake it for team-written skill code.

## 1. Data – `demo/data/`

Realistic but fully synthetic (invented companies, IČO-like numbers are fine, no real people). Files are passed to
skills via `--mount`, so they must live in `demo/data/`.

`bank-statement.csv` – export as a Czech bank would produce it:

- `;` separator, decimal comma, Czech headers (e.g.
  `Datum;Objem;Měna;Protiúčet;Kód banky;VS;KS;SS;Zpráva pro příjemce;Typ`), dates `dd.mm.yyyy`.
- Encoded in **windows-1250** with diacritics in names and messages.
- 30–40 rows over ~2 months, incoming and outgoing.
- Traps, at least one each: partial payment (two payments for one invoice), overpayment, missing VS but invoice number
  in the message, wrong VS (typo), payment with no matching invoice, two invoices paid in one transfer, an outgoing
  payment that must be ignored.

`invoices.csv` – issued invoices (UTF-8): number, VS, customer, customer IČO, customer e-mail (only `@example.com`),
issue date, due date, amount, currency.

- 15–20 invoices; 4–6 clearly overdue more than 30 days relative to the demo date, 2–3 overdue less than 30 days, rest
  paid.

`answer-key.md` – the correct result per invoice (paid / partially paid / unpaid / overpaid, amount outstanding, which
bank rows matched) and the expected debtor list for session 2. For us to check the agent's output and to answer grill-me
questions consistently. Never feed it to the agent.

## 2. Texts – `demo/`

- `tasks.md` – the exact prompts for sessions 1 and 2, phrased like a real user, never "build a tool/skill for X". State
  the reference date explicitly in session 2.
- `answers.md` – short prepared answers to the questions the agent will likely ask (matching rules, partial payments,
  overpayments, tolerance, reminder tone, language, signature, what "30 days" counts from). Consistent with
  `answer-key.md`.
- `run-of-show.md` – what is on screen while recording (agent pane, `logs/<skill>/latest.log`, `docker ps` loop,
  `registry.json`, GitHub issue), which moments to keep for the 90 s video, where to speed up.

## 3. Dress rehearsal

1. `npm run demo:reset -- --yes`, fresh Claude Code session in the repo root.
2. Run sessions 1 and 2 exactly by `tasks.md`, answer with `answers.md`.
3. Compare results against `answer-key.md`.
4. Record per session: duration, number of builder iterations, cost from the closed issue, sandbox audit, anything that
   went wrong.
5. Write it into `demo/rehearsal-notes.md`, then reset again before the recording run.

## Done when

- Data, texts and run-of-show are in `demo/`; `bank-statement.csv` is windows-1250, no `.utf8.csv` left, no code under
  `demo/`.
- `answer-key.md` starts with `Checked by: <name>`.
- Two dress rehearsals done, notes written.
- PR `feat: demo case data and run-of-show` is open.
