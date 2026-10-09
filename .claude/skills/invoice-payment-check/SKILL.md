---
name: invoice-payment-check
description: Matches issued invoices (CSV) against a bank statement (CSV) and reports which invoices are paid, partly paid, overpaid or unpaid and overdue, even with a wrong variable symbol (VS) or part payments. Use for "which invoices are paid", unpaid/overdue invoices, párování plateb, kontrola úhrad faktur.
---

# invoice-payment-check

Matching per incoming payment, in order: variable symbol, invoice number in the message, customer name plus exactly equal amount. No guessing by amount alone. Part payments are summed; one payment covering several invoices of the same customer pays the oldest first. Uncertain cases (name matches, amount differs, no symbol) go to `to-check.csv` and are not counted as paid. Payments in another currency than the invoice stay unmatched. `asOf` is the last date in the statement; an invoice is overdue when not fully paid and due before `asOf`.

## Usage

```
node scripts/run-skill.ts invoice-payment-check '{"statement":"/input/bank-statement.csv","invoices":"/input/invoices.csv","statementEncoding":"windows-1250"}' --mount demo/data/bank-statement.csv --mount demo/data/invoices.csv --output out/payments
```

Input: `statement`, `invoices` (required paths), `statementEncoding`, `invoicesEncoding` (optional, default `utf-8`; Czech bank exports are usually `windows-1250`). Both files: separator `;`, decimal comma, dates `DD.MM.YYYY`. Statement columns: `Datum, Objem, Měna, Název protiúčtu, VS, Zpráva pro příjemce`. Invoice columns: `Číslo faktury, VS, Odběratel, Datum vystavení, Datum splatnosti, Částka, Měna`.

Output (stdout summary): `asOf, currency, invoices, paid, overpaid, partlyPaid, unpaid, overdue, totalOwed, overdueOwed, toCheck, unmatchedPayments, files`. With `/output` it writes `invoice-status.csv`, `to-check.csv`, `unmatched-payments.csv` (`;`, decimal comma, UTF-8 with BOM).

Error: `{ "error": "<message>" }`, exit 1 (missing/unreadable file, bad encoding, missing column, unparsable amount/date, empty statement).

## Example

Input `{"statement":"/input/bank-statement.csv","invoices":"/input/invoices.csv"}` gives
`{"asOf":"2026-08-28","currency":"CZK","invoices":8,"paid":4,"overpaid":1,"partlyPaid":1,"unpaid":2,"overdue":2,"totalOwed":21905,"overdueOwed":18880,"toCheck":1,"unmatchedPayments":2,"files":[...]}`.

Swapped files give `{"error":"statement: missing column(s) ..."}`.

## Network

Not needed.
