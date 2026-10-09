---
name: daily-email-digest
description: Sends the user a daily e-mail listing the unread Gmail messages of the last 24 hours (sender and subject), every morning at 08:00 and on demand. Use when the user asks for their e-mail digest now or wants to know what the daily digest does.
---

# daily-email-digest

An n8n workflow (`Daily Email Digest`). It runs by itself every morning at 08:00; the user can also run it now.

## Usage

```
node scripts/run-skill.ts daily-email-digest '{}'
```

Input: an empty object. Output: the execution summary (`status`, `lastNode`, per-node item counts, `url`). In live
mode the digest goes to `digestTo` (the user's inbox); in test mode a `[TEST]` preview goes to the test address.

## Where to look

- The workflow and its runs: the `url` in the output, or the `frankenstein` tag in n8n.
- Errors: reported by the instance's `Error Handler` to the test address.
- Switch off: unpublish the workflow in n8n, or ask here.
