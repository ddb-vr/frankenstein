# Demo tasks

Paste each prompt verbatim into a **fresh** Claude Code session started in the repo root (`claude`). Session 2 starts
only after session 1 has installed its skill and answered. Answer the agent's questions from [answers.md](answers.md);
check the results against [answer-key.md](answer-key.md) (never show either file to the agent).

## Session 1 – which invoices are paid

```text
I exported my bank statement (demo/data/bank-statement.csv) and the list of invoices I issued
(demo/data/invoices.csv). Which of my invoices have been paid and which haven't? My customers don't always fill in
the variable symbol correctly, and some pay in parts.
```

Expected: no enabled skill covers it → questions → a payment-matching skill is built, reviewed and installed → the
per-invoice answer from [answer-key.md](answer-key.md#session-1--which-invoices-are-paid), with the result file in
`out/<run>/`.

## Session 2 – reminders for long-overdue invoices

```text
Today is 9 October 2026. Which customers have owed me money for more than 30 days? Please draft payment reminders I
can send them. The files are the same as before: demo/data/bank-statement.csv and demo/data/invoices.csv.
```

Expected: the agent finds the payment-matching skill from session 1 and uses it, builds only the reminder part on top
of it (fewer questions, lower cost than session 1), then answers with the 4 debtors from
[answer-key.md](answer-key.md#session-2--debtors-more-than-30-days-overdue-on-9-october-2026) and the reminder drafts
in `out/<run>/`.
