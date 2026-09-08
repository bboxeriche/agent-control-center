import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { DEFAULT_HOST, DEFAULT_PORT, loadConfig, readAuthToken, resolveDataDir } from "./core.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const servicePath = fileURLToPath(new URL("./service.mjs", import.meta.url));

function requestId(value) {
  const text = String(value ?? "").trim();
  return text || `devspace-${randomUUID()}`;
}

function idempotencyKey(value) {
  const text = String(value ?? "").trim();
  return text || `devspace-${randomUUID()}`;
}

function safeErrorMessage(payload, status, authToken) {
  const raw = payload?.error || payload?.text || `Agent Control Center HTTP ${status}`;
  return String(raw).replaceAll(authToken, "[REDACTED]");
}

export const DEVSPACE_TOOLS = [
  { name: "acc_health", description: "Check the local Agent Control Center service and configured agents.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "acc_agents", description: "List configured local agents and availability.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "acc_task_create",
    description: "Create one least-privilege local agent task. The adapter forces origin=devspace and keeps authentication local.",
    inputSchema: {
      type: "object",
      required: ["agent", "prompt"],
      properties: {
        agent: { type: "string", enum: ["antigravity", "claude-code", "codex-cli", "tencent-workbuddy"] },
        prompt: { type: "string", minLength: 1 },
        cwd: { type: "string", description: "Absolute repository working directory inside ACC allowed roots." },
        model: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000 },
        originRequestId: { type: "string" },
        idempotencyKey: { type: "string", description: "Stable key for retrying this exact create request." },
        permissionPolicy: { type: "object", additionalProperties: false },
        metadata: { type: "object", additionalProperties: false },
      },
      additionalProperties: false,
    },
  },
  { name: "acc_task_list", description: "List recent local agent tasks.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } }, additionalProperties: false } },
  { name: "acc_task_get", description: "Get one durable task by taskId.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } }, additionalProperties: false } },
  { name: "acc_task_wait", description: "Wait for a bounded task update and return durable events.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" }, timeoutMs: { type: "integer", minimum: 1000, maximum: 60000 }, afterCursor: { type: "integer", minimum: 0 } }, additionalProperties: false } },
  { name: "acc_task_events", description: "Read durable task events after a cursor.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" }, afterCursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false } },
  { name: "acc_task_reply", description: "Send a follow-up while preserving the same durable taskId.", inputSchema: { type: "object", required: ["taskId", "prompt"], properties: { taskId: { type: "string" }, prompt: { type: "string", minLength: 1 }, originRequestId: { type: "string" }, idempotencyKey: { type: "string" } }, additionalProperties: false } },
  { name: "acc_task_stop", description: "Stop a queued or running task.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } }, additionalProperties: false } },
  {
    name: "acc_discussion_create",
    description: "Create a bounded multi-agent discussion with origin forced to devspace.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1 },
        agents: { type: "array", items: { type: "string", enum: ["antigravity", "claude-code", "codex-cli", "tencent-workbuddy"] } },
        cwd: { type: "string" },
        rounds: { type: "integer", minimum: 1, maximum: 3 },
        originRequestId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  { name: "acc_discussion_get", description: "Get one discussion and its task records.", inputSchema: { type: "object", required: ["discussionId"], properties: { discussionId: { type: "string" } }, additionalProperties: false } },
  { name: "acc_discussion_events", description: "Read durable discussion events after a cursor.", inputSchema: { type: "object", required: ["discussionId"], properties: { discussionId: { type: "string" }, afterCursor: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false } },
  { name: "acc_minutes_generate", description: "Generate and persist traceable Markdown minutes.", inputSchema: { type: "object", required: ["discussionId"], properties: { discussionId: { type: "string" } }, additionalProperties: false } },
];

export function createDevSpaceClient({
  dataDir = resolveDataDir(),
  host,
  port,
  baseUrl,
  fetchImpl = fetch,
  ensureServiceImpl = null,
} = {}) {
  const configured = loadConfig(dataDir).config;
  const serviceHost = host || process.env.AGENT_CONTROL_HOST || configured.host || DEFAULT_HOST;
  const servicePort = Number(port || process.env.AGENT_CONTROL_PORT || configured.port || DEFAULT_PORT);
  const serviceBaseUrl = baseUrl || `http://${serviceHost}:${servicePort}`;
  let serviceStartPromise;

  async function healthy() {
    try {
      const response = await fetchImpl(`${serviceBaseUrl}/api/healthz`, { signal: AbortSignal.timeout(1200) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function ensureService() {
    if (ensureServiceImpl) return ensureServiceImpl();
    if (await healthy()) return;
    if (!serviceStartPromise) {
      serviceStartPromise = (async () => {
        const child = spawn(process.execPath, [servicePath], {
          cwd: pluginRoot,
          env: { ...process.env, AGENT_CONTROL_DATA_DIR: dataDir, AGENT_CONTROL_HOST: serviceHost, AGENT_CONTROL_PORT: String(servicePort) },
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        for (let attempt = 0; attempt < 50; attempt += 1) {
          if (await healthy()) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`Agent Control Center did not become healthy at ${serviceBaseUrl}`);
      })().finally(() => { serviceStartPromise = null; });
    }
    return serviceStartPromise;
  }

  async function api(path, options = {}) {
    await ensureService();
    const authToken = readAuthToken(dataDir);
    if (!authToken) throw new Error("Agent Control Center authentication token is unavailable");
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${authToken}`,
      "x-agent-control-origin": "devspace",
      "x-agent-control-request-id": requestId(options.originRequestId),
      "idempotency-key": idempotencyKey(options.idempotencyKey),
      ...(options.headers || {}),
    };
    const response = await fetchImpl(`${serviceBaseUrl}${path}`, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text }; }
    if (!response.ok) {
      const error = new Error(safeErrorMessage(payload, response.status, authToken));
      error.statusCode = response.status;
      throw error;
    }
    return payload;
  }

  async function call(name, args = {}) {
    switch (name) {
      case "acc_health":
        return {
          service: await api("/api/healthz", { originRequestId: args.originRequestId }),
          agents: await api("/api/agents", { originRequestId: args.originRequestId }),
        };
      case "acc_agents":
        return api("/api/agents", { originRequestId: args.originRequestId });
      case "acc_task_create": {
        const { origin, ...body } = args;
        return api("/api/tasks", { method: "POST", body: { ...body, origin: "devspace" }, originRequestId: args.originRequestId, idempotencyKey: args.idempotencyKey });
      }
      case "acc_task_list":
        return api(`/api/tasks?limit=${encodeURIComponent(args.limit || 50)}`, { originRequestId: args.originRequestId });
      case "acc_task_get":
        return api(`/api/tasks/${encodeURIComponent(args.taskId)}`, { originRequestId: args.originRequestId });
      case "acc_task_wait": {
        const params = new URLSearchParams();
        if (args.timeoutMs !== undefined) params.set("timeoutMs", String(args.timeoutMs));
        if (args.afterCursor !== undefined) params.set("afterCursor", String(args.afterCursor));
        return api(`/api/tasks/${encodeURIComponent(args.taskId)}/wait?${params}`, { originRequestId: args.originRequestId });
      }
      case "acc_task_events": {
        const params = new URLSearchParams({ afterCursor: String(args.afterCursor ?? 0) });
        if (args.limit !== undefined) params.set("limit", String(args.limit));
        return api(`/api/tasks/${encodeURIComponent(args.taskId)}/events?${params}`, { originRequestId: args.originRequestId });
      }
      case "acc_task_reply": {
        const { origin, ...body } = args;
        return api(`/api/tasks/${encodeURIComponent(args.taskId)}/reply`, { method: "POST", body: { prompt: body.prompt }, originRequestId: args.originRequestId, idempotencyKey: args.idempotencyKey });
      }
      case "acc_task_stop":
        return api(`/api/tasks/${encodeURIComponent(args.taskId)}/stop`, { method: "POST", body: {}, originRequestId: args.originRequestId });
      case "acc_discussion_create": {
        const { origin, ...body } = args;
        return api("/api/discussions", { method: "POST", body: { ...body, origin: "devspace" }, originRequestId: args.originRequestId, idempotencyKey: args.idempotencyKey });
      }
      case "acc_discussion_get":
        return api(`/api/discussions/${encodeURIComponent(args.discussionId)}`, { originRequestId: args.originRequestId });
      case "acc_discussion_events": {
        const params = new URLSearchParams({ afterCursor: String(args.afterCursor ?? 0) });
        if (args.limit !== undefined) params.set("limit", String(args.limit));
        return api(`/api/discussions/${encodeURIComponent(args.discussionId)}/events?${params}`, { originRequestId: args.originRequestId });
      }
      case "acc_minutes_generate":
        return api(`/api/discussions/${encodeURIComponent(args.discussionId)}/minutes`, { method: "POST", body: {}, originRequestId: args.originRequestId });
      default:
        throw new Error(`unknown DevSpace tool: ${name}`);
    }
  }

  return { call, healthy, baseUrl: serviceBaseUrl };
}
