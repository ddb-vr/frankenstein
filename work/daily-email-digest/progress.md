# progress

## 2026-10-09 – draft

- Drafted `workflow.json` by hand as the first pass of the n8n route (no builder agent yet).
- Node facts taken from the node sources, not memory:
  - Gmail v2 `MessageDescription.ts` (`getAll`: `returnAll`, `limit`, `simple`, `filters.readStatus`,
    `filters.receivedAfter`; `send`: `sendTo`, `subject`, `emailType`, `message`, `options.appendAttribution`):
    https://raw.githubusercontent.com/n8n-io/n8n/master/packages/nodes-base/nodes/Google/Gmail/v2/MessageDescription.ts
  - Gmail node versions `[2, 2.1, 2.2]`, credential `gmailOAuth2`:
    https://raw.githubusercontent.com/n8n-io/n8n/master/packages/nodes-base/nodes/Google/Gmail/v2/GmailV2.node.ts
  - Webhook `authentication: headerAuth` → credential `httpHeaderAuth`, versions up to 2.2:
    https://raw.githubusercontent.com/n8n-io/n8n/master/packages/nodes-base/nodes/Webhook/description.ts
  - Schedule Trigger `rule.interval[]` with `field: days`, `daysInterval`, `triggerAtHour`, `triggerAtMinute`:
    https://raw.githubusercontent.com/n8n-io/n8n/master/packages/nodes-base/nodes/Schedule/ScheduleTrigger.node.ts
  - Aggregate `aggregate: aggregateAllItemData`, output under `data`:
    https://raw.githubusercontent.com/n8n-io/n8n/master/packages/nodes-base/nodes/Transform/Aggregate/Aggregate.node.ts
  - If filter operators (`exists` is type-independent; string `equals`):
    https://raw.githubusercontent.com/n8n-io/n8n/master/packages/workflow/src/node-parameters/filter-parameter.ts
- Open: `digestTo` in `Set Config` is empty until the user gives the address (same as the test address).
- Next: `instance init`, `creds`, `push`, `test`.
