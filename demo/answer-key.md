Checked by: Vít Rozsíval

# Answer key – payment matching and reminders

For the team only: use it to check the agent's output and to answer its questions consistently. **Never give this file
or its content to the agent.**

Data: `demo/data/bank-statement.csv` (32 rows, 03.08.2026–07.10.2026, windows-1250) and `demo/data/invoices.csv` (18
invoices, UTF-8). All companies, IČO, accounts and e-mails are invented. The seller is the fictional **Ateliér Lucerna
s.r.o.** (IČO 26779226, account 2801234567/2010). Reference date for session 2: **9 October 2026**.

"Row N" is the N-th data row of the bank statement, not counting the header (file line N + 1).

## Session 1 – which invoices are paid

| Invoice     | Customer                        | Due        |    Amount |      Paid | Outstanding | Status         | Bank rows      | Trap                                         |
| ----------- | ------------------------------- | ---------- | --------: | --------: | ----------: | -------------- | -------------- | -------------------------------------------- |
| FV-2026-031 | Hotel Zlatá Jeřabina s.r.o.     | 03.08.2026 | 18 150,00 |      0,00 |   18 150,00 | unpaid         | –              |                                              |
| FV-2026-032 | Pekárna U Mlýna s.r.o.          | 05.08.2026 | 14 520,00 | 14 520,00 |        0,00 | paid           | 2              | same amount as FV-2026-044, VS decides       |
| FV-2026-033 | Truhlárna Dubový List s.r.o.    | 10.08.2026 | 24 200,00 | 24 200,00 |        0,00 | paid           | 4, 17          | two instalments (2nd one late)               |
| FV-2026-034 | Hotel Zlatá Jeřabina s.r.o.     | 12.08.2026 |  7 260,00 |      0,00 |    7 260,00 | unpaid         | –              |                                              |
| FV-2026-035 | Autoservis Rychlé Kolo s.r.o.   | 17.08.2026 | 31 460,00 | 15 000,00 |   16 460,00 | partially paid | 9              | partial payment, rest never came             |
| FV-2026-036 | Zahradnictví Na Výsluní s.r.o.  | 19.08.2026 |  6 655,00 |  6 655,00 |        0,00 | paid           | 12 (part)      | two invoices in one transfer                 |
| FV-2026-037 | Cukrárna Sladký Čtvereček s.r.o. | 21.08.2026 |  8 470,00 |  9 470,00 |   −1 000,00 | overpaid       | 8              | overpayment by 1 000,00                      |
| FV-2026-038 | Pivovar Žabí Louka s.r.o.       | 24.08.2026 | 12 705,00 |      0,00 |   12 705,00 | unpaid         | – (not 11)     | outgoing row 11 has the same VS              |
| FV-2026-039 | Zahradnictví Na Výsluní s.r.o.  | 26.08.2026 |  4 235,00 |  4 235,00 |        0,00 | paid           | 12 (part)      | two invoices in one transfer                 |
| FV-2026-040 | Knihkupectví Šedá Sova s.r.o.   | 28.08.2026 |  9 075,00 |      0,00 |    9 075,00 | unpaid         | –              |                                              |
| FV-2026-041 | Fitness Železná Kotva s.r.o.    | 02.09.2026 | 16 940,00 | 16 940,00 |        0,00 | paid           | 15             |                                              |
| FV-2026-042 | Elektro Světluška s.r.o.        | 07.09.2026 | 11 495,00 | 11 495,00 |        0,00 | paid           | 18             | wrong VS 2026024 (digits swapped)            |
| FV-2026-043 | Květinářství Pod Věží s.r.o.    | 11.09.2026 |  3 630,00 |  3 630,00 |        0,00 | paid           | 20             |                                              |
| FV-2026-044 | Pekárna U Mlýna s.r.o.          | 15.09.2026 | 14 520,00 | 14 520,00 |        0,00 | paid           | 22             | same amount as FV-2026-032, VS decides       |
| FV-2026-045 | Truhlárna Dubový List s.r.o.    | 18.09.2026 |  7 865,00 |  7 865,00 |        0,00 | paid           | 24             | no VS, invoice number in the message         |
| FV-2026-046 | Kavárna Modrá Hvězda s.r.o.     | 21.09.2026 |  5 445,00 |      0,00 |    5 445,00 | unpaid         | –              |                                              |
| FV-2026-047 | Fitness Železná Kotva s.r.o.    | 25.09.2026 |  9 680,00 |      0,00 |    9 680,00 | unpaid         | –              |                                              |
| FV-2026-048 | Cukrárna Sladký Čtvereček s.r.o. | 29.09.2026 |  6 050,00 |  6 050,00 |        0,00 | paid           | 28             | no deduction of the earlier overpayment      |

Totals: 10 paid, 1 overpaid, 1 partially paid, 6 unpaid. Outstanding 78 775,00 CZK over 7 invoices; overpaid
1 000,00 CZK (FV-2026-037).

### The traps, row by row

- **Partial payment (two payments for one invoice):** FV-2026-033 (24 200,00) = row 4 (06.08., 12 100,00,
  "1. splátka") + row 17 (03.09., 12 100,00, "2. splátka"), both VS 2026033 → paid. FV-2026-035 (31 460,00) has only
  row 9 (20.08., 15 000,00, VS 2026035, "Částečná úhrada") → partially paid, 16 460,00 outstanding.
- **Overpayment:** FV-2026-037 (8 470,00) ← row 8 (19.08., 9 470,00, VS 2026037) → overpaid by 1 000,00. The same
  customer pays FV-2026-048 in full later (row 28); the surplus is not carried over.
- **Missing VS:** row 24 (16.09., 7 865,00, VS empty, message "Úhrada faktury FV-2026-045") → FV-2026-045 by the
  invoice number in the message; amount and customer confirm it.
- **Wrong VS:** row 18 (04.09., 11 495,00, VS 2026024) – no such invoice. Same amount and payer as FV-2026-042 (VS
  2026042, digits 4 and 2 swapped) → paid.
- **Payment with no invoice:** row 26 (22.09., 3 500,00, Spolek Zelený Ostrůvek z.s., VS 2026099, "Příspěvek na
  workshop") → unmatched incoming payment; VS 2026099 looks like ours but no invoice has it.
- **Two invoices in one transfer:** row 12 (25.08., 10 890,00, VS 2026036, "FV-2026-036 + FV-2026-039") = 6 655,00 +
  4 235,00 → both paid.
- **Outgoing payment to ignore:** row 11 (24.08., −5 808,00, to Pivovar Žabí Louka s.r.o., VS 2026038) is our
  payment to them, not theirs to us. FV-2026-038 stays unpaid. A matcher that ignores the sign gets this wrong.

### Bank rows not matched to any invoice

- Incoming: row 26 only (3 500,00).
- Outgoing, all ignored: rows 1, 3, 5, 6, 7, 10, 11, 13, 14, 16, 19, 21, 23, 25, 27, 29, 30, 31, 32 (19 rows: rent,
  card payments, accountant, phone, hosting, VAT, bank fees, printing, and the row 11 trap).

## Session 2 – debtors more than 30 days overdue on 9 October 2026

Days overdue count from the due date. Strictly more than 30 days: due date 08.09.2026 or earlier.

| Customer                      | E-mail                            | Invoices                                    | Days overdue | Outstanding |
| ----------------------------- | --------------------------------- | ------------------------------------------- | -----------: | ----------: |
| Hotel Zlatá Jeřabina s.r.o.   | recepce.zlatajerabina@example.com | FV-2026-031 (18 150,00), FV-2026-034 (7 260,00) |       67, 58 |   25 410,00 |
| Autoservis Rychlé Kolo s.r.o. | autoservis.rychlekolo@example.com | FV-2026-035 (16 460,00 of 31 460,00)        |           53 |   16 460,00 |
| Pivovar Žabí Louka s.r.o.     | pivovar.zabilouka@example.com     | FV-2026-038 (12 705,00)                     |           46 |   12 705,00 |
| Knihkupectví Šedá Sova s.r.o. | knihkupectvi.sedasova@example.com | FV-2026-040 (9 075,00)                      |           42 |    9 075,00 |

4 reminders (one per customer), 5 invoices, 63 650,00 CZK in total.

Must **not** get a reminder:

- FV-2026-046 Kavárna Modrá Hvězda (due 21.09., 18 days) and FV-2026-047 Fitness Železná Kotva (due 25.09., 14 days):
  overdue, but less than 30 days.
- Cukrárna Sladký Čtvereček: overpaid, owes nothing.
- Pivovar Žabí Louka gets a reminder for the full 12 705,00: our outgoing 5 808,00 to them (row 11) is not a payment
  of FV-2026-038 and is not offset.

The Autoservis reminder states the partial payment: invoiced 31 460,00, received 15 000,00 on 20.08.2026, remaining
16 460,00. Each reminder gives our account 2801234567/2010 and the invoice VS.
