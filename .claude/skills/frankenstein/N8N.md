# Frankenstein – n8n workflows

Rules for the n8n route of the lifecycle. An n8n skill is a normal skill in `registry.json` whose work runs as a
workflow in n8n: the user runs it from the chat like any other skill, and when the task is an automation the workflow
also starts by itself (schedule, new e-mail, webhook). Everything inside n8n (workflow names, node names, notes) is
English. Everything shown to the user is in the user's language, in plain words.

## When to pick n8n

Pick an n8n workflow instead of sandbox code when the task is **recurring and started by something outside the
chat**: a schedule, a new e-mail, a new file, a form, a webhook from another app (for example a meeting recorder), or
when the work is mostly talking to apps the user is signed in to (Gmail, Slack, Asana, Google Sheets, …). A one-off
transformation of data the user hands over stays a sandbox skill. If an existing app already does the job, say so first
and build only the missing glue.

## Source of truth

Same intake as a sandbox skill (`SKILL.md`, Intake steps 1–6), with these extra points for the `prd` agent to cover:

- What starts it (trigger) and how often; "run it now" from the chat is always available.
- Who receives the result in real life (people, channels, projects) – these are **live targets**.
- What should happen when there is nothing to process (no new e-mails, no action items): do nothing, or send a short
  "nothing today" message.
- Which apps it needs to sign in to.

`work/<skill>/` holds `PRD.md`, `examples.json`, `workflow.json` (the local source; the builder edits only this),
`progress.md`, and, written by the script, `n8n.json` (IDs) and `approval.json`. `examples.json` keeps the usual
envelope (`skill`, `entry: "scripts/main.ts"` so the lock accepts it, `examples`). An example's `input` is the body the
`Webhook Trigger` receives; `expected` is a **list of checks** on node output, each `{ "node", "path"?, "equals" }`,
`{ "node", "path"?, "contains" }` or `{ "node", "ran": false }`. `path` points into the node's output items: `length`
is the item count, `0.Subject` the first item's field. Checks on AI output test structure and facts (count, owner, due
date), never exact wording.

## Steps

Talk to n8n only through `node scripts/n8n.ts <command>`. It reads `N8N_BASE_URL`, `N8N_API_KEY` and
`N8N_WEBHOOK_SECRET` from `.env`; you never read `.env` and never call the n8n API directly. Every command prints one
JSON line; on an error it prints `{ "error": … }` and exits 1. Follow the error, do not retry blindly.

1. **First n8n build on this instance only** – `n8n/instance.json` does not exist yet (`instance check` says so). Ask
   the user where test e-mails and error reports should go ("Usually your own inbox."), then
   `node scripts/n8n.ts instance init --test-email <address>` (add `--mail outlook` or `--mail smtp` for a
   self-hosted instance without Gmail). It creates the webhook credential, the mail credential and the `Error Handler`
   workflow and writes `n8n/instance.json`. Send the user the `signIn` link it prints: "Open this link and click *Sign
   in with Google*, then come back." Then `node scripts/n8n.ts instance check` until `ok` is true.
2. **Draft** `work/<skill>/workflow.json` from the PRD, following every rule below. Before using a node type for the
   first time, and whenever a push or test fails on it, read the docs (see [Node facts](#node-facts)).
3. **Sign in** – `node scripts/n8n.ts creds <skill>` creates every credential the nodes need (one per app, reused
   when one of that type exists), writes the IDs into `workflow.json` and prints one `signIn` link per new credential.
   Tell the user: "Open this link, click *Sign in* (or paste the API key the app gave you) and save." Then
   `node scripts/n8n.ts creds <skill> --check` until `ok` is true. Nothing is tested before this passes.
4. **Push** – `node scripts/n8n.ts push <skill>` fills in the instance values (error workflow, test address, webhook
   path and credential), checks the workflow against the rules and refuses on any problem; otherwise it uploads the
   workflow, tags it `frankenstein`, publishes it **in test mode** and reads it back. A non-empty `dropped` list means
   n8n silently discarded a parameter: the key or `typeVersion` is wrong, look it up.
5. **Test** – `node scripts/n8n.ts test <skill>` runs every example through the `Webhook Trigger` and checks
   `expected` against the execution data; every executed node must succeed. On a failure fix `workflow.json`, note it
   in `progress.md`, and go back to step 4. Test runs send previews to the test address only.
6. **Review** – the `skill-reviewer` reads `workflow.json`, the test output and the PRD, as for any skill.
7. **Go live** – show the user the test results and the `liveTargets` list (from `approve`, see below) in plain words,
   and ask "Turn it on for real?" with *Yes, go live* and *Not yet*. Only on *Yes*:
   `node scripts/n8n.ts approve <skill>` then `node scripts/n8n.ts go-live <skill>`. Go-live switches `Set Config` to
   live, enables the real trigger, re-publishes, installs the skill (`.claude/skills/<skill>/` and `registry.json`
   with the workflow ID, no bot commit) and runs the workflow once; show the user that first run. Any later change to
   `workflow.json` breaks the approval hash: push again (back to test mode), test, and ask again.
8. **Run** – `node scripts/run-skill.ts <skill> '<json>'` works as for any skill: it calls the workflow's webhook from
   the host, waits for the execution (2 minutes at most) and prints the summary with the execution link. Tell the user
   what happened in plain words; on a timeout give them the link.

## Safety: test mode until the user approves

Nothing reaches a real person, channel or record before `go-live`. These are the rules `push` checks
(`scripts/lib/n8n-rules.ts`):

1. The first node after the triggers is an Edit Fields node named exactly **`Set Config`** with the fields `mode`
   (`test`; only go-live writes `live`) and `testEmail` (filled by push), plus one field per live target
   (`digestTo`, `slackChannel`, …) so the targets are visible in one place. Every trigger connects only to
   `Set Config`.
2. Every node that **writes outside n8n** (sends a message, creates or updates a record, posts to an API) sits on the
   **true** branch of an If node named **`Is Live?`** (`Is Live For Slack?` etc. when you need several) that compares
   `{{ $('Set Config').first().json.mode }}` with `live`. The **false** branch goes to a node named
   **`Send Test Preview`** (`Send Test Preview Of Slack Post` etc.): an e-mail to
   `{{ $('Set Config').first().json.testEmail }}` saying what would have been sent where, with the full content.
   Subject: `[TEST] <what> → <where>`.
3. A write that reaches no person and no shared record (for example starting a scraper run whose result the workflow
   reads back) may run in test mode: put `frankenstein: safe in test – <reason>` in the node's notes.
4. The real trigger (schedule, app trigger) stays `disabled: true` until go-live; the `Webhook Trigger` is never
   disabled.
5. No delete or overwrite of existing data unless the PRD asks for it.
6. No secrets in node parameters (keys, tokens, `Bearer …`): every app goes through a credential.
7. Code nodes run inside n8n, outside our sandbox: no `fetch`, `require`, `import`, `$env`, `process`; no network.
   They only transform the items they get.

## Error handling

**Global error workflow.** One `Error Handler` workflow per n8n instance (created by `instance init`, ID in
`n8n/instance.json`): `Error Trigger` → `Send Error Notification`. The message names the workflow, the failed node
(`execution.lastNodeExecuted`), the error and the execution link; when the trigger itself failed the data is under
`trigger` and there is no link. It never runs for manual executions, only automatic ones (webhook, schedule, app
trigger), which is why tests go through the webhook. `push` sets `settings.errorWorkflow` on every workflow; never
build error branches that duplicate this inside the main workflow.

**Node settings.** Decide per node and record unusual choices in `progress.md`:

| Node kind                                               | Retry                                                        | On error                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Reads: get, get many, search, HTTP GET, AI calls        | `retryOnFail: true`, `maxTries: 3`, `waitBetweenTries: 5000` | `stopWorkflow`                                                                                                              |
| Writes (send, create, post, HTTP POST)                  | `retryOnFail: false` – a retry can send or create twice      | `stopWorkflow`                                                                                                              |
| Writes with a Create or Update (upsert) operation       | may retry                                                    | `stopWorkflow`                                                                                                              |
| Per-item step where one bad item must not stop the rest | as above                                                     | `continueErrorOutput`, error output wired to `Report Failed Item` (an e-mail to `testEmail` in test, the error channel live) |

`continueRegularOutput` hides failures and is not allowed.

## Items and empty data

n8n runs each node once **per incoming item**. A node after a node that returned 50 items runs 50 times.

- A step that should happen once (send one summary, one API call) gets an `Aggregate` before it or `executeOnce: true`.
- A get or search that may legitimately return nothing gets `alwaysOutputData: true`, followed by an If node named
  `Has <Things>?` (for example `Has Unread Emails?`). The false branch does what the PRD says for "nothing to process".
  Never set `alwaysOutputData` on If or Switch nodes; it can loop forever.
- Use `Loop Over Items` only for rate limits or batching, with the loop-back connection wired and `done` continuing.

## Naming

Name every node for what it does, so a non-technical user reading the canvas understands the flow without opening a
node. English, Title Case, unique within the workflow.

- Pattern **Verb + Object (+ qualifier)**: `Get Unread Emails`, `Extract Action Items`, `Send Meeting Summary`,
  `Create Asana Task`, `Format Daily Digest`, `Filter Out Newsletters`.
- Questions for If and Switch nodes: `Has Unread Emails?`, `Is Live?`, `Is Invoice Overdue?`.
- Triggers: what starts it, ending in `Trigger`: `Schedule Trigger`, `Gmail Trigger`, `Fathom Trigger`,
  `Webhook Trigger`.
- Fixed names the script relies on: `Set Config`, `Webhook Trigger`, `Is Live?` (prefix `Is Live`),
  `Send Test Preview` (prefix), `Report Failed Item`, `Error Handler`.
- Never: default names (`Gmail`, `Edit Fields1`, `HTTP Request`, `If2`), the app name alone, the word "Node".
- Workflow name is its purpose: `Daily Email Digest`, `Meeting Notes To Asana`. Every workflow gets the tag
  `frankenstein`.

## Node choice

1. The app's own node.
2. Core nodes: Edit Fields, If, Switch, Filter, Merge, Aggregate, Split Out, Remove Duplicates, Date & Time.
3. HTTP Request with a predefined credential type.
4. Code node, only when 1–3 cannot do it; the reason goes into `progress.md`.

## Node facts

Never write a node from memory. Before the first use of a node type in a workflow, and every time a push or a test
fails on a node, read the official sources and write the URL you used into `progress.md`:

- Behaviour, operations, limits: `https://docs.n8n.io/integrations/builtin/` (append `.md` to any page for Markdown;
  `https://docs.n8n.io/llms.txt` lists every page).
- Exact `type`, `typeVersion` and parameter keys: the node source in
  `https://github.com/n8n-io/n8n/tree/master/packages/nodes-base/nodes/<App>/` (raw files via
  `https://raw.githubusercontent.com/n8n-io/n8n/master/packages/nodes-base/nodes/...`). The `name:` of each property
  is the JSON key; `displayOptions` tells which keys apply to which operation; the `version` array gives the latest
  `typeVersion`.
- Credential type names: `https://github.com/n8n-io/n8n/tree/master/packages/nodes-base/credentials/` (the `name =`
  in the class); the node's `credentials` list says which one it takes.

A parameter in push's `dropped` list was wrong: n8n keeps only keys the node version knows.

## Credentials

The user signs in once per app; nodes are wired before they do.

- The builder writes `"credentials": { "<credentialType>": { "id": "", "name": "" } }` on every node that needs one.
  `creds` reuses an existing credential of that type or creates an empty one, fills the IDs and prints the link.
- **Sign-in apps (OAuth: Google, Microsoft, Slack, …):** the user opens the link and clicks *Sign in with …*. On
  n8n Cloud that is all; never ask for client IDs there. A self-hosted instance may ask for a client ID and secret of
  the app: then tell the user in plain words which app console to create it in, one step per message.
- **API-key apps (Apify, ElevenLabs, HTTP Request with Header Auth, …):** the user pastes the key into the same
  credential page in n8n. Keys never pass through the chat, `.env`, node parameters, files or logs.
- `creds --check` tests every credential (`POST /credentials/{id}/test`); sign-in happens before `push`.

## Testing

- The `Webhook Trigger` (Header Auth with the instance credential, path `frankenstein/<skill>`, set by push) feeds
  `Set Config` with payloads shaped exactly like the real trigger's output (look the shape up) – or `{}` for "run now"
  on a scheduled workflow.
- `test` passes when every example's checks pass and every executed node succeeded. "Built" is not "done".
- Test runs go only to the test address and clean up test records they created.

## Handoff

After `go-live`, tell the user in plain words: what runs and when, how to run it now from the chat, where to see it in
n8n, where errors are reported, and how to switch it off (unpublish the workflow in n8n, or ask here).
