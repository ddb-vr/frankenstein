# daily-email-digest

## Goal

Every morning at 8:00 the user gets one e-mail listing the unread e-mails that arrived in their Gmail inbox in the
last 24 hours (sender and subject), or a short "nothing new" e-mail when there are none. The user can also run it any
time from the chat ("send me the digest now").

## Kind

n8n workflow (recurring, started by a schedule). First end-to-end pass of the n8n route: no AI, Gmail only.

## Trigger

- Schedule: daily at 08:00 (instance timezone).
- Run now: `node scripts/run-skill.ts daily-email-digest '{}'` through the `Webhook Trigger`.

## Live targets

- `digestTo` in `Set Config`: the user's own Gmail address (the same inbox the workflow reads).

## Nothing to process

Send the short "Daily digest: nothing new" e-mail.

## Apps to sign in to

- Gmail (read unread messages, send the digest). One OAuth credential, reused by the three Gmail nodes.

## Not in scope

Marking e-mails as read, filtering newsletters, AI summaries.
