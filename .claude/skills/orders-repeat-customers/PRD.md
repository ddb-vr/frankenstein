# orders-repeat-customers

## Goal

The user expects that at the end they know which customers ordered more than once (an Excel-friendly list plus the top 5 in the answer) and the average order value over all counted orders, with cancelled orders excluded but their count reported.

## Inputs

stdin JSON:

```json
{ "file": "/input/orders.csv", "encoding": "utf-8" }
```

- `file` (required): path of the orders export (`/input/<basename>` at runtime).
- `encoding` (optional, default `utf-8`): text encoding. The user's file was detected as UTF-8.

File format: CSV, separator `;`, header `order_id;date;customer_email;customer_name;total_czk;status`, date `DD.MM.YYYY`, amounts like `1 250,00` (space thousands separator, decimal comma), `status` is `completed` or `cancelled`. Currency is always CZK.

## Outputs

stdout (compact summary):

```json
{
  "orders_counted": 7,
  "orders_cancelled": 2,
  "orders_skipped": 2,
  "customers": 4,
  "repeat_customers": 2,
  "average_order_value_czk": 871.43,
  "top_repeat_customers": [{ "name": "", "email": "", "orders": 3, "total_czk": 4500 }],
  "output_file": "repeat-customers.csv"
}
```

- `orders_counted`: non-cancelled orders with valid e-mail and amount.
- `orders_cancelled`: rows with status `cancelled` (not counted anywhere else).
- `orders_skipped`: non-cancelled rows with unreadable amount or missing e-mail.
- `customers`: distinct customers (e-mail, case-insensitive, trimmed) among counted orders.
- `repeat_customers`: customers with 2 or more counted orders.
- `average_order_value_czk`: sum of counted orders / `orders_counted`, rounded to 2 decimals.
- `top_repeat_customers`: up to 5 repeat customers sorted by orders descending; on equal orders the customer with the higher total CZK comes first; e-mail A-Z is the last tie-breaker (rule confirmed by the user). `email` is lower-case, `name` is the first name seen for that e-mail, `total_czk` is a number rounded to 2 decimals.
- `output_file`: always `repeat-customers.csv` (fixed name, a design decision).

File `/output/repeat-customers.csv` (always written): all repeat customers (same sort order), columns `name;email;orders;total_czk`, separator `;`, decimal comma, UTF-8 with BOM so Excel opens it correctly. When there are no repeat customers the file contains only the header.

## Edge cases

- E-mails differing only in case or surrounding spaces are the same customer.
- Cancelled rows are counted in `orders_cancelled` only; they do not affect customers, totals or the average, even if their e-mail or amount is bad.
- A customer with one completed and one cancelled order is not a repeat customer.
- Rows with unreadable amount or missing e-mail (and not cancelled) are skipped and counted in `orders_skipped`.
- More than 5 repeat customers: summary shows 5, the file has all.
- Equal number of orders: higher total CZK first, then e-mail A-Z.
- No repeat customers: empty `top_repeat_customers`, file with header only.
- Blank lines in the file are ignored.

## Errors

Exit 1 with `{ "error": "<message>" }` when: `file` is missing or the file cannot be read; the file is empty (no header); a required column is missing (`customer_email`, `customer_name`, `total_czk`, `status`); `encoding` is unsupported.

## Network

Not needed.

## Out of scope

Other currencies, filtering by date, merging customers with different e-mails, refunds, charts, modifying the input file.

## Open points

- Not confirmed: behavior when all orders are cancelled or no valid order exists (assumed `average_order_value_czk: null`, no example written).
- Not confirmed: the name shown for a customer who used different names (assumed first seen).
- Unknown status values other than `completed`/`cancelled` are assumed to count as normal orders.
