---
name: payment-reminders
description: Creates Czech payment reminders (upomínky) for customers whose invoices are more than 30 days past due and unpaid or partly paid, from invoice-payment-check output (invoice-status.csv, to-check.csv). Writes one reminder per customer, overview.csv and manual-check.csv; customers with uncertain payments are held back.
---

# payment-reminders

## Usage

```
node scripts/run-skill.ts payment-reminders '{"invoiceStatus":"/input/invoice-status.csv","toCheck":"/input/to-check.csv","today":"2026-10-09","asOf":"2026-09-30"}' --mount out/payments/invoice-status.csv --mount out/payments/to-check.csv --output out/reminders
```

## Composes with

Reads `invoice-status.csv` and `to-check.csv` from the `invoice-payment-check` skill:

1. `node scripts/run-skill.ts invoice-payment-check '{"statement":"/input/bank-statement.csv","invoices":"/input/invoices.csv","statementEncoding":"windows-1250"}' --mount demo/data/bank-statement.csv --mount demo/data/invoices.csv --output out/payments`
2. the command above.

## Input (JSON)

- `invoiceStatus`, `toCheck` (required): file paths
- `today` (required): ISO `YYYY-MM-DD`
- `asOf` (optional): statement end date; adds note that later payments are not included
- `currency` (default `CZK`), `minDaysLate` (default 30, reminder only when strictly greater)
- `senderName`, `senderCompany`, `bankAccount`, `contact` (optional; placeholders otherwise)
- `encoding` (default `utf-8`)

## Output

Stdout: `{ today, customersToRemind, invoicesToRemind, totalMissing, currency, manualCheck, files }`.
Files in `/output`: `reminders/<customer-slug>.txt`, `overview.csv`, `manual-check.csv`.
Customers named in to-check.csv are held back completely (manual-check.csv, no reminder).
Error: `{ "error": "<message>" }`, exit 1 (bad/missing file or column, invalid date, bad minDaysLate).

## Examples

- today 2026-10-09 with demo data → `{"customersToRemind":2,"invoicesToRemind":4,"totalMissing":29000,"manualCheck":1,...}`
- `"today":"09.10.2026"` → `{"error":"today must be an ISO date YYYY-MM-DD"}`

## Network

Not needed.
