import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CliAdapter } from "../server/adapters.mjs";
import { codexCliCandidates, defaultConfig, discoverCodexCli, extractSessionId, extractText } from "../server/core.mjs";

test("discovers the local Codex CLI and keeps the configured Luna Max default", () => {
  const bundled = codexCliCandidates().find((candidate) => existsSync(candidate)) || "codex";
  const config = defaultConfig().agents["codex-cli"];
  assert.equal(discoverCodexCli(), bundled);
  assert.equal(config.command, bundled);
  assert.equal(config.defaultModel, "gpt-5.6-luna");
  assert.ok(config.args.includes("--json"));
  assert.ok(config.args.includes("workspace-write"));
  assert.equal(config.stdin, "ignore");
});

test("uses codex exec and its resume template with a literal model", async () => {
  const script = "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'codex-test-session' }))";
  const adapter = new CliAdapter("codex-cli", {
    command: process.execPath,
    args: ["-e", script, "{prompt}"],
    modelArgs: ["--model", "{model}"],
    resumeArgs: ["-e", script, "{sessionId}", "{prompt}"],
    supportsResume: true,
  });
  const first = adapter.start({ prompt: "first", cwd: process.cwd(), model: "gpt-5.6-luna" }, () => {});
  assert.deepEqual(first.args, ["-e", script, "first", "--model", "gpt-5.6-luna"]);
  await first.wait;
  const resumed = adapter.start({ prompt: "follow-up", cwd: process.cwd(), model: "gpt-5.6-luna", sessionId: "thread-1" }, () => {});
  assert.deepEqual(resumed.args, ["-e", script, "thread-1", "follow-up", "--model", "gpt-5.6-luna"]);
  await resumed.wait;
});

test("maps an explicitly read-only policy to Codex's native sandbox on a new attempt", async () => {
  const adapter = new CliAdapter("codex-cli", {
    command: process.execPath,
    args: ["-e", "process.exit(0)", "--sandbox", "workspace-write"],
    permissionMapping: { flag: "--sandbox", writeAllowed: "workspace-write", writeDenied: "read-only" },
    supportsResume: false,
  });
  const handle = adapter.start({
    prompt: "smoke",
    cwd: process.cwd(),
    permissionPolicy: { effective: { writeAllowed: false } },
  }, () => {});
  assert.deepEqual(handle.args, ["-e", "process.exit(0)", "--sandbox", "read-only"]);
  await handle.wait;
});

test("extracts Codex thread and agent-message fields from JSONL events", () => {
  assert.equal(extractSessionId({ type: "thread.started", thread_id: "thread-123" }), "thread-123");
  assert.equal(extractText({ type: "item.completed", item: { type: "agent_message", text: "ACC_CODEX_E2E_OK" } }), "ACC_CODEX_E2E_OK");
});

test("treats a Codex error event as a provider failure", async () => {
  const script = "process.stdout.write(JSON.stringify({ type: 'error', message: 'codex provider unavailable' }))";
  const events = [];
  const adapter = new CliAdapter("codex-cli", {
    command: process.execPath,
    args: ["-e", script],
    supportsResume: false,
  });
  const handle = adapter.start({ prompt: "smoke", cwd: process.cwd() }, (event) => events.push(event));
  const result = await handle.wait;
  assert.equal(result.exitCode, 0);
  assert.match(result.error, /codex provider unavailable/);
  assert.ok(events.some((event) => event.type === "provider_error"));
});
