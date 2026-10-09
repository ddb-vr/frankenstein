---
name: orders-lapsed-customers
description: Finds lapsed (inactive, churned) customers in a CSV orders export, i.e. customers with no completed purchase in the last N days before a reference date, with their total spend; writes an Excel-friendly lapsed-customers.csv. Use for "zákazníci, kteří dlouho nenakoupili", lapsed buyers, win-back lists, order export analysis.
---

# orders-lapsed-customers

Input JSON: `{ "file": "/input/orders.csv", "reference_date": "2026-10-09", "days": 60, "encoding": "utf-8" }`
(`days` default 60, `encoding` default utf-8; `reference_date` is required, YYYY-MM-DD).
CSV: `order_id;date;customer_email;customer_name;total_czk;status`, dates `dd.mm.yyyy`, amounts like `1 250,00`.
Only `completed` orders count; cancelled are ignored. Lapsed = last completed purchase before reference_date minus days.
Rows with bad amount/date or missing e-mail are skipped (`orders_skipped`). Orders after reference_date are ignored.

Output (stdout): `lapsed_customers`, `total_spend_czk`, `orders_skipped`, `top_lapsed_customers` (max 5, by spend desc;
`name,email,last_purchase` ISO,`orders,total_czk`), `output_file` (null if none lapsed).
File `lapsed-customers.csv` (all lapsed, `;`, decimal comma, dd.mm.yyyy, UTF-8 BOM) goes to `/output` when it exists.
Errors: `{ "error": "<message>" }`, exit 1 (bad file, empty, missing column, bad encoding, bad reference_date/days).

Example:

```
node scripts/run-skill.ts orders-lapsed-customers '{"file":"/input/orders.csv","reference_date":"2026-10-09","days":60}' --mount demo/data/orders.csv --output out/lapsed
```

→ `{"lapsed_customers":3,"total_spend_czk":4150.5,"orders_skipped":3,"top_lapsed_customers":[...],"output_file":"lapsed-customers.csv"}`

Bad input: `{"file":"/input/x.csv","reference_date":"2026-13-45"}` → `{"error":"reference_date is required and must be a valid YYYY-MM-DD date."}`

Network: not needed.
