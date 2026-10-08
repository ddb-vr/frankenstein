# ico-validator

## Goal

The user expects that at the end, given a list of supplier IČO values, they get for each one a normalized 8-digit IČO
and whether it is plausible (8 digits plus modulo-11 checksum), computed offline.

## Inputs

One JSON object on stdin:

```json
{ "ico": ["27082440", "12345678"] }
```

- `ico`: non-empty array of strings.

Normalization per item, in this order (user-confirmed):

1. Remove all whitespace.
2. Remove a leading `CZ` prefix (case-insensitive). User-confirmed.
3. If the result is non-empty, all digits and at most 8 long, left-pad with zeros to 8 digits.

## Outputs

User-confirmed shape:

```json
{ "results": [ { "ico": "27082440", "valid": true, "reason": "ok" } ] }
```

- One entry per input item, same order.
- `ico`: the normalized value (padded if digits-only and at most 8 long; otherwise the cleaned string after steps 1-2).
- `valid`: boolean.
- `reason` (user-confirmed codes): `ok`, `checksum` (8 digits, modulo-11 check fails), `not_digits` (contains non-digits
  or is empty), `too_long` (more than 8 digits).

Checksum: weights 8,7,6,5,4,3,2 on the first 7 digits, S = sum, r = S mod 11; check digit = 1 if r = 0, 0 if r = 1, else
11 - r. Valid when it equals the 8th digit.

## Edge cases

- Short values are zero-padded ("19" becomes "00000019", valid).
- Spaces inside a value are removed ("2708 2440").
- A leading "CZ" (case-insensitive) is stripped after whitespace removal, then the value is padded and validated
  (user-confirmed).
- Letters elsewhere give `not_digits`; more than 8 digits gives `too_long` (no truncation).
- An invalid value is a normal result, exit 0.

## Errors

Exit 1 with `{ "error": "<message>" }` only when the input is malformed: stdin not valid JSON, `ico` missing, `ico` not
an array, or `ico` an empty list.

## Network

Not needed. Fully offline; no ARES lookup, no existence check.

## Out of scope

Checking that the company exists (ARES), DIČ/VAT validation, names, other countries' IDs.

## Open points

- Non-string items inside the list (numbers, null): not confirmed. Suggested: treat as `not_digits` with `ico` as the
  string form; not covered by examples.
- Empty or whitespace-only string item: assumed `not_digits`, not covered by examples.
- The `error` value is a message string on stdout (per contract); `{ "error": true }` in examples marks "handled error".
