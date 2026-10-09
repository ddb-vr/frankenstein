# invoice-payment-check

## Goal

The user expects that at the end they see which of their issued invoices are paid, partly paid, overpaid or unpaid (and overdue), matched against their bank statement even when the variable symbol is wrong or payments come in parts.

## Inputs

stdin JSON:

```json
{
  "statement": "/input/bank-statement.csv",
  "invoices": "/input/invoices.csv",
  "statementEncoding": "utf-8",
  "invoicesEncoding": "utf-8"
}
```

- `statement`, `invoices`: required paths. Encodings optional, default `utf-8`.
- Bank statement format (detected in `demo/data/bank-statement.csv`): encoding **windows-1250** (the real call must pass `"statementEncoding": "windows-1250"`), separator `;`, decimal comma, dates `DD.MM.YYYY`. Header: `Datum;Objem;Měna;Protiúčet;Kód banky;Název protiúčtu;VS;KS;SS;Zpráva pro příjemce;Typ`. Negative `Objem` = outgoing. `Typ` values seen: `Trvalý příkaz`, `Bezhotovostní příjem`, `Platba kartou`.
- Invoices format (detected in `demo/data/invoices.csv`): encoding UTF-8, separator `;`, decimal comma, dates `DD.MM.YYYY`. Header: `Číslo faktury;VS;Odběratel;IČO;E-mail;Datum vystavení;Datum splatnosti;Částka;Měna`.

## Outputs

stdout (compact summary):

```json
{
  "asOf": "2026-08-28",
  "currency": "CZK",
  "invoices": 8,
  "paid": 4,
  "overpaid": 1,
  "partlyPaid": 1,
  "unpaid": 2,
  "overdue": 2,
  "totalOwed": 21905,
  "overdueOwed": 18880,
  "toCheck": 1,
  "unmatchedPayments": 2,
  "files": ["invoice-status.csv", "to-check.csv", "unmatched-payments.csv"]
}
```

- `paid` = fully paid exactly; `overpaid` counted separately; `partlyPaid` = paid something but less than the amount; `unpaid` = nothing matched. `overdue` = invoices not fully paid whose due date is before `asOf`. `totalOwed` = sum of missing amounts; `overdueOwed` = the overdue part of it. Amounts are numbers.
- Files in `/output` (CSV, `;` separator, decimal comma, UTF-8 with BOM):
  - `invoice-status.csv`: one row per invoice: invoice number, customer, due date, amount, status (`paid`/`partly_paid`/`unpaid`/`overpaid`), overdue (yes/no), amount paid, amount missing (or surplus), matched payments (date, amount, matching method).
  - `to-check.csv`: uncertain payments with the reason and the candidate invoice. These are not counted as paid.
  - `unmatched-payments.csv`: incoming payments matching no invoice, with reason (including payments in a different currency than the invoice).

## Matching rules (confirmed by the user)

Only incoming payments are considered; outgoing, card and fee rows are ignored. Per payment, in this order:
1. Variable symbol equals an invoice VS.
2. Invoice number (e.g. `FV-2026-032`) found in the payment message.
3. Customer name equals the payer name plus exactly equal amount to an open invoice.
No guessing by amount alone. Payments matched to the same invoice are summed (part payments); the missing amount is invoice amount minus the sum. When one payment clearly covers several invoices of the same customer, the oldest invoice is paid first. Uncertain cases (e.g. name matches but the amount differs and there is no symbol or message) go to `to-check.csv`. An invoice is overdue when its due date is before the last date in the bank statement. A payment in a currency other than the invoice currency stays unmatched. An overpayment is status `overpaid` with the surplus.

## Edge cases

- Wrong VS but invoice number in the message: matched by message.
- Empty VS and empty message but same customer name and exact amount: matched by name+amount.
- Two payments with the same VS: summed, status partly paid with the missing amount.
- Payment bigger than the invoice: `overpaid` with the surplus.
- Same-name payer with a different amount and no symbol: `to-check`, invoice stays unpaid.
- Unknown payer or unknown VS: `unmatched-payments.csv`.
- Payment in a currency other than the invoice currency: not matched, listed as unmatched.
- Outgoing, card and fee rows are ignored.
- Czech number format (`18150,00`), possible thousands spaces, quoted fields.
- `asOf` = last date in the bank statement (among all rows).

## Errors

Exit 1 with `{ "error": "<message>" }` when: `statement` or `invoices` missing or not a string; a file does not exist or cannot be read; an unsupported encoding; a required column is missing in either file (including swapped files); an amount or date cannot be parsed; the statement has no rows.

## Network

Not needed

## Out of scope

- Sending reminders or e-mails, creating invoices, changing the files.
- Exchange-rate conversion of foreign currency payments.
- Matching outgoing payments (supplier invoices).

## Open points

- The "oldest invoice first" rule for one payment covering several invoices is not covered by an example (no confirmed values); it is left for the builder's unit tests.
- Multiple currencies on invoices: summary `currency` assumes a single invoice currency.
- Output file names and column layout are my proposal.
- No windows-1250 fixture: the writing tool produces UTF-8 only, so decoding of the real statement is covered by the builder's byte-level unit tests.
