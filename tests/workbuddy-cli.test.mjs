import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CliAdapter } from "../server/adapters.mjs";
import { defaultConfig, discoverWorkBuddyCli, workBuddyCliCandidates } from "../server/core.mjs";

const fixture = join(process.cwd(), "tests", "fixtures", "fake-agent.mjs");

test("discovers the bundled WorkBuddy CLI when it is installed outside PATH", () => {
  const bundled = workBuddyCliCandidates().find((candidate) => existsSync(candidate)) || "codebuddy";
  const discovered = discoverWorkBuddyCli();
  assert.equal(discovered, bundled);
  assert.equal(defaultConfig().agents["tencent-workbuddy"].command, discovered);
});

test("appends a requested model and uses the WorkBuddy resume template", async () => {
  const adapter = new CliAdapter("tencent-workbuddy", {
    command: process.execPath,
    args: [fixture, "-p", "{prompt}"],
    modelArgs: ["--model", "{model}"],
    resumeArgs: [fixture, "-p", "{prompt}", "--resume", "{sessionId}"],
    supportsResume: true,
  });
  const first = adapter.start({ prompt: "read-only smoke", cwd: process.cwd(), model: "HY4" }, () => {});
  assert.deepEqual(first.args, [fixture, "-p", "read-only smoke", "--model", "HY4"]);
  await first.wait;
  const resumed = adapter.start({ prompt: "follow-up smoke", cwd: process.cwd(), model: "HY4", sessionId: "session-1" }, () => {});
  assert.deepEqual(resumed.args, [fixture, "-p", "follow-up smoke", "--resume", "session-1", "--model", "HY4"]);
  await resumed.wait;
});

test("treats a structured provider error as failed even when the CLI exits zero", async () => {
  const script = "process.stdout.write(JSON.stringify({ type: 'result', result: '400 model [HY4] service info not found' }))";
  const events = [];
  const adapter = new CliAdapter("tencent-workbuddy", {
    command: process.execPath,
    args: ["-e", script],
    supportsResume: false,
  });
  const handle = adapter.start({ prompt: "smoke", cwd: process.cwd() }, (event) => events.push(event));
  const result = await handle.wait;
  assert.equal(result.exitCode, 0);
  assert.match(result.error, /service info not found/);
  assert.ok(events.some((event) => event.type === "provider_error"));
});

test("does not treat an explicitly successful result with an auxiliary error field as failed", async () => {
  const script = "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, error: 'unknown', result: 'ACC_E2E_OK' }))";
  const adapter = new CliAdapter("claude-code", {
    command: process.execPath,
    args: ["-e", script],
    supportsResume: false,
  });
  const handle = adapter.start({ prompt: "smoke", cwd: process.cwd() }, () => {});
  const result = await handle.wait;
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, null);
});
