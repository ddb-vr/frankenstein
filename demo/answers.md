# Prepared answers

The agent asks in plain words with 2–4 options plus "Other" (or numbered questions with lettered options when the
question tool is unavailable). Pick the option that says the same as the answer below; if none does, choose "Other" and
type the short answer. Everything here is consistent with [answer-key.md](answer-key.md).

Our business: **Ateliér Lucerna s.r.o.**, IČO 26779226, account **2801234567/2010**, e-mail `fakturace@example.com`.

## Session 1 – payment matching

| Topic                                | Answer                                                                                                                                                                                                            |
|--------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Which bank rows count                | Only incoming payments (positive amount). Outgoing payments are never invoice payments, even with a matching variable symbol.                                                                                     |
| How to match a payment to an invoice | 1) Variable symbol equals the invoice's VS. 2) No match: an invoice number written in the message. 3) Still none: exact amount and the payer is the invoice's customer. If the agent proposes "invoice number in the message wins over the VS", accept: same result on our data. |
| Payment that matches nothing         | List it separately as "unmatched payment" with date, amount, payer and message. Do not guess.                                                                                                                     |
| Payment covering several invoices    | If the message names several invoices and the amount equals their sum, split it and mark all of them paid.                                                                                                        |
| Partial payments                     | Add up all payments for the invoice. Less than the invoice amount: "partially paid" with the amount still owed.                                                                                                   |
| Overpayments                         | Mark "overpaid" with the surplus. Do not move the surplus to another invoice.                                                                                                                                     |
| Tolerance                            | None: amounts must match to the haléř. Any difference is a partial payment or an overpayment.                                                                                                                     |
| Late payments                        | Paid late is still paid. Session 1 is only about paid / unpaid, not about due dates.                                                                                                                              |
| Currency                             | Everything is in CZK. A payment in another currency: report it as unmatched.                                                                                                                                      |
| Encoding / format                    | The bank export is the bank's usual CSV: windows-1250, `;`, decimal comma, dates `dd.mm.yyyy`. The invoice list is UTF-8 in the same style.                                                                       |
| Reference date                       | If asked: 9 October 2026.                                                                                                                                                                                         |
| What I want back                     | A short overview in the chat (how many paid / partially paid / unpaid / overpaid, total still owed, unmatched payments) and a table file with one row per invoice: status, paid, still owed, which bank payments. |
| File type                            | Excel-friendly CSV is fine; no `.xlsx` needed.                                                                                                                                                                    |
| Its list of matching rules           | Accept when it says: invoice number in the message beats the VS; a payment naming one invoice with a wrong amount goes to it (partly paid / overpaid); customer name alone never matches, the amount must be exact; a multi-invoice payment whose sum differs stays unmatched; equal amounts go to the earliest due date; non-CZK is unmatched. |
| Confirming the examples              | Confirm only if the examples follow the rules above (instalments add up, the outgoing payment is ignored, the overpayment shows the surplus). Otherwise say what is wrong.                                        |

## Session 2 – reminders

| Topic                                | Answer                                                                                                                                                                                                          |
|--------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| What "more than 30 days" counts from | From the invoice's due date to 9 October 2026; strictly more than 30 days (due 8 September 2026 or earlier).                                                                                                    |
| Which invoices                       | Unpaid and partially paid ones, with the amount still owed. Not overpaid or paid ones, and not invoices overdue 30 days or less.                                                                                |
| Where payments come from             | Use the payment-matching skill from last time: run it on the two files and draft the reminders from its per-invoice result; do not check the payments again in the new skill.                                |
| Several invoices for one customer    | One reminder per customer listing all their overdue invoices and the total.                                                                                                                                     |
| Partial payment in a reminder        | Say what was invoiced, what we received and when, and what is left.                                                                                                                                             |
| Our outgoing payment to a customer   | Ignore it; it does not reduce what they owe us.                                                                                                                                                                 |
| Tone                                 | Polite and friendly but clear: a first reminder. No threats, penalties or late interest.                                                                                                                        |
| Language                             | Czech, formal ("Vážení,"), because the customers are Czech companies.                                                                                                                                           |
| What to include                      | Invoice number, issue and due date, amount still owed, our account 2801234567/2010, the invoice's variable symbol, a request to pay within 7 days, and "if you have already paid, please ignore this reminder". |
| Signature                            | "S pozdravem / Ateliér Lucerna s.r.o. / fakturace@example.com"                                                                                                                                                  |
| Format                               | One draft per customer as a text file with the customer's e-mail and a subject line, plus a short list in the chat (customer, invoices, total).                                                                 |
| Order of the customers               | Largest amount owed first.                                                                                                                                                                                      |
| File names                           | Accept its recommendation (customer name without diacritics, with dashes).                                                                                                                                      |
| Send them?                           | No, only drafts. Nothing is sent anywhere.                                                                                                                                                                      |
| Confirming the examples              | Confirm only if a customer with two overdue invoices gets one reminder and an invoice overdue less than 30 days gets none.                                                                                      |

## If the agent asks to copy a file

Session 2 may need a result file from session 1 that lies in `out/`, which is not an allowed mount root by default. If
the agent asks you to copy it into `inputs/`, do so with the exact command it gives (e.g.
`cp out/<run>/<file> inputs/`) and reply "copied". See [run-of-show.md](run-of-show.md#before-recording) for the
preflight that avoids this.

## Permission prompts

Approve these when Claude Code asks; they are expected:

- `iconv … > work/<skill>/fixtures/input/<file>.csv`: the PRD agent turns its UTF-8 test file into windows-1250. macOS
  `iconv` has no `-o`; if it proposes `-o`, reply "use `iconv -f UTF-8 -t WINDOWS-1250 <source> > <target>`".
- `ls`, `find` or `cat` on `work/<skill>/` or `.claude/skills/<skill>/`: the builder looking at its own files.

Deny anything that reads `demo/data/` directly beyond the first few lines (that is the data the model must not see) or
writes outside `work/`, `out/` and `tracker/`.
