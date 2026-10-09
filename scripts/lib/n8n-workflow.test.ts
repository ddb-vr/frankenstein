import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWorkflow, parseWorkflow } from "./n8n-rules.ts";
import {
  approvalHash,
  assignCredentials,
  credentialNeeds,
  droppedParameters,
  errorHandlerWorkflow,
  evaluateChecks,
  failedNodes,
  type Instance,
  liveTargets,
  parseChecks,
  prepareForLive,
  prepareForPush,
  summarizeExecution,
  validateInstance,
  workflowBody,
} from "./n8n-workflow.ts";

const EXPECTED_3_GOT_2 = /expected 3, got 2/;
const DID_NOT_RUN = /did not run/;

const instance: Instance = {
  errorWorkflowId: "err1",
  mail: "gmail",
  mailCredentialId: "cred-mail",
  testEmail: "me@example.com",
  webhookCredentialId: "cred-hook",
};

const draft = () => ({
  connections: {
    "Is Live?": {
      main: [
        [{ index: 0, node: "Send Daily Digest", type: "main" }],
        [{ index: 0, node: "Send Test Preview", type: "main" }],
      ],
    },
    "Schedule Trigger": {
      main: [[{ index: 0, node: "Set Config", type: "main" }]],
    },
    "Set Config": { main: [[{ index: 0, node: "Is Live?", type: "main" }]] },
    "Webhook Trigger": {
      main: [[{ index: 0, node: "Set Config", type: "main" }]],
    },
  },
  name: "Daily Email Digest",
  nodes: [
    {
      credentials: { httpHeaderAuth: { id: "", name: "" } },
      name: "Webhook Trigger",
      parameters: { authentication: "headerAuth" },
      type: "n8n-nodes-base.webhook",
    },
    {
      disabled: true,
      name: "Schedule Trigger",
      parameters: {},
      type: "n8n-nodes-base.scheduleTrigger",
    },
    {
      name: "Set Config",
      parameters: {
        assignments: {
          assignments: [
            { id: "1", name: "mode", type: "string", value: "test" },
            { id: "2", name: "testEmail", type: "string", value: "" },
          ],
        },
      },
      type: "n8n-nodes-base.set",
    },
    {
      name: "Is Live?",
      parameters: {
        conditions: {
          conditions: [
            { leftValue: "={{ $('Set Config').first().json.mode }}" },
          ],
        },
      },
      type: "n8n-nodes-base.if",
    },
    {
      credentials: { gmailOAuth2: { id: "", name: "" } },
      name: "Send Daily Digest",
      parameters: {
        operation: "send",
        resource: "message",
        sendTo: "boss@example.com",
      },
      type: "n8n-nodes-base.gmail",
    },
    {
      credentials: { gmailOAuth2: { id: "", name: "" } },
      name: "Send Test Preview",
      parameters: {
        operation: "send",
        resource: "message",
        sendTo: "={{ $('Set Config').first().json.testEmail }}",
      },
      type: "n8n-nodes-base.gmail",
    },
  ],
  settings: {},
});

const nodeNamed = (workflow: Record<string, unknown>, name: string) =>
  (workflow.nodes as Record<string, unknown>[]).find(
    (node) => node.name === name
  ) ?? {};

test("validateInstance accepts a full record and names what is missing", () => {
  assert.deepEqual(validateInstance(instance), instance);
  assert.equal(
    validateInstance({ ...instance, testEmail: "" }),
    'instance.json needs a non-empty "testEmail"'
  );
  assert.equal(
    validateInstance({ ...instance, mail: "pigeon" }),
    'instance.json "mail" must be one of gmail, outlook, smtp'
  );
  assert.equal(validateInstance(null), "instance.json must be an object");
});

test("prepareForPush fills the error workflow, test address, webhook path and credential", () => {
  const pushed = prepareForPush(draft(), "daily-email-digest", instance);
  assert.equal(
    (pushed.settings as Record<string, unknown>).errorWorkflow,
    "err1"
  );
  const webhook = nodeNamed(pushed, "Webhook Trigger");
  assert.deepEqual(webhook.credentials, {
    httpHeaderAuth: { id: "cred-hook", name: "" },
  });
  assert.deepEqual(webhook.parameters, {
    authentication: "headerAuth",
    httpMethod: "POST",
    path: "frankenstein/daily-email-digest",
  });
  const config = nodeNamed(pushed, "Set Config") as {
    parameters: {
      assignments: { assignments: { name: string; value: string }[] };
    };
  };
  const rows = config.parameters.assignments.assignments;
  assert.equal(
    rows.find((row) => row.name === "testEmail")?.value,
    "me@example.com"
  );
  assert.equal(rows.find((row) => row.name === "mode")?.value, "test");
  // The pushed draft follows every rule once the credentials are filled.
  const ids = new Map([["gmailOAuth2", { id: "cred-mail", name: "Gmail" }]]);
  assert.deepEqual(checkWorkflow(assignCredentials(pushed, ids)), []);
});

test("prepareForLive switches the mode and enables the real trigger only", () => {
  const live = prepareForLive(prepareForPush(draft(), "x", instance));
  const config = nodeNamed(live, "Set Config") as {
    parameters: {
      assignments: { assignments: { name: string; value: string }[] };
    };
  };
  assert.equal(
    config.parameters.assignments.assignments.find((row) => row.name === "mode")
      ?.value,
    "live"
  );
  assert.equal("disabled" in nodeNamed(live, "Schedule Trigger"), false);
  assert.equal("disabled" in nodeNamed(live, "Webhook Trigger"), false);
  // Live mode breaks the push rules on purpose: push never accepts it.
  assert.ok(
    checkWorkflow(live).some((problem) =>
      problem.message.includes('mode must be "test"')
    )
  );
});

test("workflowBody keeps only what the API accepts", () => {
  const body = workflowBody({ ...draft(), active: true, id: "1", tags: [] });
  assert.deepEqual(
    Object.keys(body).sort((a, b) => a.localeCompare(b)),
    ["connections", "name", "nodes", "settings"]
  );
});

test("credentialNeeds lists every slot and assignCredentials fills by type", () => {
  const needs = credentialNeeds(draft());
  assert.deepEqual(
    needs.map((need) => `${need.node}:${need.type}:${need.id}`),
    [
      "Webhook Trigger:httpHeaderAuth:",
      "Send Daily Digest:gmailOAuth2:",
      "Send Test Preview:gmailOAuth2:",
    ]
  );
  const filled = assignCredentials(
    draft(),
    new Map([["gmailOAuth2", { id: "g1", name: "Gmail" }]])
  );
  assert.deepEqual(nodeNamed(filled, "Send Daily Digest").credentials, {
    gmailOAuth2: { id: "g1", name: "Gmail" },
  });
  assert.deepEqual(nodeNamed(filled, "Webhook Trigger").credentials, {
    httpHeaderAuth: { id: "", name: "" },
  });
});

test("droppedParameters names what n8n did not keep", () => {
  const sent = draft();
  const readBack = structuredClone(sent) as Record<string, unknown>;
  const digest = nodeNamed(readBack, "Send Daily Digest") as {
    parameters: Record<string, unknown>;
  };
  digest.parameters = { operation: "send", resource: "message" };
  assert.deepEqual(droppedParameters(sent, readBack), [
    "Send Daily Digest.sendTo",
  ]);
  assert.deepEqual(
    droppedParameters(sent, structuredClone(sent) as Record<string, unknown>),
    []
  );
});

const execution = {
  data: {
    resultData: {
      lastNodeExecuted: "Send Test Preview",
      runData: {
        "Get Unread Emails": [
          {
            data: {
              main: [
                [
                  { json: { id: "1", Subject: "Invoice" } },
                  { json: { id: "2", Subject: "Hi" } },
                ],
              ],
            },
          },
        ],
        "Send Test Preview": [{ data: { main: [[{ json: { id: "m1" } }]] } }],
      },
    },
  },
  id: "42",
  status: "success",
};

test("summarizeExecution extracts items per node", () => {
  const summary = summarizeExecution(execution);
  assert.equal(summary.id, "42");
  assert.equal(summary.status, "success");
  assert.equal(summary.lastNode, "Send Test Preview");
  assert.equal(summary.nodes["Get Unread Emails"].items.length, 2);
  assert.deepEqual(summarizeExecution("nonsense"), {
    id: "",
    nodes: {},
    status: "unknown",
  });
});

test("summarizeExecution reports node and workflow errors", () => {
  const failed = summarizeExecution({
    data: {
      resultData: {
        error: { message: "boom" },
        runData: {
          "Get Unread Emails": [{ error: { message: "401 unauthorized" } }],
        },
      },
    },
    id: "7",
    status: "error",
  });
  assert.equal(failed.error, "boom");
  assert.deepEqual(failedNodes(failed), [
    "Get Unread Emails: 401 unauthorized",
  ]);
});

test("parseChecks validates the expected list", () => {
  assert.equal(typeof parseChecks([]), "string");
  assert.equal(typeof parseChecks([{ path: "length" }]), "string");
  assert.equal(typeof parseChecks([{ node: "A" }]), "string");
  assert.equal(
    typeof parseChecks([{ contains: "x", equals: 1, node: "A" }]),
    "string"
  );
  assert.deepEqual(parseChecks([{ equals: 2, node: "A", path: "length" }]), [
    { equals: 2, node: "A", path: "length" },
  ]);
  assert.deepEqual(parseChecks([{ node: "A", ran: false }]), [
    { node: "A", ran: false },
  ]);
});

test("evaluateChecks enforces that a node did not run", () => {
  const summary = summarizeExecution(execution);
  assert.deepEqual(
    evaluateChecks(
      [
        { node: "Send Daily Digest", ran: false },
        { node: "Send Test Preview", ran: true },
      ],
      summary
    ),
    []
  );
  assert.deepEqual(
    evaluateChecks([{ node: "Send Test Preview", ran: false }], summary),
    ["Send Test Preview: ran, but must not in this mode"]
  );
});

test("evaluateChecks compares paths into the node output", () => {
  const summary = summarizeExecution(execution);
  assert.deepEqual(
    evaluateChecks(
      [
        { equals: 2, node: "Get Unread Emails", path: "length" },
        { equals: "Invoice", node: "Get Unread Emails", path: "0.Subject" },
        { contains: "Inv", node: "Get Unread Emails", path: "0.Subject" },
      ],
      summary
    ),
    []
  );
  const failures = evaluateChecks(
    [
      { equals: 3, node: "Get Unread Emails", path: "length" },
      { contains: "zzz", node: "Get Unread Emails", path: "1.Subject" },
      { equals: 1, node: "Never Ran", path: "length" },
    ],
    summary
  );
  assert.equal(failures.length, 3);
  assert.match(failures[0] ?? "", EXPECTED_3_GOT_2);
  assert.match(failures[2] ?? "", DID_NOT_RUN);
});

test("the Error Handler template passes the rules for every mail kind", () => {
  for (const kind of ["gmail", "outlook", "smtp"] as const) {
    const handler = errorHandlerWorkflow(kind, "c1", "me@example.com");
    assert.deepEqual(checkWorkflow(handler), [], kind);
  }
});

test("approvalHash changes with the text and liveTargets names what go-live turns on", () => {
  assert.notEqual(approvalHash("a"), approvalHash("b"));
  const workflow = parseWorkflow(draft());
  assert.ok(typeof workflow !== "string");
  assert.deepEqual(liveTargets(workflow), [
    "Schedule Trigger (turns on)",
    "Send Daily Digest (runs for real)",
  ]);
});
