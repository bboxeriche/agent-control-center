import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CliAdapter } from "../server/adapters.mjs";
import { codexCliCandidates, defaultConfig, discoverCodexCli, extractSessionId, extractText } from "../server/core.mjs";

test("discovers current and legacy desktop layouts without depending on a shell PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "acc-codex-discovery-"));
  try {
    const candidates = codexCliCandidates({ platform: "darwin", appRoots: [root] });
    const native = join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex");
    const launcher = join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin", "codex");
    const legacy = join(root, "ChatGPT.app", "Contents", "Resources", "codex");
    const codexApp = join(root, "Codex.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex");
    assert.deepEqual(candidates.slice(0, 3), [native, launcher, legacy]);
    assert.ok(candidates.includes(codexApp));
    assert.deepEqual(codexCliCandidates({ platform: "linux", appRoots: [root] }), []);
    assert.equal(discoverCodexCli(candidates), "codex");

    await mkdir(legacy, { recursive: true });
    assert.equal(discoverCodexCli(candidates), "codex", "directories must not be accepted as CLI executables");
    await rm(legacy, { recursive: true });
    await writeFile(legacy, "legacy fixture");
    assert.equal(discoverCodexCli(candidates), legacy);
    await mkdir(join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "bin"), { recursive: true });
    await writeFile(launcher, "launcher fixture");
    assert.equal(discoverCodexCli(candidates), launcher);
    await mkdir(join(root, "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS"), { recursive: true });
    await writeFile(native, "native fixture");
    assert.equal(discoverCodexCli(candidates), native, "prefer the current native bundle over legacy layouts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
  assert.equal(extractText({ type: "item.completed", item: { type: "agent_message", content: [{ type: "text", text: "nested " }, { type: "text", text: "provider result" }] } }), "nested provider result");
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
