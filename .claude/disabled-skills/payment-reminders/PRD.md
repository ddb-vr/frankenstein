# payment-reminders

## Goal

The user expects that at the end, given invoice-payment-check's invoice-status.csv and to-check.csv and a date today, the skill reports on stdout how many customers and invoices are more than minDaysLate (default 30) days past due and still unpaid or partly paid, the total missing amount, and how many customers are held back for manual check, and writes one Czech reminder per reminded customer, overview.csv and manual-check.csv to /output.

## Composes with

Composes with: invoice-payment-check

The skill reads two upstream output files: `invoice-status.csv` (main input) and `to-check.csv` (uncertain payments).

Chain:

1. `node scripts/run-skill.ts invoice-payment-check '{"statement":"/input/bank-statement.csv","invoices":"/input/invoices.csv","statementEncoding":"windows-1250"}' --mount demo/data/bank-statement.csv --mount demo/data/invoices.csv --output out/payments`
2. `node scripts/run-skill.ts payment-reminders '{"invoiceStatus":"/input/invoice-status.csv","toCheck":"/input/to-check.csv","today":"2026-10-09"}' --mount out/payments/invoice-status.csv --mount out/payments/to-check.csv --output out/reminders`

## Inputs

stdin JSON:

- `invoiceStatus` (required): path to upstream `invoice-status.csv`
- `toCheck` (required): path to upstream `to-check.csv`
- `today` (required): ISO date `YYYY-MM-DD`; days late are counted from this date, not from the statement end
- `asOf` (optional): ISO date of the statement end (upstream `asOf`); when given, reminders say that payments received after that date are not included
- `currency` (optional, default `CZK`): invoice-status.csv has no currency column
- `senderName`, `senderCompany`, `bankAccount`, `contact` (optional): for the signature and payment details; when absent the reminder contains placeholders such as `[Vaše jméno]`, `[číslo účtu]`, `[kontakt]`
- `minDaysLate` (optional, default 30): reminder only when days late is strictly greater
- `encoding` (optional, default `utf-8`): encoding of both files

File format (both): UTF-8 with BOM, separator `;`, decimal comma, dates `DD.MM.YYYY`.

`invoice-status.csv` columns: `Číslo faktury;Odběratel;Datum splatnosti;Částka;Stav;Po splatnosti;Zaplaceno;Chybí / přeplatek;Spárované platby`. `Stav` is one of `paid`, `partly_paid`, `unpaid`, `overpaid`.

`to-check.csv` columns: `Datum;Částka;Měna;Plátce;VS;Zpráva;Důvod;Kandidátní faktura`.

## Outputs

stdout summary:

```json
{
  "today": "2026-10-09",
  "customersToRemind": 2,
  "invoicesToRemind": 4,
  "totalMissing": 29000,
  "currency": "CZK",
  "manualCheck": 1,
  "files": ["reminders/alfa-stavby-s-r-o.txt", "reminders/beta-dilna-s-r-o.txt", "overview.csv", "manual-check.csv"]
}
```

Files in `/output`:

- `reminders/<customer-slug>.txt`: one Czech, polite reminder per customer, listing all their late invoices (number, due date, days late, missing amount), total of the missing amount, request to pay only the missing amount, bank account and signature (or placeholders), and the note about payments after `asOf` when given.
- `overview.csv`: customer; number of invoices; amount missing; days late (the oldest invoice); sorted by days late descending. UTF-8 with BOM, `;`, decimal comma.
- `manual-check.csv`: customers with an uncertain payment (customer, candidate invoice, payment date, amount, reason). No reminder is written for them.

## Edge cases

- Late = status `unpaid` or `partly_paid` and `today` minus due date strictly greater than 30 days (exactly 30 is not late enough).
- Only the missing amount (`Chybí / přeplatek`) is requested; part payments are not charged again.
- Several late invoices of one customer: one reminder, all invoices listed, days late in the overview = oldest invoice.
- `paid` and `overpaid` invoices never produce a reminder.
- A customer named as candidate in to-check.csv is held back completely: no reminder for any of their invoices, listed once in manual-check.csv.
- Invoice not yet late (e.g. 10 days) gets no reminder.
- No late invoices: summary with zeros, only `overview.csv` header and `manual-check.csv` written, no reminder files.
- Customer name to file name: lowercase, diacritics removed, non-alphanumerics replaced by `-`.

## Errors

Exit 1 with `{ "error" }` when: `invoiceStatus` or `toCheck` is missing, unreadable or lacks a required column; `today` or `asOf` is missing or not a valid ISO date; an amount or date in the files cannot be parsed; `minDaysLate` is negative or not a number.

## Network

Not needed.

## Out of scope

- Re-implementing invoice-payment-check's capability (matching invoices to bank statement payments, deciding paid/unpaid).
- Sending e-mails, interest on late payment, reminders in languages other than Czech, escalation levels.

## Open points

- The user did not confirm what happens to a customer who has both a to-check payment and another clearly late invoice; this PRD holds the whole customer back for manual check (examples avoid this case).
- `asOf` is not in the upstream CSV files, so it is an optional input; the user must pass the statement end date (2026-09-30 for the demo data) to get the note.
- Currency defaults to CZK because upstream status file has no currency.
- Exact wording of the reminder text is not fixed by examples (checked only by key facts).
