import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureAuthToken, readAuthToken } from "../server/core.mjs";
import { DEVSPACE_TOOLS, createDevSpaceClient } from "../server/devspace-client.mjs";

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

test("DevSpace adapter injects local auth, fixed origin, request ID, and idempotency", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-devspace-client-"));
  ensureAuthToken(dataDir);
  const calls = [];
  const client = createDevSpaceClient({
    dataDir,
    baseUrl: "http://127.0.0.1:47770",
    ensureServiceImpl: async () => {},
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return response(202, { task: { id: "task_devspace_001", origin: "devspace" }, reused: false });
    },
  });
  const payload = await client.call("acc_task_create", {
    agent: "tencent-workbuddy",
    prompt: "safe read-only check",
    cwd: "/workspace/project",
    origin: "codex",
    originRequestId: "leader-request-001",
    idempotencyKey: "leader-create-001",
  });
  assert.equal(payload.task.origin, "devspace");
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.options.headers.authorization.startsWith("Bearer "), true);
  assert.equal(call.options.headers["x-agent-control-origin"], "devspace");
  assert.equal(call.options.headers["x-agent-control-request-id"], "leader-request-001");
  assert.equal(call.options.headers["idempotency-key"], "leader-create-001");
  assert.equal(JSON.parse(call.options.body).origin, "devspace");
  assert.equal(JSON.stringify(payload).includes(call.options.headers.authorization.slice(7)), false);
});

test("DevSpace adapter exposes only the approved semantic tool surface", () => {
  const names = DEVSPACE_TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, [
    "acc_health",
    "acc_agents",
    "acc_task_create",
    "acc_task_list",
    "acc_task_get",
    "acc_task_wait",
    "acc_task_events",
    "acc_task_reply",
    "acc_task_stop",
    "acc_discussion_create",
    "acc_discussion_get",
    "acc_discussion_events",
    "acc_minutes_generate",
  ]);
  assert.equal(DEVSPACE_TOOLS.some((tool) => JSON.stringify(tool).includes("authToken")), false);
  assert.equal(DEVSPACE_TOOLS.some((tool) => tool.inputSchema?.properties?.origin), false);
});

test("DevSpace adapter redacts the local token from errors", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-devspace-error-"));
  ensureAuthToken(dataDir);
  const token = readAuthToken(dataDir);
  const client = createDevSpaceClient({
    dataDir,
    baseUrl: "http://127.0.0.1:47770",
    ensureServiceImpl: async () => {},
    fetchImpl: async () => response(401, { error: `Bearer ${await import("node:fs/promises").then(({ readFile }) => readFile(join(dataDir, "auth.token"), "utf8"))}` }),
  });
  await assert.rejects(() => client.call("acc_agents"), (error) => {
    assert.equal(error.message.includes(token), false);
    return true;
  });
});
