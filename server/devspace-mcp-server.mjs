import { createInterface } from "node:readline";
import { SERVICE_VERSION } from "./core.mjs";
import { createDevSpaceClient, DEVSPACE_TOOLS } from "./devspace-client.mjs";

const client = createDevSpaceClient();

function result(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
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
        serverInfo: { name: "agent-control-center-devspace", version: SERVICE_VERSION },
        instructions: "Controlled DevSpace client for Agent Control Center. Authentication and origin are managed locally; use taskId and durable cursors for recovery.",
      },
    };
  }
  if (message.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: DEVSPACE_TOOLS } };
  if (message.method === "tools/call") {
    try {
      const payload = await client.call(message.params?.name, message.params?.arguments || {});
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
  try { message = JSON.parse(line); } catch { process.stderr.write("DevSpace ACC adapter received invalid JSON-RPC input\n"); continue; }
  const response = await handle(message);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
}
