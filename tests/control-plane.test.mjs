import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlPlane } from "../server/service.mjs";
import { defaultConfig } from "../server/core.mjs";

const fixture = join(process.cwd(), "tests", "fixtures", "fake-agent.mjs");

function fakeConfig() {
  const config = defaultConfig();
  config.maxConcurrentTasks = 3;
  config.defaultTimeoutMs = 5000;
  for (const agent of Object.keys(config.agents)) {
    config.agents[agent] = {
      ...config.agents[agent],
      command: process.execPath,
      args: [fixture, "-p", "{prompt}"],
      resumeArgs: [fixture, "-p", "{prompt}", "--resume", "{sessionId}"],
      supportsResume: true,
      env: { ...process.env, FAKE_AGENT_SESSION: `session-${agent}` },
    };
  }
  return config;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition timed out");
}

test("runs an allowlisted provider and persists session and events", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-control-"));
  const plane = new ControlPlane({ dataDir, config: fakeConfig() });
  try {
    const task = plane.createTask({ agent: "claude-code", prompt: "inspect the repository", cwd: process.cwd() });
    const finished = await plane.waitForTask(task.id, 5000);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.providerSessionId, "session-claude-code");
    assert.match(finished.resultText, /Recommendation:/);
    const events = plane.listTaskEvents(task.id);
    assert.ok(events.some((event) => event.eventType === "task_started"));
    assert.ok(events.some((event) => event.eventType === "provider_message"));
    assert.ok(events.some((event) => event.eventType === "task_finished"));
    const reply = await plane.replyTask(task.id, "follow up with the focused checks");
    const replyFinished = await plane.waitForTask(reply.id, 5000);
    assert.equal(replyFinished.id, task.id);
    assert.equal(replyFinished.attemptNo, 2);
    assert.equal(replyFinished.providerSessionId, "session-claude-code");
  } finally {
    await plane.shutdown();
  }
});

test("stops a queued task and a running task without widening the command surface", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-stop-"));
  const config = fakeConfig();
  config.maxConcurrentTasks = 1;
  for (const agent of Object.keys(config.agents)) config.agents[agent].env = { ...config.agents[agent].env, FAKE_AGENT_DELAY_MS: "4000" };
  const plane = new ControlPlane({ dataDir, config });
  try {
    const first = plane.createTask({ agent: "antigravity", prompt: "long task", cwd: process.cwd() });
    const second = plane.createTask({ agent: "claude-code", prompt: "queued task", cwd: process.cwd() });
    assert.equal(second.status, "queued");
    await waitFor(() => plane.getTask(first.id).status === "running");
    await assert.rejects(() => plane.replyTask(first.id, "too soon"), /live replies/);
    const stoppedQueued = await plane.stopTask(second.id);
    assert.equal(stoppedQueued.status, "stopped");
    const stoppedRunning = await plane.stopTask(first.id);
    assert.equal(stoppedRunning.status, "stopped");
  } finally {
    await plane.shutdown();
  }
});

test("runs two discussion rounds and generates traceable minutes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-discussion-"));
  const plane = new ControlPlane({ dataDir, config: fakeConfig() });
  try {
    const discussion = plane.createDiscussion({
      prompt: "compare the implementation options",
      cwd: process.cwd(),
      agents: ["antigravity", "claude-code", "tencent-workbuddy"],
      rounds: 2,
    });
    const finished = await waitFor(() => {
      const current = plane.getDiscussion(discussion.id);
      return ["succeeded", "failed", "stopped", "interrupted"].includes(current.status) ? current : null;
    }, 10000);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.messages.length, 6);
    const minutes = plane.latestMinutes(discussion.id);
    assert.ok(minutes);
    assert.match(minutes.markdown, /## Traceability/);
    assert.ok(minutes.payload.taskIds.length >= 6);
    assert.ok(plane.listDiscussions()[0].latestMinutes);
  } finally {
    await plane.shutdown();
  }
});

test("persists final minutes when a discussion is stopped", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-stopped-discussion-"));
  const config = fakeConfig();
  config.maxConcurrentTasks = 1;
  for (const agent of Object.keys(config.agents)) config.agents[agent].env = { ...config.agents[agent].env, FAKE_AGENT_DELAY_MS: "4000" };
  const plane = new ControlPlane({ dataDir, config });
  try {
    const discussion = plane.createDiscussion({ prompt: "stop this review", cwd: process.cwd(), agents: ["antigravity"], rounds: 2 });
    await waitFor(() => plane.getDiscussion(discussion.id).tasks.length > 0);
    const stopped = await plane.stopDiscussion(discussion.id);
    assert.equal(stopped.status, "stopped");
    const minutes = plane.latestMinutes(discussion.id);
    assert.ok(minutes);
    assert.match(minutes.markdown, /- Status: stopped/);
  } finally {
    await plane.shutdown();
  }
});
