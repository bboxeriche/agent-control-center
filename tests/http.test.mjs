import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../server/core.mjs";
import { ControlPlane, startControlServer } from "../server/service.mjs";
import { ANTIGRAVITY_CONTAINMENT_STRATEGY } from "../server/antigravity-containment.mjs";

const fixture = join(process.cwd(), "tests", "fixtures", "fake-agent.mjs");

function fakeConfig() {
  const config = defaultConfig();
  config.maxConcurrentTasks = 2;
  config.defaultTimeoutMs = 5000;
  for (const agent of Object.keys(config.agents)) {
    config.agents[agent] = { ...config.agents[agent], command: process.execPath, args: [fixture, "-p", "{prompt}"], env: { ...process.env } };
  }
  config.agents.antigravity.permissionMapping = { strategy: "test-double" };
  return config;
}

async function waitForTask(baseUrl, taskId, authToken) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    const payload = await response.json();
    if (["succeeded", "failed", "stopped", "timed_out", "interrupted"].includes(payload.task.status)) return payload.task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("HTTP task timed out");
}

test("serves health, task creation, task status, and dashboard", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-http-"));
  const running = await startControlServer({ host: "127.0.0.1", port: 0, dataDir, config: fakeConfig() });
  const baseUrl = `http://${running.host}:${running.port}`;
  try {
    const health = await fetch(`${baseUrl}/api/healthz`).then((response) => response.json());
    assert.equal(health.status, "ok");
    const unauthorized = await fetch(`${baseUrl}/api/agents`);
    assert.equal(unauthorized.status, 401);
    const created = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${running.plane.authToken}` },
      body: JSON.stringify({ agent: "antigravity", prompt: "run the smoke test", cwd: process.cwd() }),
    }).then((response) => response.json());
    assert.ok(created.task.id.startsWith("task_"));
    const finished = await waitForTask(baseUrl, created.task.id, running.plane.authToken);
    assert.equal(finished.status, "succeeded");
    const dashboardResponse = await fetch(`${baseUrl}/`);
    const dashboard = await dashboardResponse.text();
    assert.match(dashboard, /Agent Control Center/);
    const cookie = dashboardResponse.headers.get("set-cookie");
    assert.match(cookie, /acc_token=/);
    const cookieAuthorized = await fetch(`${baseUrl}/api/agents`, { headers: { cookie } });
    assert.equal(cookieAuthorized.status, 200);
  } finally {
    await running.close();
  }
});

test("waits for contained provider cleanup before finalizing a timed-out task", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("sandbox-exec fallback is macOS-specific");
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), "acc-timeout-cleanup-data-"));
  const taskRoot = await mkdtemp(join(tmpdir(), "acc-timeout-cleanup-root-"));
  const config = defaultConfig();
  config.allowedRoots = [process.cwd()];
  config.defaultTimeoutMs = 1000;
  config.agents.antigravity = {
    ...config.agents.antigravity,
    command: process.execPath,
    args: [fixture, "-p", "{prompt}"],
    env: { ...process.env, FAKE_AGENT_DELAY_MS: "10000" },
    permissionMapping: {
      strategy: ANTIGRAVITY_CONTAINMENT_STRATEGY,
      taskRoot,
      providerHosts: [],
    },
  };
  const plane = new ControlPlane({ dataDir, config });
  try {
    const task = plane.createTask({
      agent: "antigravity",
      prompt: "hold until the control-plane timeout",
      cwd: process.cwd(),
      origin: "devspace",
    });
    const finished = await plane.waitForTask(task.id, 10000);
    assert.equal(finished.status, "timed_out");
    const completion = plane.listTaskEvents(task.id, 0).find((event) => event.eventType === "task_finished");
    assert.equal(completion?.payload?.permissionCleanup?.state, "cleaned");
    assert.deepEqual(await readdir(taskRoot), []);
  } finally {
    await plane.shutdown();
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(taskRoot, { recursive: true, force: true }),
    ]);
  }
});
