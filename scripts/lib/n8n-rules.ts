// Static checks for an n8n workflow before it is pushed (see
// `.claude/skills/frankenstein/N8N.md`). Pure: no network, no file access.
//
// The safety rule is the point: a workflow stays in test mode until the user
// approves going live. In test mode nothing may reach a real person, channel
// or record, so every node that writes outside n8n sits behind an `Is Live?`
// gate whose false branch sends the user an e-mail preview instead.

import { isPlainObject } from "./examples.ts";

export interface Problem {
  message: string;
  node?: string;
}

interface Connection {
  node: string;
}
interface NodeConnections {
  main?: (Connection[] | null)[];
}

export interface N8nNode {
  alwaysOutputData?: boolean;
  disabled?: boolean;
  name: string;
  notes?: string;
  onError?: string;
  parameters: Record<string, unknown>;
  retryOnFail?: boolean;
  type: string;
}

export interface N8nWorkflow {
  connections: Record<string, NodeConnections>;
  name: string;
  nodes: N8nNode[];
  settings: Record<string, unknown>;
}

export const CONFIG_NODE = "Set Config";
export const WEBHOOK_TRIGGER = "Webhook Trigger";
export const GATE_PREFIX = "Is Live";
export const PREVIEW_PREFIX = "Send Test Preview";
/** Notes marker for a write that may run in test mode (reaches no one). */
export const SAFE_IN_TEST_MARKER = "frankenstein: safe in test";

export const SET_TYPE = "n8n-nodes-base.set";
export const IF_TYPE = "n8n-nodes-base.if";
export const WEBHOOK_TYPE = "n8n-nodes-base.webhook";
export const ERROR_TRIGGER_TYPE = "n8n-nodes-base.errorTrigger";
const HTTP_TYPE = "n8n-nodes-base.httpRequest";
const CODE_TYPE = "n8n-nodes-base.code";
const SWITCH_TYPE = "n8n-nodes-base.switch";
const LANGCHAIN_PREFIX = "@n8n/n8n-nodes-langchain.";

const CONFIG_REFERENCE = /\$\(\s*['"]Set Config['"]\s*\)/;
const TEST_EMAIL_REFERENCE =
  /\$\(\s*['"]Set Config['"]\s*\)\.(first|item)\(\)\.json\.testEmail/;
const GLUED_NUMBER = /[A-Za-z]\d+$/;
const NODE_WORD = /\bNode\b/i;
const SECRET_KEY = /api[_-]?key|token|password|secret/i;
const LITERAL_AUTH = /^(Bearer|Basic)\s+\S/;
const UPSERT = /upsert|createOrUpdate/i;
const MINOR_WORDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "to",
  "the",
]);
/** What a Code node must not do: it runs in n8n, outside our sandbox. */
const CODE_FORBIDDEN: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\bfetch\s*\(/, what: "fetch" },
  { pattern: /\brequire\s*\(/, what: "require" },
  { pattern: /^\s*import\s/m, what: "import" },
  { pattern: /\$env\b/, what: "$env" },
  { pattern: /\bprocess\./, what: "process" },
  { pattern: /\$http\b|XMLHttpRequest|\bhttps?\.request/, what: "HTTP calls" },
];

/** Nodes that only move data inside n8n. */
const CORE_TYPES = new Set(
  [
    "aggregate",
    "code",
    "compareDatasets",
    "dateTime",
    "filter",
    "if",
    "itemLists",
    "limit",
    "merge",
    "noOp",
    "removeDuplicates",
    "renameKeys",
    "set",
    "sort",
    "splitInBatches",
    "splitOut",
    "stopAndError",
    "summarize",
    "switch",
    "wait",
  ].map((name) => `n8n-nodes-base.${name}`)
);

/** Nodes that do one thing and so have no `operation` parameter (all writes). */
const SINGLE_OPERATION_TYPES = new Set([
  "n8n-nodes-base.emailSend",
  "n8n-nodes-base.sendEmail",
]);

const READ_OPERATIONS = new Set([
  "download",
  "get",
  "getAll",
  "getMany",
  "list",
  "search",
]);

/** Recipient field of the nodes allowed as the test preview. */
const PREVIEW_RECIPIENT: Record<string, string> = {
  "n8n-nodes-base.emailSend": "toEmail",
  "n8n-nodes-base.gmail": "sendTo",
  "n8n-nodes-base.microsoftOutlook": "toRecipients",
};

export const isTrigger = (node: N8nNode): boolean =>
  node.type.toLowerCase().endsWith("trigger") || node.type === WEBHOOK_TYPE;

export const isGate = (node: N8nNode): boolean =>
  node.type === IF_TYPE &&
  node.name.startsWith(GATE_PREFIX) &&
  node.name.endsWith("?");

export const isPreview = (node: N8nNode): boolean =>
  node.name.startsWith(PREVIEW_PREFIX);

const valueAt = (
  parameters: Record<string, unknown>,
  dottedPath: string
): unknown => {
  let current: unknown = parameters;
  for (const key of dottedPath.split(".")) {
    if (!isPlainObject(current)) {
      return;
    }
    current = current[key];
  }
  return current;
};

const isTitleCase = (name: string): boolean =>
  name
    .split(" ")
    .every(
      (word) => MINOR_WORDS.has(word) || word[0] === word[0]?.toUpperCase()
    );

/** `Gmail`, `Edit Fields1`, `HTTP Request`: what n8n names a node by itself. */
const looksDefault = (node: N8nNode): boolean => {
  if (GLUED_NUMBER.test(node.name)) {
    return true;
  }
  if (isTrigger(node)) {
    // `Schedule Trigger`, `Error Trigger`: a trigger is named by its kind.
    return false;
  }
  const bare = node.name.replaceAll(" ", "").toLowerCase();
  const typeName = (node.type.split(".").at(-1) ?? "").toLowerCase();
  return bare === typeName;
};

const checkName = (node: N8nNode): Problem[] => {
  const problems: Problem[] = [];
  const add = (message: string): void => {
    problems.push({ message, node: node.name });
  };
  if (looksDefault(node)) {
    add("looks like a default name; say what the node does (Verb + Object)");
  }
  if (NODE_WORD.test(node.name)) {
    add('never put the word "Node" in a name');
  }
  if (!isTitleCase(node.name)) {
    add("use Title Case");
  }
  if (isTrigger(node) && !node.name.endsWith(" Trigger")) {
    add('trigger names end with " Trigger"');
  }
  return problems;
};

const isRead = (node: N8nNode): boolean => {
  if (node.type === HTTP_TYPE) {
    return (node.parameters.method ?? "GET") === "GET";
  }
  if (node.type.startsWith(LANGCHAIN_PREFIX)) {
    return true;
  }
  const { operation } = node.parameters;
  return typeof operation === "string" && READ_OPERATIONS.has(operation);
};

const isSafeInTest = (node: N8nNode): boolean =>
  node.notes?.includes(SAFE_IN_TEST_MARKER) === true;

/** Writes something outside n8n and so needs the `Is Live?` gate. */
export const isGatedWrite = (node: N8nNode): boolean =>
  !(
    CORE_TYPES.has(node.type) ||
    isTrigger(node) ||
    isRead(node) ||
    isPreview(node) ||
    isSafeInTest(node)
  );

const checkRetry = (node: N8nNode): Problem[] => {
  if (isRead(node)) {
    return node.retryOnFail === true
      ? []
      : [{ message: "reads retry: set retryOnFail true", node: node.name }];
  }
  const { operation } = node.parameters;
  const idempotent = typeof operation === "string" && UPSERT.test(operation);
  if (node.retryOnFail === true && !idempotent) {
    return [
      {
        message:
          "never retry a write; a retry can send or create twice (only Create or Update operations may retry)",
        node: node.name,
      },
    ];
  }
  return [];
};

const checkExternalNode = (node: N8nNode): Problem[] => {
  const problems = checkRetry(node);
  const hasOperation =
    node.type === HTTP_TYPE ||
    SINGLE_OPERATION_TYPES.has(node.type) ||
    typeof node.parameters.operation === "string";
  if (!(hasOperation || node.type.startsWith(LANGCHAIN_PREFIX))) {
    problems.push({
      message:
        "set resource and operation explicitly so reads and writes can be told apart",
      node: node.name,
    });
  }
  return problems;
};

const checkErrorSettings = (
  node: N8nNode,
  connections: Record<string, NodeConnections>
): Problem[] => {
  const problems: Problem[] = [];
  if (node.onError === "continueRegularOutput") {
    problems.push({
      message:
        "continueRegularOutput hides failures; use stopWorkflow or continueErrorOutput",
      node: node.name,
    });
  }
  const errorOutput = connections[node.name]?.main?.[1] ?? [];
  if (node.onError === "continueErrorOutput" && errorOutput.length === 0) {
    problems.push({
      message:
        "continueErrorOutput needs its error output wired to Report Failed Item",
      node: node.name,
    });
  }
  const isBranch = node.type === IF_TYPE || node.type === SWITCH_TYPE;
  if (isBranch && node.alwaysOutputData === true) {
    problems.push({
      message: "alwaysOutputData on If/Switch can loop forever",
      node: node.name,
    });
  }
  return problems;
};

const findSecrets = (value: unknown, key = ""): boolean => {
  if (typeof value === "string") {
    const literal = value !== "" && !value.startsWith("=");
    return literal && (SECRET_KEY.test(key) || LITERAL_AUTH.test(value));
  }
  if (Array.isArray(value)) {
    return value.some((item) => findSecrets(item, key));
  }
  if (isPlainObject(value)) {
    // n8n header/query rows look like { name: "Authorization", value: "…" }.
    const rowKey = typeof value.name === "string" ? value.name : key;
    return Object.entries(value).some(([childKey, child]) =>
      findSecrets(child, childKey === "value" ? rowKey : childKey)
    );
  }
  return false;
};

const checkCode = (node: N8nNode): Problem[] => {
  if (node.type !== CODE_TYPE) {
    return [];
  }
  const source = [node.parameters.jsCode, node.parameters.pythonCode]
    .filter((text): text is string => typeof text === "string")
    .join("\n");
  return CODE_FORBIDDEN.filter(({ pattern }) => pattern.test(source)).map(
    ({ what }) => ({
      message: `Code nodes run in n8n, not in our sandbox: no ${what}`,
      node: node.name,
    })
  );
};

const configRow = (node: N8nNode, name: string): unknown => {
  const rows = valueAt(node.parameters, "assignments.assignments");
  if (!Array.isArray(rows)) {
    return;
  }
  const row = rows.find((item) => isPlainObject(item) && item.name === name);
  return isPlainObject(row) ? row.value : undefined;
};

/** `mode` of the `Set Config` node, or `undefined` when there is none. */
export const configMode = (workflow: N8nWorkflow): unknown => {
  const config = workflow.nodes.find((node) => node.name === CONFIG_NODE);
  return config === undefined ? undefined : configRow(config, "mode");
};

const checkConfig = (workflow: N8nWorkflow): Problem[] => {
  const config = workflow.nodes.find((node) => node.name === CONFIG_NODE);
  if (config?.type !== SET_TYPE) {
    return [
      {
        message: `add an Edit Fields node named "${CONFIG_NODE}" right after the triggers`,
      },
    ];
  }
  const problems: Problem[] = [];
  if (configRow(config, "mode") !== "test") {
    problems.push({
      message: 'mode must be "test"; only go-live switches it to live',
      node: CONFIG_NODE,
    });
  }
  if (typeof configRow(config, "testEmail") !== "string") {
    problems.push({
      message: "add a testEmail field (push fills it from n8n/instance.json)",
      node: CONFIG_NODE,
    });
  }
  return problems;
};

const checkTriggers = (workflow: N8nWorkflow): Problem[] => {
  const problems: Problem[] = [];
  const webhooks = workflow.nodes.filter((node) => node.type === WEBHOOK_TYPE);
  const webhook = webhooks.find((node) => node.name === WEBHOOK_TRIGGER);
  if (webhook === undefined || webhooks.length !== 1) {
    problems.push({
      message: `add exactly one Webhook node named "${WEBHOOK_TRIGGER}" (it runs tests and "run now")`,
    });
  } else {
    if (webhook.parameters.authentication !== "headerAuth") {
      problems.push({
        message: 'set authentication to "headerAuth"',
        node: WEBHOOK_TRIGGER,
      });
    }
    if (webhook.disabled === true) {
      problems.push({ message: "never disabled", node: WEBHOOK_TRIGGER });
    }
  }
  for (const trigger of workflow.nodes.filter(isTrigger)) {
    const targets = (workflow.connections[trigger.name]?.main ?? [])
      .flatMap((output) => output ?? [])
      .map((connection) => connection.node);
    if (targets.length === 0 || targets.some((name) => name !== CONFIG_NODE)) {
      problems.push({
        message: `a trigger feeds only "${CONFIG_NODE}"`,
        node: trigger.name,
      });
    }
    if (trigger.type !== WEBHOOK_TYPE && trigger.disabled !== true) {
      problems.push({
        message: "the real trigger stays disabled until go-live",
        node: trigger.name,
      });
    }
  }
  return problems;
};

/** Source node and output index of every connection into `target`. */
const incoming = (
  workflow: N8nWorkflow,
  target: string
): { output: number; source: string }[] => {
  const result: { output: number; source: string }[] = [];
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    (outputs.main ?? []).forEach((connections, output) => {
      if (
        (connections ?? []).some((connection) => connection.node === target)
      ) {
        result.push({ output, source });
      }
    });
  }
  return result;
};

const checkGates = (workflow: N8nWorkflow): Problem[] => {
  const problems: Problem[] = [];
  const byName = new Map(workflow.nodes.map((node) => [node.name, node]));
  for (const node of workflow.nodes.filter(isGatedWrite)) {
    const sources = incoming(workflow, node.name);
    const gated =
      sources.length > 0 &&
      sources.every(({ output, source }) => {
        const sourceNode = byName.get(source);
        return sourceNode !== undefined && isGate(sourceNode) && output === 0;
      });
    if (!gated) {
      problems.push({
        message: `writes outside n8n: put it on the true branch of an "${GATE_PREFIX} …?" If node whose false branch goes to "${PREVIEW_PREFIX}" (or mark the notes "${SAFE_IN_TEST_MARKER} – <reason>" when it reaches no person or shared record)`,
        node: node.name,
      });
    }
  }
  for (const gate of workflow.nodes.filter(isGate)) {
    const condition = JSON.stringify(gate.parameters.conditions ?? "");
    if (!CONFIG_REFERENCE.test(condition)) {
      problems.push({
        message: `compare $('${CONFIG_NODE}').first().json.mode with "live"`,
        node: gate.name,
      });
    }
    const falseBranch = (workflow.connections[gate.name]?.main?.[1] ?? []).map(
      (connection) => byName.get(connection.node)
    );
    if (
      falseBranch.length === 0 ||
      !falseBranch.every((target) => target !== undefined && isPreview(target))
    ) {
      problems.push({
        message: `the false branch must lead only to a "${PREVIEW_PREFIX}" node`,
        node: gate.name,
      });
    }
  }
  for (const preview of workflow.nodes.filter(isPreview)) {
    const field = PREVIEW_RECIPIENT[preview.type];
    if (field === undefined) {
      problems.push({
        message: `the preview is an e-mail node (${Object.keys(PREVIEW_RECIPIENT).join(", ")})`,
        node: preview.name,
      });
      continue;
    }
    const recipient = valueAt(preview.parameters, field);
    if (
      typeof recipient !== "string" ||
      !TEST_EMAIL_REFERENCE.test(recipient)
    ) {
      problems.push({
        message: `${field} must be ={{ $('${CONFIG_NODE}').first().json.testEmail }}`,
        node: preview.name,
      });
    }
    const extra = [
      "options.ccList",
      "options.bccList",
      "options.cc",
      "options.bcc",
    ]
      .map((path) => valueAt(preview.parameters, path))
      .some((value) => typeof value === "string" && value !== "");
    if (extra) {
      problems.push({
        message: "a preview goes to the test address only: no CC or BCC",
        node: preview.name,
      });
    }
  }
  return problems;
};

const checkConnections = (workflow: N8nWorkflow): Problem[] => {
  const names = new Set(workflow.nodes.map((node) => node.name));
  const problems: Problem[] = [];
  for (const [source, outputs] of Object.entries(workflow.connections)) {
    if (!names.has(source)) {
      problems.push({ message: `connection from unknown node "${source}"` });
    }
    for (const connection of (outputs.main ?? []).flatMap(
      (output) => output ?? []
    )) {
      if (!names.has(connection.node)) {
        problems.push({
          message: `connection to unknown node "${connection.node}"`,
          node: source,
        });
      }
    }
  }
  return problems;
};

const parseNode = (data: unknown): N8nNode | undefined => {
  if (
    !(
      isPlainObject(data) &&
      typeof data.name === "string" &&
      typeof data.type === "string"
    )
  ) {
    return;
  }
  return {
    ...data,
    name: data.name,
    parameters: isPlainObject(data.parameters) ? data.parameters : {},
    type: data.type,
  };
};

export const parseWorkflow = (data: unknown): N8nWorkflow | string => {
  if (!(isPlainObject(data) && typeof data.name === "string")) {
    return "workflow needs a name";
  }
  if (!(Array.isArray(data.nodes) && isPlainObject(data.connections))) {
    return "workflow needs nodes and connections";
  }
  const nodes = data.nodes.map(parseNode);
  if (nodes.some((node) => node === undefined)) {
    return "every node needs a name and a type";
  }
  const names = nodes.map((node) => node?.name);
  if (new Set(names).size !== names.length) {
    return "node names must be unique";
  }
  return {
    connections: data.connections as Record<string, NodeConnections>,
    name: data.name,
    nodes: nodes.filter((node) => node !== undefined),
    settings: isPlainObject(data.settings) ? data.settings : {},
  };
};

export const isErrorHandler = (workflow: N8nWorkflow): boolean =>
  workflow.nodes.some((node) => node.type === ERROR_TRIGGER_TYPE);

/** Every rule violation in the workflow; empty means it may be pushed. */
export const checkWorkflow = (data: unknown): Problem[] => {
  const workflow = parseWorkflow(data);
  if (typeof workflow === "string") {
    return [{ message: workflow }];
  }
  const errorHandler = isErrorHandler(workflow);
  const problems: Problem[] = [];
  if (!isTitleCase(workflow.name)) {
    problems.push({ message: "workflow name uses Title Case" });
  }
  problems.push(...checkConnections(workflow));
  if (!errorHandler) {
    if (typeof workflow.settings.errorWorkflow !== "string") {
      problems.push({
        message:
          "set settings.errorWorkflow to the Error Handler (push fills it)",
      });
    }
    problems.push(...checkConfig(workflow));
    problems.push(...checkTriggers(workflow));
    problems.push(...checkGates(workflow));
  }
  for (const node of workflow.nodes) {
    problems.push(...checkName(node));
    problems.push(...checkErrorSettings(node, workflow.connections));
    problems.push(...checkCode(node));
    if (findSecrets(node.parameters)) {
      problems.push({
        message: "secret in parameters; use a credential",
        node: node.name,
      });
    }
    if (!(CORE_TYPES.has(node.type) || isTrigger(node))) {
      problems.push(...checkExternalNode(node));
    }
  }
  return problems;
};
