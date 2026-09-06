import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../server/core.mjs";
import { ControlPlane } from "../server/service.mjs";

async function waitForTask(plane, id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = plane.getTask(id);
    if (["succeeded", "failed", "stopped", "timed_out", "interrupted"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("WorkBuddy test task timed out");
}

test("uses the WorkBuddy HTTP jobs and SSE contract when configured", async () => {
  let jobId = "job-001";
  const requests = [];
  const provider = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers });
    if (request.method === "HEAD") {
      response.writeHead(200);
      response.end();
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/jobs") {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: jobId, sessionId: "wb-session-001" }));
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "GET" && request.url === `/api/v1/jobs/${jobId}/stream`) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ sessionId: "wb-session-001", type: "assistant", text: "Recommendation: use the configured HTTP adapter" })}\n\n`);
      response.write(`data: ${JSON.stringify({ status: "completed" })}\n\n`);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  const config = defaultConfig();
  config.defaultTimeoutMs = 5000;
  config.agents["tencent-workbuddy"] = { ...config.agents["tencent-workbuddy"], httpUrl: `http://127.0.0.1:${address.port}` };
  const plane = new ControlPlane({ dataDir: await mkdtemp(join(tmpdir(), "acc-workbuddy-")), config });
  try {
    const task = plane.createTask({ agent: "tencent-workbuddy", prompt: "review the adapter", cwd: process.cwd() });
    const finished = await waitForTask(plane, task.id);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.providerSessionId, "wb-session-001");
    assert.match(finished.resultText, /configured HTTP adapter/);
    assert.ok(requests.length >= 2);
    assert.ok(requests.every((item) => item.headers["x-codebuddy-request"] === "1"));
  } finally {
    await plane.shutdown();
    await new Promise((resolve) => provider.close(resolve));
  }
});
