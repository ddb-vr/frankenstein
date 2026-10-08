---
name: ico-validator
description: Validate Czech company IČO (ICO) numbers offline. Normalizes a list of supplier IČO values (strips spaces and CZ prefix, zero-pads to 8 digits) and checks the modulo-11 checksum. Use when a user wants to check, verify or clean IČO / company ID numbers.
---

# ico-validator

Usage: `node scripts/run-skill.ts ico-validator '<json>'` (or `--input-file <path>`).

Input: `{ "ico": ["27082440", "12345678"] }` (non-empty array of strings).

Output: `{ "results": [ { "ico": "27082440", "valid": true, "reason": "ok" } ] }`, one per item, same order.
`reason`: `ok`, `checksum`, `not_digits` (letters or empty), `too_long` (>8 digits). Invalid values are normal results.

Error (exit 1): `{ "error": "<message>" }` when `ico` is missing, not an array, empty, or the JSON is invalid.

Examples:
- `{"ico":["19"]}` → `{"results":[{"ico":"00000019","valid":true,"reason":"ok"}]}`
- `{"ico":["CZ2708A440"]}` → `{"results":[{"ico":"2708A440","valid":false,"reason":"not_digits"}]}`

Network: none (fully offline; no ARES lookup).
