# PRD: orders-lapsed-customers

## Goal

The user expects that at the end they see which customers made no completed purchase in the last N days before a given date (here 60 days before 9. 10. 2026), with each customer's total spend, as a short summary plus an Excel-friendly CSV of all of them.

## Inputs

stdin JSON:

```json
{ "file": "/input/orders.csv", "reference_date": "2026-10-09", "days": 60, "encoding": "utf-8" }
```

- `file` (required): path to the orders CSV.
- `reference_date` (required): ISO date `YYYY-MM-DD`; NOT today's date.
- `days` (optional, default 60): positive integer window length.
- `encoding` (optional, default `utf-8`).

CSV format (detected from the user's `inputs/orders.csv`, UTF-8): separator `;`, header
`order_id;date;customer_email;customer_name;total_czk;status`, dates `dd.mm.yyyy`, amounts in CZK with a space
thousands separator and decimal comma (e.g. `1 250,00`), status `completed` or `cancelled`. E-mail is matched
case-insensitively (identifies the customer) and is output lower-cased. Name is taken from the first valid row of that
customer.

Rules:
- Only `completed` orders count, both for last purchase and total spend. Cancelled orders are ignored entirely.
- Window start = `reference_date` minus `days` days (10. 8. 2026 for 60 days). A customer is lapsed when their last
  completed purchase is before the window start (no completed order from 10. 8. to 9. 10. 2026 inclusive).
- Customers with only cancelled orders are left out.
- Total spend = sum of all the customer's completed orders (also those before the window).

## Outputs

stdout (compact summary):

```json
{
  "lapsed_customers": 3,
  "total_spend_czk": 4150.5,
  "orders_skipped": 3,
  "top_lapsed_customers": [
    { "name": "...", "email": "...", "last_purchase": "YYYY-MM-DD", "orders": 3, "total_czk": 3250.5 }
  ],
  "output_file": "lapsed-customers.csv"
}
```

`top_lapsed_customers` = max 5, highest spend first (ties: by e-mail ascending). `email` is lower-cased.
`last_purchase` in stdout is ISO `YYYY-MM-DD` (confirmed by the user). `total_spend_czk` = combined spend of all lapsed
customers. `output_file` is `null` when there are no lapsed customers.

File `/output/lapsed-customers.csv`: all lapsed customers, `;` separator, decimal comma, UTF-8 with BOM, header
`name;email;last_purchase;orders;total_czk`, e-mail lower-cased, last purchase as `dd.mm.yyyy` (confirmed by the user),
sorted by total spend descending (ties by e-mail ascending).

## Edge cases

- Boundary: last purchase on 9. 8. 2026 is lapsed; on 10. 8. 2026 is not (60 days).
- Same e-mail in different letter case is one customer; output e-mail is lower-cased.
- A cancelled order inside the window does not make the customer active.
- Rows with unreadable amount, date (incl. impossible dates) or missing e-mail are skipped and counted in `orders_skipped`.
- No lapsed customers: `lapsed_customers` 0, `total_spend_czk` 0, empty list, no file written.
- More than 5 lapsed customers: stdout lists only top 5, the file lists all.

## Errors

Exit 1 with `{ "error": "<message>" }` when: the file is missing or unreadable, the file is empty, a required column is
missing, the encoding is invalid, `reference_date` is missing or not a valid date, or `days` is not a positive integer.

## Network

Not needed.

## Out of scope

Contact with customers, other currencies, other statuses (refunds etc.), per-order detail, charts, reading today's date.

## Open points

- Orders dated after `reference_date` are not specified by the user; assumption: they are ignored (not tested).
- Tie ordering by e-mail is an assumption.
- Lower-casing of output e-mail is the author's decision (not asked).
