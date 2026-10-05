import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CliAdapter } from "../server/adapters.mjs";
import { defaultConfig } from "../server/core.mjs";
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
  assert.equal(timeoutMs, 1_795_000);
  assert.ok(timeoutMs > 5 * 60_000);
  assert.ok(timeoutMs < 1_800_000);
  assert.equal(first.args[first.args.indexOf("--print-timeout") + 1], "29m55s");
  assert.equal(timeoutFromArgs(second.args), timeoutMs, "same task timeout must map deterministically");
  await Promise.all([first.wait, second.wait]);
});

test("different long task budgets produce different provider timeouts", async () => {
  const tenMinute = antigravityAdapter().start({ prompt: "ten", cwd: process.cwd(), timeoutMs: 600_000 }, () => {});
  const thirtyMinute = antigravityAdapter().start({ prompt: "thirty", cwd: process.cwd(), timeoutMs: 1_800_000 }, () => {});
  assert.equal(tenMinute.args[tenMinute.args.indexOf("--print-timeout") + 1], "9m55s");
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
