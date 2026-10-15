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
    config.agents[agent] = { ...config.agents[agent], command: process.execPath, args: [fixture, "-p", "{prompt}"], env: { ...process.env, FAKE_AGENT_SESSION: `session-${agent}` } };
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
    if (["succeeded", "failed", "stopped", "timed_out", "interrupted", "blocked_preflight", "completed_without_delivery"].includes(payload.task.status)) return payload.task;
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

test("a competing startup cannot interrupt the live owner's tasks before EADDRINUSE", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-startup-owner-"));
  const config = fakeConfig(); config.maxConcurrentTasks = 0;
  const running = await startControlServer({ host: "127.0.0.1", port: 0, dataDir, config });
  try {
    const task = running.plane.createTask({ agent: "claude-code", prompt: "queued owner fixture", cwd: process.cwd() });
    const before = running.plane.getTask(task.id);
    await assert.rejects(startControlServer({ host: running.host, port: running.port, dataDir, config }), error => error.code === "EADDRINUSE");
    assert.deepEqual(running.plane.getTask(task.id), before);
    assert.equal(running.plane.getTask(task.id).status, "queued");
  } finally { await running.close(); }
});

test("streams authenticated lifecycle invalidations without provider output and removes disconnected listeners", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-dashboard-activity-"));
  const running = await startControlServer({ host: "127.0.0.1", port: 0, dataDir, config: fakeConfig() });
  const baseUrl = `http://${running.host}:${running.port}`;
  let reader;
  try {
    assert.equal((await fetch(`${baseUrl}/api/activity/stream`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/activity/stream`, { headers: { origin: "https://foreign.example" } })).status, 403);
    const agents = await fetch(`${baseUrl}/api/agents?cached=1`, { headers: { authorization: `Bearer ${running.plane.authToken}` } }).then((response) => response.json());
    assert.equal(agents.taskOptions.defaultTimeoutMs, 5000);
    assert.equal(agents.taskOptions.maxTimeoutMs, 86_400_000);
    const stream = await fetch(`${baseUrl}/api/activity/stream`, { headers: { authorization: `Bearer ${running.plane.authToken}` }, signal: AbortSignal.timeout(5000) });
    assert.match(stream.headers.get("content-type"), /text\/event-stream/);
    reader = stream.body.getReader();
    const decode = new TextDecoder();
    let body = decode.decode((await reader.read()).value);
    assert.match(body, /event: ready/);
    assert.equal(running.plane.hub.listeners.size, 1);
    const task = running.plane.createTask({ agent: "claude-code", cwd: process.cwd(), prompt: "private provider fixture must not appear in activity" });
    while (!body.includes('"eventType":"task_finished"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      body += decode.decode(chunk.value);
    }
    assert.match(body, new RegExp(task.id));
    assert.match(body, /"eventType":"task_created"/);
    assert.doesNotMatch(body, /provider_message|Recommendation:|private provider fixture/);
    assert.equal(running.plane.getTask(task.id).status, "succeeded", "invalidation follows durable finalization");
    await reader.cancel();
    reader = null;
    for (let i = 0; i < 100 && running.plane.hub.listeners.size; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(running.plane.hub.listeners.size, 0);
  } finally {
    if (reader) await reader.cancel();
    await running.close();
  }
});

test("service shutdown closes a connected Dashboard activity stream", async () => {
  const running = await startControlServer({ host: "127.0.0.1", port: 0, dataDir: await mkdtemp(join(tmpdir(), "acc-stream-shutdown-")), config: fakeConfig() });
  const stream = await fetch(`http://${running.host}:${running.port}/api/activity/stream`, { headers: { authorization: `Bearer ${running.plane.authToken}` }, signal: AbortSignal.timeout(5000) });
  const reader = stream.body.getReader();
  await reader.read();
  const closing = running.close();
  assert.equal((await reader.read()).done, true);
  await closing;
  assert.equal(running.plane.hub.listeners.size, 0);
});

test("serves task summaries and policy preview, and fixes Dashboard task origin despite spoofed body metadata", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-dashboard-contract-"));
  const config = fakeConfig();
  config.allowedRoots = [process.cwd()];
  config.agents["claude-code"].args = ["-e", "process.stdout.write(JSON.stringify({type:'system',session_id:'http-session'})+'\\n'+JSON.stringify({type:'result',result:'dashboard provider final'})+'\\n')"];
  const running = await startControlServer({ host: "127.0.0.1", port: 0, dataDir, config });
  const baseUrl = `http://${running.host}:${running.port}`;
  try {
    const page = await fetch(`${baseUrl}/`);
    const cookie = page.headers.get("set-cookie");
    const previewResponse = await fetch(`${baseUrl}/api/policy-preview?agent=claude-code&cwd=${encodeURIComponent(process.cwd())}`, { headers: { cookie } });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json();
    assert.equal(preview.origin, "dashboard");
    assert.equal(preview.permissionPolicy.effective.writeAllowed, false);

    const createdResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: baseUrl },
      body: JSON.stringify({ agent: "claude-code", prompt: "dashboard constrained task", cwd: process.cwd(), origin: "codex", permissionPolicy: { writeAllowed: true, networkAllowed: true } }),
    });
    assert.equal(createdResponse.status, 202);
    const created = await createdResponse.json();
    assert.equal(created.task.origin, "dashboard");
    assert.equal(created.task.permissionPolicy.effective.writeAllowed, false);
    assert.equal(created.task.permissionPolicy.effective.networkAllowed, false);
    assert.equal(created.resultSummary.permission.origin, "dashboard");
    assert.equal(created.resultSummary.mechanicalOutcome.outcome, "not_recorded");
    await waitForTask(baseUrl, created.task.id, running.plane.authToken);
    const waited = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(created.task.id)}/wait?timeoutMs=1000`, { headers: { authorization: `Bearer ${running.plane.authToken}` } }).then((response) => response.json());
    assert.equal(waited.resultSummary.status, "succeeded");
    assert.equal(waited.resultSummary.mechanicalOutcome.outcome, "succeeded");
    assert.equal(waited.resultSummary.permission.effective.writeAllowed, false);
    assert.equal(waited.resultSummary.providerFinalAnswerEvidence.source, "provider_final_event");
    assert.match(waited.resultSummary.providerFinalAnswerEvidence.preview, /dashboard provider final/);
    assert.equal(waited.resultSummary.providerFinalAnswerEvidence.semanticVerification, "not_performed");

    const summaryResponse = await fetch(`${baseUrl}/api/task-summaries?limit=1&query=dashboard`, { headers: { cookie } });
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.equal(summary.total, 1);
    assert.equal(summary.tasks[0].id, created.task.id);
    assert.equal(summary.tasks[0].hasProviderSessionId, true);

    const discussionResponse = await fetch(`${baseUrl}/api/discussions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: baseUrl },
      body: JSON.stringify({ prompt: "dashboard discussion", cwd: process.cwd(), agents: ["claude-code"], rounds: 1, origin: "codex" }),
    });
    assert.equal(discussionResponse.status, 202);
    const { discussion } = await discussionResponse.json();
    assert.equal(discussion.origin, "dashboard");
    const discussionWithTask = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => {
        const current = running.plane.getDiscussion(discussion.id);
        if (current.tasks.length) return resolve(current);
        if (Date.now() >= deadline) return reject(new Error("discussion task was not created"));
        setTimeout(poll, 20);
      };
      poll();
    });
    const discussionTask = discussionWithTask.tasks[0];
    assert.equal(discussionTask.origin, "dashboard");
    assert.equal(discussionTask.permissionPolicy.effective.writeAllowed, false);
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
      projectsRoot: join(dataDir, "native-projects"),
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
    assert.equal(completion?.payload?.permissionCleanup?.approvalProjectState, "removed");
    assert.deepEqual(await readdir(join(dataDir, "native-projects")), []);
    assert.deepEqual(await readdir(taskRoot), []);
  } finally {
    await plane.shutdown();
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(taskRoot, { recursive: true, force: true }),
    ]);
  }
});

test("cleans Antigravity containment after a stopped task", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("sandbox-exec fallback is macOS-specific");
    return;
  }
  const dataDir = await mkdtemp(join(tmpdir(), "acc-stop-containment-data-"));
  const taskRoot = await mkdtemp(join(tmpdir(), "acc-stop-containment-root-"));
  const config = defaultConfig();
  config.allowedRoots = [process.cwd()];
  config.defaultTimeoutMs = 15000;
  config.agents.antigravity = {
    ...config.agents.antigravity,
    command: process.execPath,
    args: [fixture, "-p", "{prompt}"],
    env: { ...process.env, FAKE_AGENT_DELAY_MS: "10000" },
    permissionMapping: {
      strategy: ANTIGRAVITY_CONTAINMENT_STRATEGY,
      taskRoot,
      projectsRoot: join(dataDir, "native-projects"),
      providerHosts: [],
    },
  };
  const plane = new ControlPlane({ dataDir, config });
  try {
    const task = plane.createTask({
      agent: "antigravity",
      prompt: "hold until explicitly stopped",
      cwd: process.cwd(),
      origin: "devspace",
    });
    for (let attempt = 0; attempt < 200 && !plane.runtime.get(task.id)?.handle; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(plane.getTask(task.id).status, "running");
    assert.ok(plane.runtime.get(task.id)?.handle, "provider handle should be available before stop");
    const stopped = await plane.stopTask(task.id);
    assert.equal(stopped.status, "stopped");
    const completion = plane.listTaskEvents(task.id, 0).find((event) => event.eventType === "task_finished");
    assert.equal(completion?.payload?.permissionCleanup?.state, "cleaned");
    assert.equal(completion?.payload?.permissionCleanup?.approvalProjectState, "removed");
    assert.deepEqual(await readdir(join(dataDir, "native-projects")), []);
    assert.deepEqual(await readdir(taskRoot), []);
  } finally {
    await plane.shutdown();
    await Promise.all([
      rm(dataDir, { recursive: true, force: true }),
      rm(taskRoot, { recursive: true, force: true }),
    ]);
  }
});
