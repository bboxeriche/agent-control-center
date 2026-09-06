import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { defaultConfig } from "../server/core.mjs";
import { ControlPlane, startControlServer } from "../server/service.mjs";

const fixture = join(process.cwd(), "tests", "fixtures", "fake-agent.mjs");

function fakeConfig() {
  const config = defaultConfig();
  config.maxConcurrentTasks = 2;
  config.defaultTimeoutMs = 5000;
  config.maxWaitMs = 2000;
  config.allowedRoots = [process.cwd()];
  for (const agent of Object.keys(config.agents)) {
    config.agents[agent] = {
      ...config.agents[agent],
      command: process.execPath,
      args: [fixture, "-p", "{prompt}"],
      resumeArgs: [fixture, "-p", "{prompt}", "--resume", "{sessionId}"],
      supportsResume: true,
      env: { ...process.env, FAKE_AGENT_SESSION: `session-${agent}`, FAKE_AGENT_DELAY_MS: "100" },
    };
  }
  return config;
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json();
  assert.equal(response.ok, true, `${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

test("keeps one durable task identity across retry, cursor recovery, disconnect, and follow-up", async () => {
  const running = await startControlServer({
    host: "127.0.0.1",
    port: 0,
    dataDir: await mkdtemp(join(tmpdir(), "acc-durable-")),
    config: fakeConfig(),
  });
  const baseUrl = `http://${running.host}:${running.port}`;
  const auth = { authorization: `Bearer ${running.plane.authToken}` };
  try {
    const request = {
      agent: "codex-cli",
      prompt: "durable cross-client acceptance",
      cwd: process.cwd(),
      origin: "codex",
      originRequestId: "codex-request-001",
      idempotencyKey: "acceptance-start-001",
    };
    const created = await jsonFetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const taskId = created.task.id;
    assert.equal(created.reused, false);
    assert.equal(created.task.origin, "codex");
    assert.ok(created.task.eventCursor > 0);

    // A second client can recover the task without owning the original request.
    const devspaceView = await jsonFetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { headers: auth });
    assert.equal(devspaceView.task.id, taskId);
    assert.equal(devspaceView.task.permissionPolicy.effective.writeAllowed, true);

    const firstPage = await jsonFetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/events?afterCursor=0&limit=2`, { headers: auth });
    assert.equal(firstPage.afterCursor, 0);
    assert.ok(firstPage.nextCursor >= firstPage.events.at(-1).id);
    assert.ok(firstPage.hasMore);
    const laterPage = await jsonFetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/events?afterCursor=${firstPage.nextCursor}`, { headers: auth });
    assert.ok(laterPage.events.every((event) => event.id > firstPage.nextCursor));

    let finished = await jsonFetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/wait?timeoutMs=2000&afterCursor=${created.task.eventCursor}`, { headers: auth });
    for (let attempt = 0; attempt < 5 && finished.task.status !== "succeeded"; attempt += 1) {
      finished = await jsonFetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/wait?timeoutMs=2000&afterCursor=${finished.nextCursor}`, { headers: auth });
    }
    assert.equal(finished.task.status, "succeeded");
    assert.ok(finished.eventCursor >= finished.nextCursor);
    assert.ok(finished.events.some((event) => event.eventType === "task_finished"));

    const retry = await jsonFetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(retry.reused, true);
    assert.equal(retry.task.id, taskId);

    const beforeFollowUp = await jsonFetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { headers: auth });
    const followUp = await jsonFetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/reply`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "continue from the same task", origin: "devspace", originRequestId: "devspace-follow-up-001" }),
    });
    assert.equal(followUp.task.id, taskId);
    assert.equal(followUp.task.attemptNo, 2);

    let resumed = await jsonFetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/wait?timeoutMs=2000&afterCursor=${beforeFollowUp.task.eventCursor}`, { headers: auth });
    const resumedEvents = [...resumed.events];
    for (let attempt = 0; attempt < 5 && resumed.task.status !== "succeeded"; attempt += 1) {
      resumed = await jsonFetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/wait?timeoutMs=2000&afterCursor=${resumed.nextCursor}`, { headers: auth });
      resumedEvents.push(...resumed.events);
    }
    assert.equal(resumed.task.id, taskId);
    assert.equal(resumed.task.status, "succeeded");
    assert.equal(resumed.task.providerSessionId, "session-codex-cli");
    assert.ok(resumedEvents.some((event) => event.eventType === "task_resumed"));
    assert.ok(resumed.task.eventCursor > beforeFollowUp.task.eventCursor);

    const listed = await jsonFetch(`${baseUrl}/api/tasks?limit=50`, { headers: auth });
    assert.equal(listed.tasks.filter((task) => task.id === taskId).length, 1);

    const remoteDefault = running.plane.createTask({
      agent: "codex-cli",
      prompt: "verify remote least privilege defaults",
      cwd: process.cwd(),
      origin: "devspace",
      idempotencyKey: "acceptance-remote-policy-001",
    });
    assert.equal(remoteDefault.permissionPolicy.effective.writeAllowed, false);
    assert.equal(remoteDefault.permissionPolicy.native.writeAllowed, "native");
    await running.plane.waitForTask(remoteDefault.id, 2000);
  } finally {
    await running.close();
  }
});

test("reconstructs completed task identity and cursor from the durable store", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-reopen-"));
  const config = fakeConfig();
  const firstPlane = new ControlPlane({ dataDir, config });
  let task;
  try {
    task = firstPlane.createTask({
      agent: "claude-code",
      prompt: "persist this task identity",
      cwd: process.cwd(),
      origin: "devspace",
      originRequestId: "reopen-request-001",
      idempotencyKey: "reopen-start-001",
    });
    const finished = await firstPlane.waitForTask(task.id, 2000);
    assert.equal(finished.status, "succeeded");
  } finally {
    await firstPlane.shutdown();
  }
  const secondPlane = new ControlPlane({ dataDir, config });
  try {
    const recovered = secondPlane.getTask(task.id);
    assert.equal(recovered.id, task.id);
    assert.equal(recovered.origin, "devspace");
    assert.equal(recovered.providerSessionId, "session-claude-code");
    assert.ok(recovered.eventCursor > 0);
    assert.ok(secondPlane.listTaskEvents(task.id, 0).length >= 4);
    assert.equal(secondPlane.createTask({
      agent: "claude-code",
      prompt: "persist this task identity",
      cwd: process.cwd(),
      origin: "devspace",
      idempotencyKey: "reopen-start-001",
    }).id, task.id);
  } finally {
    await secondPlane.shutdown();
  }
});

test("serializes concurrent follow-ups and rejects idempotency conflicts", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-concurrency-"));
  const plane = new ControlPlane({ dataDir, config: fakeConfig() });
  const events = [];
  plane.hub.subscribe((event) => events.push(event));
  try {
    const initial = plane.createTask({ agent: "codex-cli", prompt: "initial", cwd: process.cwd(), idempotencyKey: "concurrent-start" });
    await plane.waitForTask(initial.id, 2000);
    const [first, second] = await Promise.all([
      plane.replyTask(initial.id, "reply-a"),
      plane.replyTask(initial.id, "reply-b"),
    ]);
    assert.equal(first.id, initial.id);
    assert.equal(second.id, initial.id);
    await plane.waitForTask(initial.id, 2000);
    assert.equal(events.filter((event) => event.eventType === "task_started").length, 3);
    assert.equal(events.filter((event) => event.eventType === "task_resumed").length, 2);
    assert.equal(plane.getTask(initial.id).attemptNo, 3);

    assert.equal(plane.createTaskRequest({ agent: "codex-cli", prompt: "initial", cwd: process.cwd(), idempotencyKey: "same-request" }).reused, false);
    assert.equal(plane.createTaskRequest({ agent: "codex-cli", prompt: "initial", cwd: process.cwd(), idempotencyKey: "same-request" }).reused, true);
    assert.throws(
      () => plane.createTaskRequest({ agent: "codex-cli", prompt: "different", cwd: process.cwd(), idempotencyKey: "same-request" }),
      (error) => error.statusCode === 409 && error.message === "idempotency_conflict",
    );
  } finally {
    await plane.shutdown();
  }
});

test("enforces canonical allowed roots for remote workspaces and paginates discussion events", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-boundary-"));
  const config = fakeConfig();
  config.allowedRoots = [process.cwd()];
  const plane = new ControlPlane({ dataDir, config });
  try {
    assert.throws(() => plane.createTask({ agent: "codex-cli", prompt: "escape", cwd: "/tmp", origin: "devspace" }), /outside the configured allowed workspace roots/);
    assert.throws(() => plane.createTask({ agent: "codex-cli", prompt: "traversal", cwd: `${process.cwd()}/../`, origin: "dashboard" }), /parent traversal/);
    const discussion = plane.store.createDiscussion({ prompt: "cursor", cwd: process.cwd(), agents: ["codex-cli"], rounds: 1, origin: "local_cli" });
    plane.emit({ discussionId: discussion.id, eventType: "discussion_created", source: "test", payload: {} });
    const page = plane.listDiscussionEventPage(discussion.id, 0, 1);
    assert.equal(page.afterCursor, 0);
    assert.equal(page.events.length, 1);
    assert.equal(typeof page.nextCursor, "number");
    assert.equal(typeof page.hasMore, "boolean");
    assert.ok(page.eventCursor >= page.nextCursor);
  } finally {
    await plane.shutdown();
  }
});
