import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { DEFAULT_HOST, DEFAULT_PORT, SERVICE_VERSION, SUPPORTED_ORIGINS, loadConfig, readAuthToken, resolveDataDir } from "./core.mjs";

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const servicePath = fileURLToPath(new URL("./service.mjs", import.meta.url));
const dataDir = resolveDataDir();
const configured = loadConfig(dataDir).config;
const host = process.env.AGENT_CONTROL_HOST || configured.host || DEFAULT_HOST;
const port = Number(process.env.AGENT_CONTROL_PORT || configured.port || DEFAULT_PORT);
const baseUrl = `http://${host}:${port}`;
let serviceStartPromise;

async function healthy() {
  try {
    const response = await fetch(`${baseUrl}/api/healthz`, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureService() {
  if (await healthy()) return;
  if (!serviceStartPromise) {
    serviceStartPromise = (async () => {
      const child = spawn(process.execPath, [servicePath], {
        cwd: pluginRoot,
        env: { ...process.env, AGENT_CONTROL_HOST: host, AGENT_CONTROL_PORT: String(port) },
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (await healthy()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Agent Control Center did not become healthy at ${baseUrl}`);
    })().finally(() => {
      serviceStartPromise = null;
    });
  }
  return serviceStartPromise;
}

async function api(path, options = {}) {
  await ensureService();
  const authToken = readAuthToken(dataDir);
  if (!authToken) throw new Error("Agent Control Center authentication token is unavailable");
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${authToken}`, ...(options.headers || {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { text };
  }
  if (!response.ok) {
    throw new Error(payload.error || `Agent Control Center HTTP ${response.status}`);
  }
  return payload;
}

const tools = [
  {
    name: "acc_health",
    description: "Check the local Agent Control Center service and all configured provider CLIs or HTTP endpoints.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "acc_agents",
    description: "List configured coding agents and their current availability.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "acc_task_create",
    description: "Queue one task for a registered local coding agent. The agent is selected from the allowlisted configuration.",
    inputSchema: {
      type: "object",
      required: ["agent", "prompt"],
      properties: {
        agent: { type: "string", enum: ["antigravity", "claude-code", "codex-cli", "tencent-workbuddy"] },
        prompt: { type: "string", minLength: 1 },
        cwd: { type: "string", description: "Absolute repository working directory." },
        model: { type: "string", description: "Provider-specific model identifier passed literally to --model; examples on this host are gpt-5.6-luna, hy4-preview, or gemini-3.8-flash-high." },
        timeoutMs: { type: "integer", minimum: 1000 },
        origin: { type: "string", enum: SUPPORTED_ORIGINS },
        originRequestId: { type: "string" },
        idempotencyKey: { type: "string" },
        permissionPolicy: {
          type: "object",
          properties: {
            project: { type: "string" },
            repo: { type: "string" },
            worktree: { type: "string" },
            filesystemScope: { oneOf: [{ type: "string", enum: ["cwd"] }, { type: "array", items: { type: "string" } }] },
            writeAllowed: { type: "boolean" },
            networkAllowed: { type: "boolean" },
            approvalPolicy: { type: "string", enum: ["provider_default", "require_approval", "deny_unapproved"] },
          },
          additionalProperties: false,
        },
        metadata: { type: "object" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "acc_task_list",
    description: "List recent local agent tasks with status and provider session references.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 } }, additionalProperties: false },
  },
  {
    name: "acc_task_get",
    description: "Get one task, including its result, error, session ID, and durable event references.",
    inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "acc_task_events",
    description: "Read a durable page of one task's append-only event stream. Continue with nextCursor.",
    inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" }, afterCursor: { type: "integer", minimum: 0 }, after: { type: "integer", minimum: 0, description: "Deprecated alias for afterCursor." }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false },
  },
  {
    name: "acc_task_wait",
    description: "Wait for a bounded interval until a task changes or finishes, then return its durable events and cursor.",
    inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" }, timeoutMs: { type: "integer", minimum: 1000, maximum: 60000 }, afterCursor: { type: "integer", minimum: 0 } }, additionalProperties: false },
  },
  {
    name: "acc_task_stop",
    description: "Stop a queued or running local agent task.",
    inputSchema: { type: "object", required: ["taskId"], properties: { taskId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "acc_task_reply",
    description: "Send a follow-up to a running provider session when supported, or queue another attempt on the same durable task ID after completion.",
    inputSchema: { type: "object", required: ["taskId", "prompt"], properties: { taskId: { type: "string" }, prompt: { type: "string", minLength: 1 }, origin: { type: "string", enum: SUPPORTED_ORIGINS }, originRequestId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "acc_discussion_create",
    description: "Start a multi-agent discussion. Agents work in sequential rounds; each later round receives bounded responses from the previous round.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", minLength: 1 },
        agents: { type: "array", items: { type: "string", enum: ["antigravity", "claude-code", "codex-cli", "tencent-workbuddy"] } },
        cwd: { type: "string", description: "Absolute repository working directory." },
        rounds: { type: "integer", minimum: 1, maximum: 3 },
        origin: { type: "string", enum: SUPPORTED_ORIGINS },
        originRequestId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "acc_discussion_list",
    description: "List recent discussions and their status.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
  },
  {
    name: "acc_discussion_get",
    description: "Get a discussion with all participating tasks and responses.",
    inputSchema: { type: "object", required: ["discussionId"], properties: { discussionId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "acc_discussion_events",
    description: "Read the durable event stream for one discussion.",
    inputSchema: { type: "object", required: ["discussionId"], properties: { discussionId: { type: "string" }, afterCursor: { type: "integer", minimum: 0 }, after: { type: "integer", minimum: 0, description: "Deprecated alias for afterCursor." }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, additionalProperties: false },
  },
  {
    name: "acc_discussion_stop",
    description: "Stop all controllable tasks belonging to a discussion.",
    inputSchema: { type: "object", required: ["discussionId"], properties: { discussionId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "acc_minutes_generate",
    description: "Generate and persist traceable Markdown minutes for a discussion.",
    inputSchema: { type: "object", required: ["discussionId"], properties: { discussionId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "acc_minutes_get",
    description: "Read the latest minutes for a discussion or a specific minutes record.",
    inputSchema: { type: "object", properties: { discussionId: { type: "string" }, minutesId: { type: "string" } }, additionalProperties: false },
  },
  {
    name: "acc_dashboard",
    description: "Return the local dashboard URL for visual task monitoring.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function result(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

async function callTool(name, args = {}) {
  switch (name) {
    case "acc_health":
    case "acc_agents":
      return api("/api/agents");
    case "acc_task_create":
      return api("/api/tasks", { method: "POST", body: { ...args, origin: args.origin || "codex" } });
    case "acc_task_list":
      return api(`/api/tasks?limit=${encodeURIComponent(args.limit || 50)}`);
    case "acc_task_get":
      return api(`/api/tasks/${encodeURIComponent(args.taskId)}`);
    case "acc_task_events":
      {
        const afterCursor = args.afterCursor ?? args.after ?? 0;
        const limit = args.limit ? `&limit=${encodeURIComponent(args.limit)}` : "";
        return api(`/api/tasks/${encodeURIComponent(args.taskId)}/events?afterCursor=${encodeURIComponent(afterCursor)}${limit}`);
      }
    case "acc_task_wait":
      {
        const params = new URLSearchParams();
        if (args.timeoutMs !== undefined) params.set("timeoutMs", String(args.timeoutMs));
        if (args.afterCursor !== undefined) params.set("afterCursor", String(args.afterCursor));
        return api(`/api/tasks/${encodeURIComponent(args.taskId)}/wait?${params.toString()}`);
      }
    case "acc_task_stop":
      return api(`/api/tasks/${encodeURIComponent(args.taskId)}/stop`, { method: "POST", body: {} });
    case "acc_task_reply":
      return api(`/api/tasks/${encodeURIComponent(args.taskId)}/reply`, { method: "POST", body: { prompt: args.prompt, origin: args.origin || "codex", originRequestId: args.originRequestId } });
    case "acc_discussion_create":
      return api("/api/discussions", { method: "POST", body: { ...args, origin: args.origin || "codex" } });
    case "acc_discussion_list":
      return api(`/api/discussions?limit=${encodeURIComponent(args.limit || 50)}`);
    case "acc_discussion_get":
      return api(`/api/discussions/${encodeURIComponent(args.discussionId)}`);
    case "acc_discussion_events":
      {
        const afterCursor = args.afterCursor ?? args.after ?? 0;
        const limit = args.limit ? `&limit=${encodeURIComponent(args.limit)}` : "";
        return api(`/api/discussions/${encodeURIComponent(args.discussionId)}/events?afterCursor=${encodeURIComponent(afterCursor)}${limit}`);
      }
    case "acc_discussion_stop":
      return api(`/api/discussions/${encodeURIComponent(args.discussionId)}/stop`, { method: "POST", body: {} });
    case "acc_minutes_generate":
      return api(`/api/discussions/${encodeURIComponent(args.discussionId)}/minutes`, { method: "POST", body: {} });
    case "acc_minutes_get":
      if (args.minutesId) return api(`/api/minutes/${encodeURIComponent(args.minutesId)}`);
      if (args.discussionId) return api(`/api/discussions/${encodeURIComponent(args.discussionId)}/minutes`);
      throw new Error("discussionId or minutesId is required");
    case "acc_dashboard":
      await ensureService();
      return { url: `${baseUrl}/`, host, port };
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handle(message) {
  const id = message.id;
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return null;
  if (message.method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-control-center", version: SERVICE_VERSION },
        instructions: "Use Agent Control Center tools for registered local coding agents. Provider output and minutes are persisted on the host.",
      },
    };
  }
  if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools } };
  if (message.method === "tools/call") {
    try {
      const payload = await callTool(message.params?.name, message.params?.arguments || {});
      return { jsonrpc: "2.0", id, result: result(payload) };
    } catch (error) {
      return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: error.message }] } };
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${message.method}` } };
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("Agent Control Center received invalid JSON-RPC input\n");
    continue;
  }
  const response = await handle(message);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}
