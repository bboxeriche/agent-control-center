import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ControlPlane } from "../server/service.mjs";
import { DEFAULT_TASK_TIMEOUT_MS, MAX_TASK_TIMEOUT_MS, defaultConfig } from "../server/core.mjs";

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
  config.agents.antigravity.permissionMapping = { strategy: "test-double" };
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

test("uses the relaxed default, preserves explicit short budgets, and accepts budgets beyond four hours", async () => {
  const config = fakeConfig();
  config.defaultTimeoutMs = defaultConfig().defaultTimeoutMs;
  const plane = new ControlPlane({ dataDir: await mkdtemp(join(tmpdir(), "acc-task-budgets-")), config });
  try {
    assert.equal(DEFAULT_TASK_TIMEOUT_MS, 3_600_000);
    const inputs = [undefined, 180_000, 6 * 3_600_000, 36 * 3_600_000];
    const tasks = inputs.map((timeoutMs) => plane.createTask({ agent: "claude-code", cwd: process.cwd(), prompt: "budget fixture", timeoutMs }));
    assert.deepEqual(tasks.map((task) => task.timeoutMs), [DEFAULT_TASK_TIMEOUT_MS, 180_000, 6 * 3_600_000, MAX_TASK_TIMEOUT_MS]);
    await Promise.all(tasks.map((task) => plane.waitForTask(task.id, 5000)));
    const resumed = await plane.replyTask(tasks[1].id, "next attempt fixture", { timeoutMs: 2 * 3_600_000 });
    assert.equal(resumed.timeoutMs, 2 * 3_600_000);
    assert.equal(resumed.metadata.providerFinalAnswer, null);
    await plane.waitForTask(resumed.id, 5000);
    const next = await plane.replyTask(resumed.id, "keep previous attempt budget");
    assert.equal(next.timeoutMs, resumed.timeoutMs);
    await plane.waitForTask(next.id, 5000);
    assert.equal(plane.listTaskSummaryPage({}).tasks.find((task) => task.id === next.id).timeoutMs, resumed.timeoutMs);
  } finally {
    await plane.shutdown();
  }
});

test("a live reply cannot silently replace the active attempt's timer", async () => {
  const plane = new ControlPlane({ dataDir: await mkdtemp(join(tmpdir(), "acc-live-reply-budget-")), config: fakeConfig() });
  let task;
  let replies = 0;
  try {
    task = plane.store.createTask({ agent: "claude-code", status: "running", prompt: "live reply fixture", cwd: process.cwd(), timeoutMs: 5000 });
    plane.runtime.set(task.id, { handle: { reply: async () => { replies += 1; return {}; } } });
    await assert.rejects(plane.replyTask(task.id, "do not extend active timer", { timeoutMs: 3_600_000 }), (error) => error.statusCode === 409);
    assert.equal(replies, 0);
    assert.equal(plane.getTask(task.id).timeoutMs, 5000);
    await plane.replyTask(task.id, "same budget live reply", { timeoutMs: 5000 });
    assert.equal(replies, 1);
  } finally {
    if (task) plane.runtime.delete(task.id);
    await plane.shutdown();
  }
});

test("cached provider probes preserve their timestamps while recent execution updates immediately", async () => {
  const plane = new ControlPlane({ dataDir: await mkdtemp(join(tmpdir(), "acc-cached-probes-")), config: fakeConfig() });
  try {
    await plane.agentHealth();
    const cached = plane.providerHealthCache.get("claude-code");
    plane.providerHealthCache.set("claude-code", { ...cached, healthCheckedAt: "2020-01-01T00:00:00.000Z" });
    const task = plane.createTask({ agent: "claude-code", prompt: "current execution fixture", cwd: process.cwd() });
    await plane.waitForTask(task.id, 5000);
    const current = (await plane.agentHealth({ probe: false })).find((agent) => agent.agent === "claude-code");
    assert.equal(current.healthCheckedAt, "2020-01-01T00:00:00.000Z", "snapshot refresh is not a fresh version/auth probe");
    assert.equal(current.recentExecution.taskId, task.id);
    assert.equal(current.recentExecution.status, "succeeded");
  } finally {
    await plane.shutdown();
  }
});

test("pages task summaries with stable cursors and keeps filtered totals independent of the cursor", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-task-pages-"));
  const plane = new ControlPlane({ dataDir, config: fakeConfig() });
  try {
    const created = [
      plane.createTask({ agent: "claude-code", prompt: "alpha task", cwd: process.cwd() }),
      plane.createTask({ agent: "claude-code", prompt: "beta task", cwd: process.cwd() }),
      plane.createTask({ agent: "codex-cli", prompt: "alpha follow-up", cwd: process.cwd() }),
      plane.createTask({ agent: "codex-cli", prompt: "gamma task", cwd: process.cwd() }),
    ];
    await Promise.all(created.map((task) => plane.waitForTask(task.id, 5000)));
    const first = plane.listTaskSummaryPage({ limit: 2 });
    assert.equal(first.tasks.length, 2);
    assert.equal(first.total, 4);
    assert.equal(first.statusCounts.succeeded, 4);
    assert.equal(first.hasMore, true);
    const second = plane.listTaskSummaryPage({ limit: 2, cursor: first.nextCursor });
    assert.equal(second.tasks.length, 2);
    assert.equal(second.total, 4);
    assert.equal(second.hasMore, false);
    assert.equal(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size, 4);
    const filtered = plane.listTaskSummaryPage({ limit: 1, cursor: first.nextCursor, query: "alpha" });
    assert.equal(filtered.total, 2);
  } finally {
    await plane.shutdown();
  }
});

test("continues beyond the first 500 task events and retains the terminal event", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-long-task-history-"));
  const plane = new ControlPlane({ dataDir, config: fakeConfig() });
  try {
    const task = plane.store.createTask({ agent: "claude-code", prompt: "large event history", cwd: process.cwd(), timeoutMs: 5000 });
    for (let index = 0; index < 638; index += 1) {
      plane.store.addEvent({ taskId: task.id, eventType: "provider_message", source: "claude-code", payload: { index } });
    }
    plane.store.addEvent({ taskId: task.id, eventType: "task_finished", source: "control-plane", payload: { status: "succeeded" } });
    const firstPage = plane.listTaskEventPage(task.id, 0, 500);
    assert.equal(firstPage.events.length, 500);
    assert.equal(firstPage.hasMore, true);
    const secondPage = plane.listTaskEventPage(task.id, firstPage.nextCursor, 500);
    assert.equal(secondPage.events.length, 139);
    assert.equal(secondPage.hasMore, false);
    assert.equal(secondPage.events.at(-1).eventType, "task_finished");
  } finally {
    await plane.shutdown();
  }
});

test("previews Dashboard permissions using the same allowed-root and origin ceiling", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-policy-preview-"));
  const config = fakeConfig();
  config.allowedRoots = [process.cwd()];
  const plane = new ControlPlane({ dataDir, config });
  try {
    const preview = plane.previewTaskPolicy({ agent: "claude-code", cwd: process.cwd() });
    assert.equal(preview.origin, "dashboard");
    assert.equal(preview.permissionPolicy.effective.writeAllowed, false);
    assert.equal(preview.permissionPolicy.effective.networkAllowed, false);
    assert.equal(preview.permissionPolicy.effective.workspace, process.cwd());
    assert.throws(() => plane.previewTaskPolicy({ agent: "claude-code", cwd: tmpdir() }), /outside the configured allowed workspace roots/);
  } finally {
    await plane.shutdown();
  }
});

test("keeps WorkBuddy permission profiles unverified until a fresh matching version probe exists", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-workbuddy-version-evidence-"));
  const config = fakeConfig();
  config.maxConcurrentTasks = 0;
  config.allowedRoots = [process.cwd()];
  config.agents["tencent-workbuddy"].versionArgs = ["-e", "process.stdout.write('codebuddy 2.156.0')"];
  const plane = new ControlPlane({ dataDir, config });
  try {
    const unchecked = plane.previewTaskPolicy({ agent: "tencent-workbuddy", cwd: process.cwd() });
    assert.equal(unchecked.permissionPolicy.capabilityReport.providerVersionValidation.status, "not_checked");
    assert.notEqual(unchecked.permissionPolicy.executionProfile.status, "SUPPORTED");

    const health = (await plane.agentHealth()).find((agent) => agent.agent === "tencent-workbuddy");
    assert.equal(health.providerVersionValidation.status, "version_mismatch");
    assert.equal(health.providerVersionValidation.observedProviderVersion, "2.156.0");
    const mismatched = plane.previewTaskPolicy({ agent: "tencent-workbuddy", cwd: process.cwd() });
    assert.equal(mismatched.permissionPolicy.capabilityReport.providerVersionValidation.status, "version_mismatch");
    assert.notEqual(mismatched.permissionPolicy.executionProfile.status, "SUPPORTED");
    assert.ok(Object.values(mismatched.permissionPolicy.capabilityReport.executionProfiles).every((profile) => profile.status !== "SUPPORTED"));

    const task = plane.createTask({ agent: "tencent-workbuddy", origin: "dashboard", prompt: "version evidence only", cwd: process.cwd() });
    assert.equal(task.permissionPolicy.executionProfile.providerVersionValidation.status, "version_mismatch");
    assert.notEqual(task.permissionPolicy.executionProfile.status, "SUPPORTED");
  } finally {
    await plane.shutdown();
  }
});

test("stores a separate final-answer evidence field only for a recognized provider result event", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-final-answer-evidence-"));
  const config = fakeConfig();
  config.agents["claude-code"].args = ["-e", "process.stdout.write(JSON.stringify({type:'result',result:'Provider final answer'}))"];
  const plane = new ControlPlane({ dataDir, config });
  try {
    const task = plane.createTask({ agent: "claude-code", prompt: "run final event probe", cwd: process.cwd() });
    const finished = await plane.waitForTask(task.id, 5000);
    assert.equal(finished.status, "succeeded");
    assert.deepEqual(finished.metadata.providerFinalAnswer, {
      source: "provider_final_event",
      eventType: "result",
      text: "Provider final answer",
    });
    assert.match(finished.resultText, /Provider final answer/);
  } finally {
    await plane.shutdown();
  }
});

test("recognizes Antigravity's nested successful final response without promoting progress or failed partial output", async () => {
  const cases = [
    { event: { event: "result", result: { status: "SUCCESS", response: "ACC Anti final answer\n" } }, expected: "ACC Anti final answer", status: "succeeded" },
    { event: { event: "step_update", step_update: { state: "DONE", step_type: "agent_response", text_delta: "progress only" } }, expected: null, status: "succeeded" },
    { event: { event: "result", result: { status: "ERROR", response: "partial output", error: "interrupted" } }, expected: null, status: "failed" },
  ];
  for (const { event, expected, status } of cases) {
    const dataDir = await mkdtemp(join(tmpdir(), "acc-anti-final-answer-"));
    const config = fakeConfig();
    config.agents.antigravity.args = ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")})`, "--"];
    const plane = new ControlPlane({ dataDir, config });
    try {
      const task = plane.createTask({ agent: "antigravity", prompt: "provider final event fixture", cwd: process.cwd(), timeoutMs: 10000 });
      const finished = await plane.waitForTask(task.id, 5000);
      assert.equal(finished.status, status);
      if (expected) {
        assert.deepEqual(finished.metadata.providerFinalAnswer, { source: "provider_final_event", eventType: "result/response", text: expected });
      } else {
        assert.equal(finished.metadata.providerFinalAnswer, null);
      }
    } finally {
      await plane.shutdown();
    }
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
