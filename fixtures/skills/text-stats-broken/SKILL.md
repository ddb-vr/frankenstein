---
name: text-stats-broken
description: Counts words and characters in a text. Internal fixture for the sandbox test runner; never installed.
---

# text-stats-broken

Input: `{ "text": string }` on stdin. Output: `{ "words": number, "chars": number }` on stdout.
Missing or non-string `text` → `{ "error": "..." }` and exit code 1.

```sh
echo '{"text":"hello world"}' | node scripts/main.ts
```
