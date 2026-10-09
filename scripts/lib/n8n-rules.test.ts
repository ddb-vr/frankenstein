import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkWorkflow,
  configMode,
  type Problem,
  parseWorkflow,
  SAFE_IN_TEST_MARKER,
} from "./n8n-rules.ts";

const TEST_EMAIL = "={{ $('Set Config').first().json.testEmail }}";

interface Node {
  name: string;
  parameters: Record<string, unknown>;
  type: string;
  [key: string]: unknown;
}

type Connections = Record<
  string,
  { main: ({ index: number; node: string; type: string }[] | null)[] }
>;

const to = (...names: string[]) =>
  names.map((node) => ({ index: 0, node, type: "main" }));

const setConfig = (mode: string): Node => ({
  name: "Set Config",
  parameters: {
    assignments: {
      assignments: [
        { id: "1", name: "mode", type: "string", value: mode },
        { id: "2", name: "testEmail", type: "string", value: "me@example.com" },
      ],
    },
  },
  type: "n8n-nodes-base.set",
});

const gmailSend = (name: string, sendTo: string): Node => ({
  name,
  parameters: {
    emailType: "text",
    message: "Hi",
    operation: "send",
    resource: "message",
    sendTo,
    subject: "Digest",
  },
  type: "n8n-nodes-base.gmail",
});

const validWorkflow = () => ({
  connections: {
    "Get Unread Emails": { main: [to("Is Live?")] },
    "Is Live?": { main: [to("Send Daily Digest"), to("Send Test Preview")] },
    "Schedule Trigger": { main: [to("Set Config")] },
    "Set Config": { main: [to("Get Unread Emails")] },
    "Webhook Trigger": { main: [to("Set Config")] },
  } as Connections,
  name: "Daily Email Digest",
  nodes: [
    {
      name: "Webhook Trigger",
      parameters: { authentication: "headerAuth", httpMethod: "POST" },
      type: "n8n-nodes-base.webhook",
    },
    {
      disabled: true,
      name: "Schedule Trigger",
      parameters: {},
      type: "n8n-nodes-base.scheduleTrigger",
    },
    setConfig("test"),
    {
      name: "Get Unread Emails",
      parameters: { operation: "getAll", resource: "message" },
      retryOnFail: true,
      type: "n8n-nodes-base.gmail",
    },
    {
      name: "Is Live?",
      parameters: {
        conditions: {
          combinator: "and",
          conditions: [
            {
              leftValue: "={{ $('Set Config').first().json.mode }}",
              operator: { operation: "equals", type: "string" },
              rightValue: "live",
            },
          ],
        },
      },
      type: "n8n-nodes-base.if",
    },
    gmailSend("Send Daily Digest", "boss@example.com"),
    gmailSend("Send Test Preview", TEST_EMAIL),
  ] as Node[],
  settings: { errorWorkflow: "abc123" },
});

type Workflow = ReturnType<typeof validWorkflow>;

const withNode = (
  name: string,
  change: (node: Node) => Node,
  workflow: Workflow = validWorkflow()
): Workflow => ({
  ...workflow,
  nodes: workflow.nodes.map((node) =>
    node.name === name ? change(node) : node
  ),
});

const messages = (problems: Problem[]): string =>
  problems
    .map((problem) => `${problem.node ?? "-"}: ${problem.message}`)
    .join("\n");

const assertProblem = (problems: Problem[], expected: string): void => {
  const text = messages(problems);
  assert.ok(text.includes(expected), `expected "${expected}" in:\n${text}`);
};

test("a workflow that follows every rule passes", () => {
  assert.deepEqual(checkWorkflow(validWorkflow()), []);
});

test("configMode reads the Set Config mode", () => {
  const workflow = parseWorkflow(validWorkflow());
  assert.ok(typeof workflow !== "string");
  assert.equal(configMode(workflow), "test");
});

test("a write that is not behind Is Live? fails", () => {
  const workflow = validWorkflow();
  workflow.connections["Get Unread Emails"] = {
    main: [to("Send Daily Digest", "Is Live?")],
  };
  assertProblem(
    checkWorkflow(workflow),
    "Send Daily Digest: writes outside n8n"
  );
});

test("a write on the false branch of the gate fails", () => {
  const workflow = validWorkflow();
  workflow.connections["Is Live?"] = {
    main: [to("Send Test Preview"), to("Send Daily Digest")],
  };
  assertProblem(
    checkWorkflow(workflow),
    "Send Daily Digest: writes outside n8n"
  );
});

test("a write marked safe in test needs no gate", () => {
  const workflow = withNode("Send Daily Digest", (node) => ({
    ...node,
    name: "Start Scraper Run",
    notes: `${SAFE_IN_TEST_MARKER} – starts a run nobody sees`,
    parameters: { method: "POST", url: "https://api.apify.com/v2/acts" },
    type: "n8n-nodes-base.httpRequest",
  }));
  workflow.connections["Is Live?"] = {
    main: [to("Start Scraper Run"), to("Send Test Preview")],
  };
  workflow.connections["Get Unread Emails"] = {
    main: [to("Is Live?", "Start Scraper Run")],
  };
  assert.deepEqual(checkWorkflow(workflow), []);
});

test("a gate without a preview on its false branch fails", () => {
  const workflow = validWorkflow();
  workflow.connections["Is Live?"] = { main: [to("Send Daily Digest"), null] };
  assertProblem(checkWorkflow(workflow), "Is Live?: the false branch");
});

test("a gate that does not read Set Config fails", () => {
  const problems = checkWorkflow(
    withNode("Is Live?", (node) => ({
      ...node,
      parameters: {
        conditions: { conditions: [{ leftValue: "={{ $json.mode }}" }] },
      },
    }))
  );
  assertProblem(problems, "Is Live?: compare $('Set Config')");
});

test("a preview that goes anywhere but the test address fails", () => {
  const literal = withNode("Send Test Preview", (node) =>
    gmailSend(node.name, "boss@example.com")
  );
  assertProblem(checkWorkflow(literal), "sendTo must be ={{ $('Set Config')");
  const cc = withNode("Send Test Preview", (node) => ({
    ...node,
    parameters: { ...node.parameters, options: { ccList: "x@example.com" } },
  }));
  assertProblem(checkWorkflow(cc), "no CC or BCC");
  const slack = withNode("Send Test Preview", (node) => ({
    ...node,
    parameters: { channelId: "C1", operation: "post", resource: "message" },
    type: "n8n-nodes-base.slack",
  }));
  assertProblem(checkWorkflow(slack), "the preview is an e-mail node");
});

test("Set Config in live mode or without testEmail fails", () => {
  assertProblem(
    checkWorkflow(withNode("Set Config", () => setConfig("live"))),
    'mode must be "test"'
  );
  const noEmail = withNode("Set Config", (node) => ({
    ...node,
    parameters: {
      assignments: { assignments: [{ name: "mode", value: "test" }] },
    },
  }));
  assertProblem(checkWorkflow(noEmail), "add a testEmail field");
});

test("a missing Set Config fails", () => {
  const workflow = validWorkflow();
  const problems = checkWorkflow({
    ...workflow,
    nodes: workflow.nodes.filter((node) => node.name !== "Set Config"),
  });
  assertProblem(problems, 'add an Edit Fields node named "Set Config"');
});

test("a trigger that skips Set Config fails", () => {
  const workflow = validWorkflow();
  workflow.connections["Webhook Trigger"] = { main: [to("Get Unread Emails")] };
  assertProblem(
    checkWorkflow(workflow),
    'Webhook Trigger: a trigger feeds only "Set Config"'
  );
});

test("a missing or unauthenticated Webhook Trigger fails", () => {
  const workflow = validWorkflow();
  const missing = {
    ...workflow,
    nodes: workflow.nodes.filter((node) => node.name !== "Webhook Trigger"),
  };
  assertProblem(
    checkWorkflow(missing),
    'exactly one Webhook node named "Webhook Trigger"'
  );
  const open = withNode("Webhook Trigger", (node) => ({
    ...node,
    parameters: { httpMethod: "POST" },
  }));
  assertProblem(checkWorkflow(open), 'set authentication to "headerAuth"');
});

test("an enabled real trigger fails before go-live", () => {
  const problems = checkWorkflow(
    withNode("Schedule Trigger", (node) => ({ ...node, disabled: false }))
  );
  assertProblem(problems, "Schedule Trigger: the real trigger stays disabled");
});

test("retry rules: reads retry, writes do not", () => {
  assertProblem(
    checkWorkflow(
      withNode("Get Unread Emails", (node) => ({ ...node, retryOnFail: false }))
    ),
    "reads retry"
  );
  assertProblem(
    checkWorkflow(
      withNode("Send Daily Digest", (node) => ({ ...node, retryOnFail: true }))
    ),
    "never retry a write"
  );
  const upsert = withNode("Send Daily Digest", (node) => ({
    ...node,
    parameters: { operation: "upsert", resource: "row" },
    retryOnFail: true,
    type: "n8n-nodes-base.googleSheets",
  }));
  assert.deepEqual(checkWorkflow(upsert), []);
});

test("an external node without an operation fails", () => {
  const problems = checkWorkflow(
    withNode("Get Unread Emails", (node) => ({ ...node, parameters: {} }))
  );
  assertProblem(problems, "set resource and operation explicitly");
});

test("default, lowercase and Node names fail", () => {
  for (const name of [
    "Gmail",
    "Gmail1",
    "HTTP Request1",
    "send digest",
    "Gmail Node Send",
  ]) {
    const workflow = withNode("Send Daily Digest", (node) => ({
      ...node,
      name,
    }));
    workflow.connections["Is Live?"] = {
      main: [to(name), to("Send Test Preview")],
    };
    assert.notDeepEqual(checkWorkflow(workflow), [], name);
  }
  const trigger = withNode("Webhook Trigger", (node) => ({
    ...node,
    name: "Webhook",
  }));
  trigger.connections.Webhook = trigger.connections["Webhook Trigger"];
  assert.notDeepEqual(checkWorkflow(trigger), []);
});

test("a trigger name without the Trigger suffix fails", () => {
  const workflow = withNode("Schedule Trigger", (node) => ({
    ...node,
    name: "Every Morning",
  }));
  workflow.connections["Every Morning"] =
    workflow.connections["Schedule Trigger"];
  assertProblem(
    checkWorkflow(workflow),
    'Every Morning: trigger names end with " Trigger"'
  );
});

test("a missing error workflow fails", () => {
  assertProblem(
    checkWorkflow({ ...validWorkflow(), settings: {} }),
    "settings.errorWorkflow"
  );
});

test("continueRegularOutput and an unwired error output fail", () => {
  const regular = checkWorkflow(
    withNode("Get Unread Emails", (node) => ({
      ...node,
      onError: "continueRegularOutput",
    }))
  );
  assertProblem(regular, "hides failures");
  const unwired = checkWorkflow(
    withNode("Get Unread Emails", (node) => ({
      ...node,
      onError: "continueErrorOutput",
    }))
  );
  assertProblem(unwired, "error output wired");
});

test("alwaysOutputData on an If node fails", () => {
  const problems = checkWorkflow(
    withNode("Is Live?", (node) => ({ ...node, alwaysOutputData: true }))
  );
  assertProblem(problems, "can loop forever");
});

test("a Code node that reaches out fails", () => {
  const workflow = validWorkflow();
  const code = (jsCode: string) =>
    checkWorkflow({
      ...workflow,
      nodes: [
        ...workflow.nodes,
        {
          name: "Format Digest",
          parameters: { jsCode },
          type: "n8n-nodes-base.code",
        },
      ],
    });
  assertProblem(code("const r = await fetch('https://x');"), "no fetch");
  assertProblem(code("const fs = require('fs');"), "no require");
  assertProblem(code("return [{ json: { key: $env.KEY } }];"), "no $env");
  assert.deepEqual(
    code("return $input.all().map((i) => ({ json: i.json }));"),
    []
  );
});

test("a literal token in parameters fails", () => {
  const problems = checkWorkflow(
    withNode("Get Unread Emails", (node) => ({
      ...node,
      parameters: {
        headerParameters: {
          parameters: [{ name: "Authorization", value: "Bearer abc123" }],
        },
        method: "GET",
        url: "https://example.com",
      },
      type: "n8n-nodes-base.httpRequest",
    }))
  );
  assertProblem(problems, "secret in parameters");
});

test("connections to unknown nodes fail", () => {
  const workflow = validWorkflow();
  workflow.connections["Set Config"] = { main: [to("Nowhere")] };
  assertProblem(
    checkWorkflow(workflow),
    'connection to unknown node "Nowhere"'
  );
});

test("duplicate node names fail", () => {
  const workflow = validWorkflow();
  const problems = checkWorkflow({
    ...workflow,
    nodes: [...workflow.nodes, setConfig("test")],
  });
  assertProblem(problems, "node names must be unique");
});

test("the Error Handler needs no Set Config, gate or webhook and may name its recipient", () => {
  const problems = checkWorkflow({
    connections: {
      "Error Trigger": { main: [to("Format Error Message")] },
      "Format Error Message": { main: [to("Send Error Notification")] },
    },
    name: "Error Handler",
    nodes: [
      {
        name: "Error Trigger",
        parameters: {},
        type: "n8n-nodes-base.errorTrigger",
      },
      {
        name: "Format Error Message",
        parameters: { assignments: { assignments: [] } },
        type: "n8n-nodes-base.set",
      },
      gmailSend("Send Error Notification", "owner@example.com"),
    ],
    settings: {},
  });
  assert.deepEqual(problems, []);
});
