import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CliAdapter } from "../server/adapters.mjs";
import { collectProviderDiagnosticLine, defaultConfig, emptyProviderFacts } from "../server/core.mjs";
import { replayDeliveryDiagnosis } from "../server/delivery.mjs";
import { ControlPlane } from "../server/service.mjs";

const fixture = join(process.cwd(), "tests", "fixtures", "fake-agent.mjs");

function timeoutFromArgs(args) {
  const index = args.indexOf("--print-timeout");
  assert.notEqual(index, -1, "Antigravity invocation must explicitly set --print-timeout");
  assert.equal(args.indexOf("--print-timeout", index + 1), -1, "only one print timeout may be passed");
  const value = args[index + 1];
  assert.ok(value, "--print-timeout must have a value");
  const parts = [...value.matchAll(/(\d+)(ms|h|m|s)/g)];
  assert.equal(parts.map((part) => part[0]).join(""), value, "duration must use agy's Go-style duration syntax");
  const scales = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  return parts.reduce((total, part) => total + Number(part[1]) * scales[part[2]], 0);
}

function antigravityAdapter() {
  return new CliAdapter("antigravity", {
    command: process.execPath,
    args: [fixture, "-p", "{prompt}"],
    permissionMapping: { strategy: "test-double" },
  });
}

test("maps long Antigravity task timeout to a deterministic print timeout below the ACC ceiling", async () => {
  const first = antigravityAdapter().start({ prompt: "long", cwd: process.cwd(), timeoutMs: 1_800_000 }, () => {});
  const second = antigravityAdapter().start({ prompt: "long", cwd: process.cwd(), timeoutMs: 1_800_000 }, () => {});
  const timeoutMs = timeoutFromArgs(first.args);
  assert.equal(timeoutMs, 1_740_000);
  assert.ok(timeoutMs > 5 * 60_000);
  assert.ok(timeoutMs < 1_800_000);
  assert.equal(first.args[first.args.indexOf("--print-timeout") + 1], "29m");
  assert.equal(timeoutFromArgs(second.args), timeoutMs, "same task timeout must map deterministically");
  await Promise.all([first.wait, second.wait]);
});

test("different long task budgets produce different provider timeouts", async () => {
  const tenMinute = antigravityAdapter().start({ prompt: "ten", cwd: process.cwd(), timeoutMs: 600_000 }, () => {});
  const thirtyMinute = antigravityAdapter().start({ prompt: "thirty", cwd: process.cwd(), timeoutMs: 1_800_000 }, () => {});
  assert.equal(tenMinute.args[tenMinute.args.indexOf("--print-timeout") + 1], "9m30s");
  assert.notEqual(timeoutFromArgs(tenMinute.args), timeoutFromArgs(thirtyMinute.args));
  await Promise.all([tenMinute.wait, thirtyMinute.wait]);
});

test("minimum ACC task timeout keeps a positive provider duration strictly below the outer timeout", async () => {
  const handle = antigravityAdapter().start({ prompt: "short", cwd: process.cwd(), timeoutMs: 1000 }, () => {});
  const providerTimeoutMs = timeoutFromArgs(handle.args);
  assert.equal(handle.args[handle.args.indexOf("--print-timeout") + 1], "500ms");
  assert.ok(providerTimeoutMs > 0);
  assert.ok(providerTimeoutMs < 1000);
  await handle.wait;
});

test("an hour-long Antigravity attempt retains 59 minutes of provider time and a collection margin", async () => {
  const handle = antigravityAdapter().start({ prompt: "one-hour budget", cwd: process.cwd(), timeoutMs: 3_600_000 }, () => {});
  assert.equal(handle.args[handle.args.indexOf("--print-timeout") + 1], "59m");
  await handle.wait;
});

test("passes task timeout through ControlPlane to the Antigravity adapter", async () => {
  const config = defaultConfig();
  config.maxConcurrentTasks = 1;
  config.agents.antigravity.command = process.execPath;
  config.agents.antigravity.args = [fixture, "-p", "{prompt}"];
  config.agents.antigravity.permissionMapping = { strategy: "test-double" };
  const plane = new ControlPlane({ dataDir: await mkdtemp(join(tmpdir(), "acc-antigravity-timeout-")), config });
  try {
    const task = plane.createTask({
      agent: "antigravity",
      prompt: "timeout forwarding smoke",
      cwd: process.cwd(),
      timeoutMs: 10_000,
      deliveryContract: { type: "execution_only" },
    });
    const finished = await plane.waitForTask(task.id, 5000);
    assert.equal(finished.status, "succeeded");
    const started = plane.listTaskEvents(task.id).find((event) => event.eventType === "provider_started");
    assert.ok(started);
    assert.equal(started.payload.argCount, 5, "provider args include the configured prompt plus timeout flag and value");
  } finally {
    await plane.shutdown();
  }
});

test("does not add Antigravity print timeout flags to WorkBuddy, Codex, or Claude", async () => {
  for (const agentId of ["tencent-workbuddy", "codex-cli", "claude-code"]) {
    const adapter = new CliAdapter(agentId, {
      command: process.execPath,
      args: [fixture, "-p", "{prompt}"],
    });
    const handle = adapter.start({ prompt: "unchanged", cwd: process.cwd(), timeoutMs: 600_000 }, () => {});
    assert.equal(handle.args.includes("--print-timeout"), false, `${agentId} args must remain unchanged`);
    await handle.wait;
  }
});

const timeoutWarning = "[agy] print timeout after 7m36s with turn in progress; returning partial output";

test("native print timeout followed by empty SUCCESS is timed_out in task, summary, and event", async () => {
  const config = defaultConfig();
  config.agents.antigravity = {
    ...config.agents.antigravity, command: process.execPath,
    args: ["-e", `console.error(${JSON.stringify(timeoutWarning)});console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:''}}))`, "--"],
    permissionMapping: { strategy: "test-double" },
  };
  const plane = new ControlPlane({ dataDir: await mkdtemp(join(tmpdir(), "acc-inner-timeout-")), config });
  try {
    const task = plane.createTask({ agent: "antigravity", cwd: process.cwd(), prompt: "native timeout fixture" });
    const finished = await plane.waitForTask(task.id, 5000);
    assert.equal(finished.status, "timed_out");
    assert.equal(finished.metadata.mechanicalOutcome.code, "provider_print_timeout");
    assert.equal(finished.metadata.providerFacts.providerTimeout.duration, "7m36s");
    assert.equal(finished.metadata.providerFinalAnswer, null);
    assert.equal(finished.metadata.deliveryOutcome.outcome, "not_completed");
    assert.match(finished.errorText, /print timeout/);
    assert.equal(plane.listTaskEvents(task.id).find(e => e.eventType === "task_finished").payload.status, "timed_out");
    const replay = replayDeliveryDiagnosis(finished, plane.listTaskEvents(task.id));
    assert.equal(replay.mechanicalOutcome.outcome, "timed_out");
    // Original successful-empty history gets a sidecar diagnosis, not mutation.
    const old = { ...finished, status: "completed_without_delivery", errorText: null };
    const before = JSON.stringify(old);
    const diagnosis = replayDeliveryDiagnosis(old, plane.listTaskEvents(task.id));
    assert.equal(diagnosis.mechanicalOutcome.code, "provider_print_timeout");
    assert.equal(JSON.stringify(old), before);
    assert.ok(diagnosis.mechanicalOutcome.evidence.providerTimeout.eventId);
  } finally { await plane.shutdown(); }
});

test("timeout-looking stdout, tool text, unrelated stderr and other providers do not set a timeout", () => {
  for (const [agent, stream, line] of [
    ["antigravity", "stdout", timeoutWarning],
    ["tencent-workbuddy", "stderr", timeoutWarning],
    ["antigravity", "stderr", "quoted: " + timeoutWarning],
    ["antigravity", "stderr", JSON.stringify({ tool_output: timeoutWarning })],
    ["antigravity", "stderr", "request timed out"],
  ]) {
    const facts = collectProviderDiagnosticLine(agent, line, emptyProviderFacts(), { stream });
    assert.equal(facts.providerTimeout, null);
  }
});

test("manual stop during slow cleanup cannot become a watchdog timeout", async () => {
  const config = defaultConfig();
  config.agents["claude-code"] = { ...config.agents["claude-code"], command: process.execPath,
    args: ["-e", "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),1600));setInterval(()=>{},1000)"] };
  const plane = new ControlPlane({ dataDir: await mkdtemp(join(tmpdir(), "acc-stop-deadline-")), config });
  try {
    const task = plane.createTask({ agent: "claude-code", cwd: process.cwd(), prompt: "stop race fixture", timeoutMs: 1000 });
    while (!plane.runtime.get(task.id)?.handle) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 150));
    const finished = await plane.stopTask(task.id);
    assert.equal(finished.status, "stopped");
    assert.equal(finished.metadata.mechanicalOutcome.outcome, "stopped");
    assert.equal(finished.errorText, "task stopped");
  } finally { await plane.shutdown(); }
});
