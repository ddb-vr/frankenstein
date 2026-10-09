// Pure helpers of the n8n route (`scripts/n8n.ts`): the instance record, the
// Error Handler template, what push and go-live change in a workflow, what
// `creds` must create, example checks against execution data, and the
// read-back comparison. No network, no file access.

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isPlainObject } from "./examples.ts";
import {
  CONFIG_NODE,
  isTrigger,
  type N8nNode,
  type N8nWorkflow,
  SET_TYPE,
  WEBHOOK_TRIGGER,
  WEBHOOK_TYPE,
} from "./n8n-rules.ts";

export const FRANKENSTEIN_TAG = "frankenstein";
export const WEBHOOK_HEADER = "X-Frankenstein-Key";
export const WEBHOOK_SECRET_ENV = "N8N_WEBHOOK_SECRET";
export const WEBHOOK_CREDENTIAL_TYPE = "httpHeaderAuth";
export const ERROR_HANDLER_NAME = "Error Handler";
/** Mail nodes the Error Handler and test previews can use. */
export const MAIL_KINDS = ["gmail", "outlook", "smtp"] as const;
export type MailKind = (typeof MAIL_KINDS)[number];

/** `n8n/instance.json`: what exists once per n8n instance. */
export interface Instance {
  /** ID of the Error Handler workflow in n8n. */
  errorWorkflowId: string;
  /** Mail node kind used for error notifications and test previews. */
  mail: MailKind;
  /** Credential ID of that mail node. */
  mailCredentialId: string;
  /** Where test previews, "nothing today" test runs and errors go. */
  testEmail: string;
  /** Header Auth credential every Webhook Trigger uses. */
  webhookCredentialId: string;
}

const MAIL_CREDENTIAL_TYPE: Record<MailKind, string> = {
  gmail: "gmailOAuth2",
  outlook: "microsoftOutlookOAuth2Api",
  smtp: "smtp",
};

export const mailCredentialType = (kind: MailKind): string =>
  MAIL_CREDENTIAL_TYPE[kind];

export const validateInstance = (data: unknown): Instance | string => {
  if (!isPlainObject(data)) {
    return "instance.json must be an object";
  }
  const strings = [
    "errorWorkflowId",
    "mailCredentialId",
    "testEmail",
    "webhookCredentialId",
  ] as const;
  for (const key of strings) {
    if (typeof data[key] !== "string" || data[key] === "") {
      return `instance.json needs a non-empty "${key}"`;
    }
  }
  if (!MAIL_KINDS.includes(data.mail as MailKind)) {
    return `instance.json "mail" must be one of ${MAIL_KINDS.join(", ")}`;
  }
  return {
    errorWorkflowId: data.errorWorkflowId as string,
    mail: data.mail as MailKind,
    mailCredentialId: data.mailCredentialId as string,
    testEmail: data.testEmail as string,
    webhookCredentialId: data.webhookCredentialId as string,
  };
};

// ---------------------------------------------------------------------------
// Mail nodes

interface MailMessage {
  message: string;
  subject: string;
  to: string;
}

/**
 * A send node of the instance's mail kind. Parameter keys come from the node
 * sources: Gmail v2 MessageDescription.ts, EmailSend v2, Outlook v2.
 */
export const mailNode = (
  name: string,
  kind: MailKind,
  credentialId: string,
  mail: MailMessage,
  position: [number, number]
): Record<string, unknown> => {
  const credentials = {
    [MAIL_CREDENTIAL_TYPE[kind]]: { id: credentialId, name: "" },
  };
  if (kind === "gmail") {
    return {
      credentials,
      name,
      parameters: {
        emailType: "text",
        message: mail.message,
        operation: "send",
        options: { appendAttribution: false },
        resource: "message",
        sendTo: mail.to,
        subject: mail.subject,
      },
      position,
      type: "n8n-nodes-base.gmail",
      typeVersion: 2.1,
    };
  }
  if (kind === "outlook") {
    return {
      credentials,
      name,
      parameters: {
        bodyContent: mail.message,
        operation: "send",
        resource: "message",
        subject: mail.subject,
        toRecipients: mail.to,
      },
      position,
      type: "n8n-nodes-base.microsoftOutlook",
      typeVersion: 2,
    };
  }
  return {
    credentials,
    name,
    parameters: {
      emailFormat: "text",
      fromEmail: "frankenstein@localhost",
      options: {},
      subject: mail.subject,
      text: mail.message,
      toEmail: mail.to,
    },
    position,
    type: "n8n-nodes-base.emailSend",
    typeVersion: 2.1,
  };
};

// ---------------------------------------------------------------------------
// Error Handler

const ERROR_MESSAGE = [
  "A workflow failed.",
  "",
  "Workflow: {{ $json.workflow.name }}",
  "Failed node: {{ $json.execution ? $json.execution.lastNodeExecuted : ($json.trigger.error.node ? $json.trigger.error.node.name : 'trigger') }}",
  "Error: {{ $json.execution ? $json.execution.error.message : $json.trigger.error.message }}",
  "Execution: {{ $json.execution ? $json.execution.url : 'the trigger failed, so there is no execution' }}",
].join("\n");

/** The one Error Handler workflow of an instance. */
export const errorHandlerWorkflow = (
  kind: MailKind,
  credentialId: string,
  testEmail: string
): Record<string, unknown> => ({
  connections: {
    "Error Trigger": {
      main: [[{ index: 0, node: "Send Error Notification", type: "main" }]],
    },
  },
  name: ERROR_HANDLER_NAME,
  nodes: [
    {
      name: "Error Trigger",
      parameters: {},
      position: [0, 0],
      type: "n8n-nodes-base.errorTrigger",
      typeVersion: 1,
    },
    mailNode(
      "Send Error Notification",
      kind,
      credentialId,
      {
        message: `=${ERROR_MESSAGE}`,
        subject: "=[n8n] {{ $json.workflow.name }} failed",
        to: testEmail,
      },
      [260, 0]
    ),
  ],
  settings: { executionOrder: "v1" },
});

// ---------------------------------------------------------------------------
// Push and go-live

export const webhookPath = (skill: string): string => `frankenstein/${skill}`;

const setConfigRow = (
  node: Record<string, unknown>,
  name: string,
  value: string
): Record<string, unknown> => {
  const parameters = isPlainObject(node.parameters) ? node.parameters : {};
  const assignments: Record<string, unknown> = isPlainObject(
    parameters.assignments
  )
    ? parameters.assignments
    : {};
  const rows: unknown[] = Array.isArray(assignments.assignments)
    ? assignments.assignments
    : [];
  const updated = rows.map((row: unknown) =>
    isPlainObject(row) && row.name === name ? { ...row, value } : row
  );
  return {
    ...node,
    parameters: {
      ...parameters,
      assignments: { ...assignments, assignments: updated },
    },
  };
};

/**
 * What push fills in from the instance and the skill name: the error
 * workflow, the test address, the webhook path and credential. The mode is
 * left as the builder wrote it (`test`, or the rules refuse the push).
 */
export const prepareForPush = (
  workflow: Record<string, unknown>,
  skill: string,
  instance: Instance
): Record<string, unknown> => {
  const nodes = (Array.isArray(workflow.nodes) ? workflow.nodes : []).map(
    (node: unknown) => {
      if (!isPlainObject(node)) {
        return node;
      }
      if (node.name === CONFIG_NODE && node.type === SET_TYPE) {
        return setConfigRow(node, "testEmail", instance.testEmail);
      }
      if (node.name === WEBHOOK_TRIGGER && node.type === WEBHOOK_TYPE) {
        return {
          ...node,
          credentials: {
            [WEBHOOK_CREDENTIAL_TYPE]: {
              id: instance.webhookCredentialId,
              name: "",
            },
          },
          parameters: {
            ...(isPlainObject(node.parameters) ? node.parameters : {}),
            authentication: "headerAuth",
            httpMethod: "POST",
            path: webhookPath(skill),
          },
        };
      }
      return node;
    }
  );
  const settings = isPlainObject(workflow.settings) ? workflow.settings : {};
  return {
    ...workflow,
    nodes,
    settings: { ...settings, errorWorkflow: instance.errorWorkflowId },
  };
};

/** Live mode: `mode` becomes `live` and every real trigger is enabled. */
export const prepareForLive = (
  workflow: Record<string, unknown>
): Record<string, unknown> => ({
  ...workflow,
  nodes: (Array.isArray(workflow.nodes) ? workflow.nodes : []).map(
    (node: unknown) => {
      if (!isPlainObject(node)) {
        return node;
      }
      if (node.name === CONFIG_NODE && node.type === SET_TYPE) {
        return setConfigRow(node, "mode", "live");
      }
      const trigger = isTrigger(node as unknown as N8nNode);
      if (trigger && node.type !== WEBHOOK_TYPE) {
        const { disabled: _disabled, ...rest } = node;
        return rest;
      }
      return node;
    }
  ),
});

/** The body n8n accepts for create and update (read-only fields dropped). */
export const workflowBody = (
  workflow: Record<string, unknown>
): Record<string, unknown> => ({
  connections: workflow.connections,
  name: workflow.name,
  nodes: workflow.nodes,
  settings: workflow.settings ?? {},
  ...(workflow.staticData === undefined
    ? {}
    : { staticData: workflow.staticData }),
});

// ---------------------------------------------------------------------------
// Credentials

export interface CredentialNeed {
  /** Current credential ID in the node, "" when still to be filled. */
  id: string;
  node: string;
  type: string;
}

/** Every credential slot of the workflow, from the nodes' `credentials`. */
export const credentialNeeds = (
  workflow: Record<string, unknown>
): CredentialNeed[] => {
  const needs: CredentialNeed[] = [];
  for (const node of Array.isArray(workflow.nodes) ? workflow.nodes : []) {
    if (!(isPlainObject(node) && isPlainObject(node.credentials))) {
      continue;
    }
    for (const [type, value] of Object.entries(node.credentials)) {
      const id =
        isPlainObject(value) && typeof value.id === "string" ? value.id : "";
      needs.push({ id, node: String(node.name), type });
    }
  }
  return needs;
};

/** The workflow with `ids` (type → credential) written into every node. */
export const assignCredentials = (
  workflow: Record<string, unknown>,
  ids: ReadonlyMap<string, { id: string; name: string }>
): Record<string, unknown> => ({
  ...workflow,
  nodes: (Array.isArray(workflow.nodes) ? workflow.nodes : []).map(
    (node: unknown) => {
      if (!(isPlainObject(node) && isPlainObject(node.credentials))) {
        return node;
      }
      const credentials = Object.fromEntries(
        Object.entries(node.credentials).map(([type, value]) => {
          const assigned = ids.get(type);
          return [type, assigned === undefined ? value : { ...assigned }];
        })
      );
      return { ...node, credentials };
    }
  ),
});

// ---------------------------------------------------------------------------
// Read-back

/** Dotted paths whose value differs between what was sent and read back. */
export const droppedParameters = (
  sent: Record<string, unknown>,
  readBack: Record<string, unknown>
): string[] => {
  const remote = new Map(
    (Array.isArray(readBack.nodes) ? readBack.nodes : [])
      .filter(isPlainObject)
      .map((node) => [node.name, node.parameters])
  );
  const dropped: string[] = [];
  const walk = (prefix: string, local: unknown, actual: unknown): void => {
    if (isPlainObject(local)) {
      for (const [key, value] of Object.entries(local)) {
        walk(
          `${prefix}.${key}`,
          value,
          isPlainObject(actual) ? actual[key] : undefined
        );
      }
      return;
    }
    if (!isDeepStrictEqual(local, actual)) {
      dropped.push(prefix);
    }
  };
  for (const node of Array.isArray(sent.nodes) ? sent.nodes : []) {
    if (isPlainObject(node)) {
      walk(String(node.name), node.parameters ?? {}, remote.get(node.name));
    }
  }
  return dropped;
};

// ---------------------------------------------------------------------------
// Executions

export interface NodeRun {
  error?: string;
  items: unknown[];
}

export interface ExecutionSummary {
  error?: string;
  id: string;
  lastNode?: string;
  /** Items of the first run's main output 0, per executed node. */
  nodes: Record<string, NodeRun>;
  status: string;
}

const itemsOf = (run: unknown): unknown[] => {
  if (!(isPlainObject(run) && isPlainObject(run.data))) {
    return [];
  }
  const { main } = run.data;
  const first = Array.isArray(main) ? main[0] : undefined;
  return Array.isArray(first)
    ? first.map((item) => (isPlainObject(item) ? item.json : item))
    : [];
};

/** What the agent and the checks need from `GET /executions/{id}?includeData=true`. */
export const summarizeExecution = (execution: unknown): ExecutionSummary => {
  if (!isPlainObject(execution)) {
    return { id: "", nodes: {}, status: "unknown" };
  }
  const result =
    isPlainObject(execution.data) && isPlainObject(execution.data.resultData)
      ? execution.data.resultData
      : {};
  const runData = isPlainObject(result.runData) ? result.runData : {};
  const nodes: Record<string, NodeRun> = {};
  for (const [name, runs] of Object.entries(runData)) {
    const run = Array.isArray(runs) ? runs[0] : undefined;
    const errorText =
      isPlainObject(run) && isPlainObject(run.error)
        ? String(run.error.message ?? run.error.description ?? "failed")
        : undefined;
    nodes[name] = {
      ...(errorText === undefined ? {} : { error: errorText }),
      items: itemsOf(run),
    };
  }
  const topError = isPlainObject(result.error)
    ? String(result.error.message ?? "failed")
    : undefined;
  return {
    ...(topError === undefined ? {} : { error: topError }),
    id: String(execution.id ?? ""),
    ...(typeof result.lastNodeExecuted === "string"
      ? { lastNode: result.lastNodeExecuted }
      : {}),
    nodes,
    status: String(execution.status ?? "unknown"),
  };
};

/** One check of an example's `expected` list. */
export interface Check {
  contains?: string;
  equals?: unknown;
  node: string;
  /** Dotted path into the node's output items (`length`, `0.subject`). */
  path?: string;
  /** `false`: the node must not have run (a live write in test mode). */
  ran?: boolean;
}

const parseCheck = (raw: unknown, index: number): Check | string => {
  if (!(isPlainObject(raw) && typeof raw.node === "string")) {
    return `expected[${index}] needs a node name`;
  }
  if (raw.path !== undefined && typeof raw.path !== "string") {
    return `expected[${index}].path must be a string`;
  }
  if (typeof raw.ran === "boolean") {
    return { node: raw.node, ran: raw.ran };
  }
  const hasEquals = "equals" in raw;
  const hasContains = typeof raw.contains === "string";
  if (hasEquals === hasContains) {
    return `expected[${index}] needs exactly one of equals, contains or ran`;
  }
  return {
    node: raw.node,
    ...(typeof raw.path === "string" ? { path: raw.path } : {}),
    ...(hasEquals ? { equals: raw.equals } : {}),
    ...(hasContains ? { contains: raw.contains as string } : {}),
  };
};

export const parseChecks = (expected: unknown): Check[] | string => {
  if (!Array.isArray(expected) || expected.length === 0) {
    return "expected must be a non-empty list of checks { node, path?, equals | contains } or { node, ran }";
  }
  const checks: Check[] = [];
  for (const [index, raw] of expected.entries()) {
    const check = parseCheck(raw, index);
    if (typeof check === "string") {
      return check;
    }
    checks.push(check);
  }
  return checks;
};

const valueAtPath = (
  value: unknown,
  dottedPath: string | undefined
): unknown => {
  if (dottedPath === undefined || dottedPath === "") {
    return value;
  }
  let current: unknown = value;
  for (const key of dottedPath.split(".")) {
    if (Array.isArray(current)) {
      current = key === "length" ? current.length : current[Number(key)];
    } else if (isPlainObject(current)) {
      current = current[key];
    } else {
      return;
    }
  }
  return current;
};

/** Failed checks as messages; empty means the example passed. */
export const evaluateChecks = (
  checks: readonly Check[],
  summary: ExecutionSummary
): string[] => {
  const failures: string[] = [];
  for (const check of checks) {
    const run = summary.nodes[check.node];
    if (check.ran === false) {
      if (run !== undefined) {
        failures.push(`${check.node}: ran, but must not in this mode`);
      }
      continue;
    }
    if (run === undefined) {
      failures.push(`${check.node}: did not run`);
      continue;
    }
    const actual = valueAtPath(run.items, check.path);
    const where = `${check.node}${check.path === undefined ? "" : `.${check.path}`}`;
    if ("equals" in check && !isDeepStrictEqual(actual, check.equals)) {
      failures.push(
        `${where}: expected ${JSON.stringify(check.equals)}, got ${JSON.stringify(actual)}`
      );
    }
    if (
      check.contains !== undefined &&
      !(typeof actual === "string" && actual.includes(check.contains))
    ) {
      failures.push(
        `${where}: expected text containing ${JSON.stringify(check.contains)}, got ${JSON.stringify(actual)}`
      );
    }
  }
  return failures;
};

/** Nodes that failed in the execution, as messages. */
export const failedNodes = (summary: ExecutionSummary): string[] =>
  Object.entries(summary.nodes)
    .filter(([, run]) => run.error !== undefined)
    .map(([name, run]) => `${name}: ${run.error}`);

// ---------------------------------------------------------------------------
// Approval

export const approvalHash = (workflowText: string): string =>
  createHash("sha256").update(workflowText).digest("hex");

/** Live targets in plain words: the nodes go-live will let run for real. */
export const liveTargets = (workflow: N8nWorkflow): string[] =>
  workflow.nodes
    .filter((node) => isTrigger(node) && node.type !== WEBHOOK_TYPE)
    .map((node) => `${node.name} (turns on)`)
    .concat(
      workflow.nodes
        .filter((node) => node.name.startsWith("Is Live"))
        .flatMap((gate) =>
          (workflow.connections[gate.name]?.main?.[0] ?? []).map(
            (connection) => connection.node
          )
        )
        .map((name) => `${name} (runs for real)`)
    );
