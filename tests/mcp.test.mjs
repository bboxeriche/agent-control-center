import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { defaultConfig, readAuthToken } from "../server/core.mjs";

const root = process.cwd();
const mcpPath = join(root, "server", "mcp-server.mjs");
const fixture = join(root, "tests", "fixtures", "fake-agent.mjs");

function configForMcp() {
  const config = defaultConfig();
  for (const agent of Object.keys(config.agents)) {
    config.agents[agent] = { ...config.agents[agent], command: process.execPath, args: [fixture, "-p", "{prompt}"] };
  }
  return config;
}

function nextResponse(child, id) {
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      if (!line.trim()) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== id) return;
      cleanup();
      resolve(message);
    };
    const onExit = () => { cleanup(); reject(new Error("MCP process exited before response")); };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        onLine(line);
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("speaks MCP over stdio and exposes the control tools", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-mcp-"));
  const configPath = join(dataDir, "config.json");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = configForMcp();
  config.port = port;
  await writeFile(configPath, JSON.stringify(config), "utf8");
  const child = spawn(process.execPath, [mcpPath], {
    cwd: root,
    env: { ...process.env, AGENT_CONTROL_DATA_DIR: dataDir, AGENT_CONTROL_CONFIG: configPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = createInterface({ input: child.stderr });
  stderr.on("line", () => {});
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    const initialized = await nextResponse(child, 1);
    assert.equal(initialized.result.serverInfo.name, "agent-control-center");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const listed = await nextResponse(child, 2);
    assert.ok(listed.result.tools.some((tool) => tool.name === "acc_task_create"));
    assert.ok(listed.result.tools.some((tool) => tool.name === "acc_task_wait"));
    assert.ok(listed.result.tools.some((tool) => tool.name === "acc_task_events" && tool.inputSchema.properties.afterCursor));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "acc_task_create", arguments: { agent: "claude-code", prompt: "smoke", cwd: root } } })}\n`);
    const called = await nextResponse(child, 3);
    assert.equal(called.result.isError, undefined);
    const created = JSON.parse(called.result.content[0].text);
    assert.match(created.task.id, /^task_/);
    const authToken = readAuthToken(dataDir);
    const devspaceView = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(created.task.id)}`, {
      headers: { authorization: `Bearer ${authToken}` },
    }).then((response) => response.json());
    assert.equal(devspaceView.task.id, created.task.id);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "acc_task_wait", arguments: { taskId: created.task.id, timeoutMs: 1000 } } })}\n`);
    const waited = await nextResponse(child, 4);
    assert.equal(waited.result.isError, undefined);
    assert.equal(JSON.parse(waited.result.content[0].text).task.id, created.task.id);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(created.task.id)}`, {
        headers: { authorization: `Bearer ${authToken}` },
      }).then((response) => response.json());
      if (["succeeded", "failed", "stopped", "timed_out", "interrupted"].includes(current.task.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const beforeFollowUp = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(created.task.id)}`, {
      headers: { authorization: `Bearer ${authToken}` },
    }).then((response) => response.json());
    const devspaceFollowUp = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(created.task.id)}/reply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        "x-agent-control-origin": "devspace",
        "x-agent-control-request-id": "mcp-http-follow-up-001",
      },
      body: JSON.stringify({ prompt: "cross-client follow-up" }),
    }).then((response) => response.json());
    assert.equal(devspaceFollowUp.task.id, created.task.id);
    assert.equal(devspaceFollowUp.task.attemptNo, 2);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "acc_task_get", arguments: { taskId: created.task.id } } })}\n`);
    const afterFollowUp = await nextResponse(child, 5);
    const followUpView = JSON.parse(afterFollowUp.result.content[0].text);
    assert.equal(followUpView.task.id, created.task.id);
    assert.equal(followUpView.task.attemptNo, 2);
    assert.ok(followUpView.task.eventCursor > beforeFollowUp.task.eventCursor);
    const health = await fetch(`http://127.0.0.1:${port}/api/healthz`).then((response) => response.json());
    process.kill(health.pid, "SIGTERM");
  } finally {
    try {
      const healthResponse = await fetch(`${baseUrl}/api/healthz`);
      if (healthResponse.ok) {
        const health = await healthResponse.json();
        process.kill(health.pid, "SIGTERM");
      }
    } catch {}
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    stderr.close();
  }
});
