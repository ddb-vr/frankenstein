# Task: Demo case – payment matching, reminders, (optional) sending via n8n

Work on branch `feat/demo`. Replaces the ARES rehearsal from `INTAKE.md` section 4 (keep the ARES notes as a fallback).
Follow `CLAUDE.md` conventions.

**Hard rule: no skill code, no n8n workflows, nothing the agent is supposed to build.** You prepare only data, texts,
infrastructure and a run-of-show. Anything the team pre-writes in place of the agent is "the one unforgivable fake".

## The story

The agent's ecosystem grows across fresh sessions:

1. **Session 1:** "Here is my bank statement and my issued invoices. Which ones are paid?" → the agent has no skill,
   asks a few questions, builds a payment-matching skill, answers.
2. **Session 2 (new):** "Who owes me more than 30 days? Prepare reminders." → the agent finds skill 1, builds a
   reminder-drafting skill on top of it, answers. Much cheaper than session 1.
3. **Session 3 (optional finale, "hands"):** "Send them." → the agent builds a skill that sends the reminders through
   n8n into a test inbox. Fallback finale without n8n: "Add the debtors' registered addresses from ARES."

Pitch line: bank data never leaves a sandbox without network.

## 1. Data – `demo/data/`

Realistic but fully synthetic (invented companies, IČO-like numbers are fine, no real people).

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
bank rows matched) and the expected debtor list for session 2. This is for us to check the agent's output and to answer
grill-me questions consistently. Never feed it to the agent.

## 2. Texts – `demo/`

- `tasks.md` – the exact prompts for sessions 1–3, phrased like a real user (Czech), never "build a tool/skill for X".
- `answers.md` – short prepared answers to the questions the agent will likely ask (matching rules, partial payments,
  overpayments, tolerance, reminder tone, language, signature, what "30 days" counts from). Keep answers consistent with
  `answer-key.md`.
- `run-of-show.md` – the demo minute by minute: what is on screen (agent pane, `logs/<skill>/latest.log`, `docker ps`
  loop, `registry.json`, GitHub issue), what we say, expected cost and duration per session, where to speed up the
  recording. Target: whole demo in under 3 minutes of the pitch, recording can be longer.

## 3. Infrastructure for the optional finale – `demo/infra/`

Timebox: 45 minutes. If it does not run reliably by then, drop it and use the ARES finale.

- `docker-compose.yml` with n8n and Mailpit (local test inbox with web UI). No real e-mail is ever sent.
- Configure n8n to send mail through Mailpit SMTP. Create an n8n API key with the narrowest scope available.
- `demo/infra/README.md`: how to start it, URLs, which env vars the agent's skill will need (`N8N_BASE_URL`,
  `N8N_API_KEY`), and how a container reaches it (`host.docker.internal` on Docker Desktop for both macOS and Windows).
- Do **not** create the reminder workflow in n8n – the agent must build it in session 3.

## 4. Dress rehearsal (after `feat/operator` is merged)

1. `npm run demo:reset -- --yes`, fresh Claude Code session in the repo root.
2. Run sessions 1 and 2 exactly by `tasks.md`, answer with `answers.md`.
3. Compare results against `answer-key.md`.
4. Record per session: duration, number of builder iterations, cost from the closed issue, anything that went wrong.
5. Write it into `demo/rehearsal-notes.md`, then reset again.

## Done when

- Data, texts and run-of-show are in `demo/`, `answer-key.md` checked by hand.
- n8n + Mailpit either work (with README) or are explicitly dropped in `run-of-show.md`.
- Dress rehearsal notes exist.
- PR `feat: demo case data and run-of-show` is open.
