import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyMechanicalOutcome,
  collectProviderFacts,
  emptyProviderFacts,
} from "../server/core.mjs";
import { ControlPlane } from "../server/service.mjs";
import { defaultConfig } from "../server/core.mjs";

test("classifies denied actions mechanically even when the provider exits zero", () => {
  const facts = collectProviderFacts({ status: "completed", denied_actions: ["write_file"] });
  const outcome = classifyMechanicalOutcome({ result: { exitCode: 0 }, providerFacts: facts });
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.code, "provider_denied_actions");
  assert.deepEqual(outcome.evidence.deniedActions, ["write_file"]);
});

test("classifies structured tool errors and provider failure statuses without semantic verification", () => {
  const facts = emptyProviderFacts();
  collectProviderFacts({ type: "tool_error", tool_name: "read_url", is_error: true, error: "blocked" }, facts);
  collectProviderFacts({ status: "failed" }, facts);
  const outcome = classifyMechanicalOutcome({ result: { exitCode: 0 }, providerFacts: facts });
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.code, "provider_structured_tool_error");
  assert.equal(outcome.evidence.structuredToolErrors[0].tool, "read_url");
  assert.ok(outcome.evidence.providerStatuses.includes("failed"));
  const statusOnly = classifyMechanicalOutcome({
    result: { exitCode: 0 },
    providerFacts: collectProviderFacts({ type: "result", status: "failed" }),
  });
  assert.equal(statusOnly.code, "provider_status_failed");
});

test("classifies containment cleanup failure and nonzero exit deterministically", () => {
  const cleanupFailure = classifyMechanicalOutcome({
    result: { exitCode: 0, permissionCleanup: { state: "failed", error: "cannot remove task directory" } },
  });
  assert.equal(cleanupFailure.code, "mechanical_containment_failed");
  const nonzero = classifyMechanicalOutcome({ result: { exitCode: 17, stderr: "provider failed" } });
  assert.equal(nonzero.code, "provider_exit_nonzero");
});

test("defaults sensitive paths to deny and requires an explicit per-task override", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-sensitive-policy-"));
  const config = defaultConfig();
  config.maxConcurrentTasks = 0;
  const plane = new ControlPlane({ dataDir, config });
  try {
    const denied = plane.createTask({ agent: "claude-code", prompt: "default sensitive policy", cwd: process.cwd() });
    assert.equal(denied.permissionPolicy.effective.sensitivePathPolicy.mode, "deny");
    assert.throws(
      () => plane.createTask({
        agent: "claude-code",
        prompt: "missing explicit override marker",
        cwd: process.cwd(),
        permissionPolicy: { sensitivePathPolicy: { mode: "allow" } },
      }),
      /override=true/,
    );
    const override = plane.createTask({
      agent: "claude-code",
      prompt: "explicit disposable override",
      cwd: process.cwd(),
      permissionPolicy: { sensitivePathPolicy: { mode: "allow", override: true } },
    });
    assert.equal(override.permissionPolicy.effective.sensitivePathPolicy.mode, "allow");
    assert.equal(override.permissionPolicy.effective.sensitivePathPolicy.override, true);
  } finally {
    await plane.shutdown();
  }
});

test("persists the mechanical outcome on a task and task_finished event", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "acc-mechanical-outcome-"));
  const script = "process.stdout.write(JSON.stringify({ type: 'result', status: 'completed', denied_actions: ['write_file'] }) + '\\n'); process.exit(0)";
  const config = defaultConfig();
  config.agents["claude-code"] = {
    ...config.agents["claude-code"],
    command: process.execPath,
    args: ["-e", script],
    env: { ...process.env },
  };
  const plane = new ControlPlane({ dataDir, config });
  try {
    const task = plane.createTask({ agent: "claude-code", prompt: "mechanical fixture", cwd: process.cwd() });
    const finished = await plane.waitForTask(task.id, 5000);
    assert.equal(finished.status, "failed");
    assert.equal(finished.metadata.mechanicalOutcome.code, "provider_denied_actions");
    const completion = plane.listTaskEvents(task.id, 0).find((event) => event.eventType === "task_finished");
    assert.equal(completion.payload.mechanicalOutcome.code, "provider_denied_actions");
    assert.deepEqual(completion.payload.providerFacts.deniedActions, ["write_file"]);
  } finally {
    await plane.shutdown();
  }
});
