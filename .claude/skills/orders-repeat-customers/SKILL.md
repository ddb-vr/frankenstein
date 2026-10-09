---
name: orders-repeat-customers
description: Finds repeat customers (ordered more than once) in a CSV orders export (separator ;, CZK amounts like "1 250,00", status completed/cancelled), reports the top 5, the average order value and the number of cancelled orders, and writes an Excel-friendly repeat-customers.csv. Use for "opakovaní zákazníci", repeat buyers, returning customers, order export analysis.
---

# orders-repeat-customers

Input JSON: `{ "file": "/input/orders.csv", "encoding": "utf-8" }` (`encoding` optional).
CSV columns: `order_id;date;customer_email;customer_name;total_czk;status`.
Cancelled orders are excluded (only counted). Rows with bad amount or missing e-mail are skipped.

Output (stdout): `orders_counted`, `orders_cancelled`, `orders_skipped`, `customers`, `repeat_customers`,
`average_order_value_czk` (null if no valid order), `top_repeat_customers` (max 5), `output_file`.
File `repeat-customers.csv` (all repeat customers, `;`, decimal comma, UTF-8 BOM) is written to `/output` when it
exists.
Errors: `{ "error": "<message>" }`, exit 1 (missing/unreadable file, empty file, missing column, bad encoding).

Example:

```
node scripts/run-skill.ts orders-repeat-customers '{"file":"/input/orders.csv"}' --mount demo/data/orders.csv --output out/orders
```

→
`{"orders_counted":7,"orders_cancelled":2,"orders_skipped":2,"customers":4,"repeat_customers":2,"average_order_value_czk":871.43,"top_repeat_customers":[...],"output_file":"repeat-customers.csv"}`

Bad input: `{"file":"/input/missing.csv"}` → `{"error":"Cannot read file: /input/missing.csv"}`

Network: not needed.
