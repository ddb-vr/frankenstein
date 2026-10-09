// Thin client of the n8n public API (`/api/v1`) and of workflow webhooks.
// Reads nothing from disk; `clientFromEnv` takes the URL and key from the
// environment loaded by `scripts/n8n.ts`. The key is never logged.

import { loadDotEnv, requireEnvVars } from "./env.ts";
import { isPlainObject } from "./examples.ts";
import { type ExecutionSummary, summarizeExecution } from "./n8n-workflow.ts";

export const N8N_ENV = ["N8N_BASE_URL", "N8N_API_KEY"] as const;

export interface Credential {
  id: string;
  name: string;
  type: string;
}

export interface Execution {
  id: string;
  status: string;
  [key: string]: unknown;
}

export class N8nApiError extends Error {
  readonly status: number;
  constructor(method: string, route: string, status: number, body: string) {
    super(`${method} ${route} -> ${status}: ${body.slice(0, 500)}`);
    this.status = status;
  }
}

const PAGE_LIMIT = 100;
const TRAILING_SLASHES = /\/+$/;

export class N8nClient {
  readonly baseUrl: string;
  readonly #apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(TRAILING_SLASHES, "");
    this.#apiKey = apiKey;
  }

  async request(
    method: string,
    route: string,
    body?: unknown
  ): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}/api/v1${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        accept: "application/json",
        "X-N8N-API-KEY": this.#apiKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      method,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new N8nApiError(method, route, response.status, text);
    }
    return text ? JSON.parse(text) : null;
  }

  async #list(route: string): Promise<unknown[]> {
    const items: unknown[] = [];
    let cursor: string | undefined;
    do {
      const separator = route.includes("?") ? "&" : "?";
      // biome-ignore lint/performance/noAwaitInLoops: each page's cursor comes from the previous page.
      const page = (await this.request(
        "GET",
        `${route}${separator}limit=${PAGE_LIMIT}${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`
      )) as { data?: unknown[]; nextCursor?: string | null };
      items.push(...(page.data ?? []));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return items;
  }

  async ping(): Promise<void> {
    await this.request("GET", "/workflows?limit=1");
  }

  // Credentials

  async listCredentials(): Promise<Credential[]> {
    const items = await this.#list("/credentials");
    return items.filter(isPlainObject).map((item) => ({
      id: String(item.id),
      name: String(item.name),
      type: String(item.type),
    }));
  }

  async createCredential(
    name: string,
    type: string,
    data: Record<string, unknown>
  ): Promise<Credential> {
    const created = (await this.request("POST", "/credentials", {
      data,
      name,
      type,
    })) as Record<string, unknown>;
    return { id: String(created.id), name: String(created.name), type };
  }

  async credentialSchema(type: string): Promise<unknown> {
    return await this.request("GET", `/credentials/schema/${type}`);
  }

  /** `{ status: "OK" | "Error", message }` of `POST /credentials/{id}/test`. */
  async testCredential(
    id: string
  ): Promise<{ message: string; status: string }> {
    const result = (await this.request(
      "POST",
      `/credentials/${id}/test`
    )) as Record<string, unknown>;
    return {
      message: String(result.message ?? ""),
      status: String(result.status ?? "Error"),
    };
  }

  credentialUrl(id: string): string {
    return `${this.baseUrl}/home/credentials/${id}`;
  }

  // Workflows

  async getWorkflow(id: string): Promise<Record<string, unknown>> {
    return (await this.request("GET", `/workflows/${id}`)) as Record<
      string,
      unknown
    >;
  }

  async createWorkflow(
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return (await this.request("POST", "/workflows", body)) as Record<
      string,
      unknown
    >;
  }

  async updateWorkflow(
    id: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return (await this.request("PUT", `/workflows/${id}`, body)) as Record<
      string,
      unknown
    >;
  }

  /** n8n 2 publishes; older instances only know the deprecated activate. */
  async publishWorkflow(id: string): Promise<void> {
    try {
      await this.request("POST", `/workflows/${id}/publish`, {});
    } catch (error) {
      if (error instanceof N8nApiError && error.status === 404) {
        await this.request("POST", `/workflows/${id}/activate`);
        return;
      }
      throw error;
    }
  }

  async unpublishWorkflow(id: string): Promise<void> {
    try {
      await this.request("POST", `/workflows/${id}/unpublish`, {});
    } catch (error) {
      if (error instanceof N8nApiError && error.status === 404) {
        await this.request("POST", `/workflows/${id}/deactivate`);
        return;
      }
      throw error;
    }
  }

  workflowUrl(id: string): string {
    return `${this.baseUrl}/workflow/${id}`;
  }

  // Tags

  async tagId(name: string): Promise<string> {
    const tags = await this.#list("/tags");
    const existing = tags
      .filter(isPlainObject)
      .find((tag) => tag.name === name);
    if (existing !== undefined) {
      return String(existing.id);
    }
    const created = (await this.request("POST", "/tags", { name })) as Record<
      string,
      unknown
    >;
    return String(created.id);
  }

  async setWorkflowTags(workflowId: string, tagIds: string[]): Promise<void> {
    await this.request(
      "PUT",
      `/workflows/${workflowId}/tags`,
      tagIds.map((id) => ({ id }))
    );
  }

  // Executions

  async listExecutions(query: {
    limit?: number;
    startedAfter?: Date;
    workflowId: string;
  }): Promise<Execution[]> {
    const params = new URLSearchParams({
      limit: String(query.limit ?? 10),
      workflowId: query.workflowId,
    });
    if (query.startedAfter !== undefined) {
      params.set("startedAfter", query.startedAfter.toISOString());
    }
    const page = (await this.request(
      "GET",
      `/executions?${params.toString()}`
    )) as { data?: unknown[] };
    return (page.data ?? []).filter(isPlainObject).map((item) => ({
      ...item,
      id: String(item.id),
      status: String(item.status ?? "unknown"),
    }));
  }

  async getExecution(id: string): Promise<unknown> {
    return await this.request("GET", `/executions/${id}?includeData=true`);
  }

  executionUrl(workflowId: string, executionId: string): string {
    return `${this.baseUrl}/workflow/${workflowId}/executions/${executionId}`;
  }

  // Webhooks

  /** Posts `body` to the production webhook; resolves to the HTTP status. */
  async triggerWebhook(
    path: string,
    headerName: string,
    secret: string,
    body: unknown
  ): Promise<{ status: number; text: string }> {
    const response = await fetch(`${this.baseUrl}/webhook/${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", [headerName]: secret },
      method: "POST",
    });
    return { status: response.status, text: await response.text() };
  }
}

// ---------------------------------------------------------------------------
// Run and wait

const POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120_000;
const FINAL_STATUSES = new Set(["canceled", "crashed", "error", "success"]);

export interface RunOptions {
  headerName: string;
  input: unknown;
  secret: string;
  timeoutMs?: number;
  webhookPath: string;
  workflowId: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Triggers the workflow through its Webhook Trigger and waits for the
 * execution to finish (or `timeoutMs`); resolves to its summary.
 */
export const runWorkflow = async (
  client: N8nClient,
  options: RunOptions
): Promise<ExecutionSummary & { timedOut: boolean }> => {
  const startedAfter = new Date(Date.now() - POLL_MS);
  const response = await client.triggerWebhook(
    options.webhookPath,
    options.headerName,
    options.secret,
    options.input
  );
  if (response.status >= 400) {
    throw new Error(
      `webhook ${options.webhookPath} answered ${response.status}: ${response.text.slice(0, 300)} (is the workflow published and the Webhook Trigger wired to the instance credential?)`
    );
  }
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let execution: Execution | undefined;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: polling until the execution finishes.
    const [latest] = await client.listExecutions({
      limit: 1,
      startedAfter,
      workflowId: options.workflowId,
    });
    if (latest !== undefined && FINAL_STATUSES.has(latest.status)) {
      execution = latest;
      break;
    }
    await sleep(POLL_MS);
  }
  if (execution === undefined) {
    return { id: "", nodes: {}, status: "running", timedOut: true };
  }
  return {
    ...summarizeExecution(await client.getExecution(execution.id)),
    timedOut: false,
  };
};

/** Client from `.env` (`N8N_BASE_URL`, `N8N_API_KEY`). */
export const clientFromEnv = (): N8nClient => {
  loadDotEnv();
  requireEnvVars(N8N_ENV);
  return new N8nClient(
    process.env.N8N_BASE_URL ?? "",
    process.env.N8N_API_KEY ?? ""
  );
};
