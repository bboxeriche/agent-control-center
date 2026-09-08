import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CliAdapter } from "../server/adapters.mjs";
import {
  ANTIGRAVITY_CONTAINMENT_STRATEGY,
  buildSandboxProfile,
  networkTargetAllowed,
  prepareAntigravityContainment,
} from "../server/antigravity-containment.mjs";
import {
  NATIVE_PERMISSION_MAPPING_UNAVAILABLE,
  NativePermissionMappingUnavailableError,
  createEphemeralPermissionLifecycle,
  rulesForEffectivePolicy,
} from "../server/antigravity-permissions.mjs";

const workspace = process.cwd();

test("uses task-scoped external containment when native agy mapping is unavailable", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("sandbox-exec fallback is macOS-specific");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "acc-containment-test-"));
  const taskRoot = join(root, "tasks");
  const scopeA = join(root, "scope-a");
  const scopeB = join(root, "scope-b");
  const { mkdirSync, rmSync } = await import("node:fs");
  mkdirSync(taskRoot);
  mkdirSync(scopeA);
  mkdirSync(scopeB);
  const [first, second] = await Promise.all([
    prepareAntigravityContainment({
      taskId: "task-a",
      cwd: scopeA,
      permissionPolicy: { effective: { writeAllowed: true, networkAllowed: false, filesystemScope: [scopeA] } },
      config: { taskRoot, providerHosts: ["daily-cloudcode-pa.googleapis.com"] },
      command: "/bin/sh",
    }),
    prepareAntigravityContainment({
      taskId: "task-b",
      cwd: scopeB,
      permissionPolicy: { effective: { writeAllowed: false, networkAllowed: true, filesystemScope: [scopeB] } },
      config: { taskRoot, providerHosts: ["daily-cloudcode-pa.googleapis.com"] },
      command: "/bin/sh",
    }),
  ]);
  try {
    assert.equal(first.permissionReceipt.mechanism, ANTIGRAVITY_CONTAINMENT_STRATEGY);
    assert.equal(first.permissionReceipt.persistentSettingsMutation, false);
    assert.deepEqual(first.permissionReceipt.filesystemScope, [realpathSync(scopeA)]);
    assert.deepEqual(second.permissionReceipt.filesystemScope, [realpathSync(scopeB)]);
    assert.notEqual(first.env.HTTP_PROXY, second.env.HTTP_PROXY);
    assert.equal(first.argsFor(["-p", "probe"])[0], "-f");
    assert.ok(first.argsFor(["-p", "probe"]).includes("--dangerously-skip-permissions"));
    assert.ok(first.argsFor(["-p", "probe"]).includes("--log-file"));
    assert.equal(first.argsFor(["-p", "probe"], { skipPermissions: false }).includes("--dangerously-skip-permissions"), false);
    assert.equal(networkTargetAllowed("example.com", { networkAllowed: false, providerHosts: ["daily-cloudcode-pa.googleapis.com"] }), false);
    assert.equal(networkTargetAllowed("daily-cloudcode-pa.googleapis.com", { networkAllowed: false, providerHosts: ["daily-cloudcode-pa.googleapis.com"] }), true);
    assert.equal(networkTargetAllowed("example.com", { networkAllowed: true, providerHosts: [] }), true);
    assert.equal(networkTargetAllowed("127.0.0.1", { networkAllowed: true, providerHosts: [] }), false);

    const denied = await new Promise((resolve, reject) => {
      const proxy = new URL(first.env.HTTP_PROXY);
      const request = httpRequest({ hostname: proxy.hostname, port: proxy.port, path: "http://example.com/", headers: { host: "example.com" } }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject);
      request.end();
    });
    assert.equal(denied, 403);
  } finally {
    await Promise.all([first.cleanup("test"), second.cleanup("test")]);
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(existsSync(taskRoot), false);
});

test("fails closed for write=true/network=false because the fallback cannot revoke agy network tools", async () => {
  const adapter = new CliAdapter("antigravity", {
    command: process.execPath,
    args: ["-e", "process.exit(99)"],
    permissionMapping: { strategy: ANTIGRAVITY_CONTAINMENT_STRATEGY },
  });
  await assert.rejects(
    () => adapter.start({
      taskId: "unsafe-write-only",
      cwd: process.cwd(),
      prompt: "probe",
      permissionPolicy: { effective: { writeAllowed: true, networkAllowed: false, filesystemScope: [process.cwd()] } },
    }, () => {}),
    (error) => error instanceof NativePermissionMappingUnavailableError
      && error.code === NATIVE_PERMISSION_MAPPING_UNAVAILABLE
      && /cannot revoke agy's headless network tool/.test(error.message),
  );
});

test("profile has bounded writes and never grants Antigravity settings writes", () => {
  const profile = buildSandboxProfile({
    filesystemScope: [workspace],
    writeAllowed: true,
    networkProxyPort: 43210,
    runtimeRoot: join(homedir(), ".gemini", "antigravity-cli"),
    command: "/bin/sh",
  });
  assert.ok(profile.includes(`(allow file-write* (subpath "${workspace}"))`));
  assert.doesNotMatch(profile, /settings\.json/);
  assert.doesNotMatch(profile, /\.gemini\/config/);
  assert.match(profile, /network-outbound \(remote tcp "localhost:43210"\)/);
});

test("translates a denied write and denied network policy without grants", () => {
  const rules = rulesForEffectivePolicy({
    effective: { writeAllowed: false, networkAllowed: false, filesystemScope: [workspace] },
  });
  assert.deepEqual(rules.allow, []);
  assert.deepEqual(rules.deniedActions.write, ["write_file"]);
  assert.deepEqual(rules.deniedActions.network, ["read_url", "search_web"]);
});

test("translates bounded write-only policy and keeps network denied", () => {
  const rules = rulesForEffectivePolicy({
    effective: { writeAllowed: true, networkAllowed: false, filesystemScope: [workspace] },
  });
  assert.deepEqual(rules.allow, [`write_file(${workspace})`]);
  assert.deepEqual(rules.deniedActions.network, ["read_url", "search_web"]);
});

test("translates network-only policy without a write grant", () => {
  const rules = rulesForEffectivePolicy({
    effective: { writeAllowed: false, networkAllowed: true, filesystemScope: [workspace] },
  });
  assert.deepEqual(rules.allow, ["read_url(*)", "search_web(*)"]);
  assert.deepEqual(rules.deniedActions.write, ["write_file"]);
});

test("translates bounded write and network policy", () => {
  const rules = rulesForEffectivePolicy({
    effective: { writeAllowed: true, networkAllowed: true, filesystemScope: [workspace] },
  });
  assert.deepEqual(rules.allow, [`write_file(${workspace})`, "read_url(*)", "search_web(*)"]);
  assert.deepEqual(rules.deniedActions.write, []);
  assert.deepEqual(rules.deniedActions.network, []);
  assert.equal(rules.limitations.length, 1);
});

test("rejects traversal in a translated filesystem scope", () => {
  assert.throws(
    () => rulesForEffectivePolicy({ effective: { writeAllowed: true, filesystemScope: [`${workspace}/../outside`] } }),
    /parent traversal/,
  );
});

test("does not synthesize an unbounded write grant", () => {
  assert.throws(
    () => rulesForEffectivePolicy({ effective: { writeAllowed: true, networkAllowed: false } }),
    /explicit filesystem scope/,
  );
});

test("cleans an ephemeral permission lifecycle once and isolates concurrent scopes", async () => {
  const installed = [];
  const cleaned = [];
  const make = (taskId, scope) => createEphemeralPermissionLifecycle({
    taskId,
    rules: rulesForEffectivePolicy({ effective: { writeAllowed: true, filesystemScope: [scope] } }),
    install: async (context) => installed.push(context),
    cleanup: async (context) => cleaned.push(context),
  });
  const first = make("task-a", "/tmp/acc-scope-a");
  const second = make("task-b", "/tmp/acc-scope-b");
  await Promise.all([first.start(), second.start()]);
  await Promise.all([first.finish("stop"), first.finish("crash"), second.finish("timeout")]);
  assert.equal(first.state, "cleaned");
  assert.equal(second.state, "cleaned");
  assert.equal(installed.length, 2);
  assert.equal(cleaned.length, 2);
  assert.deepEqual(installed.map((item) => item.rules.filesystemScope).sort(), [["/tmp/acc-scope-a"], ["/tmp/acc-scope-b"]]);
  assert.deepEqual(cleaned.map((item) => item.taskId).sort(), ["task-a", "task-b"]);
});

test("fails closed before spawning Antigravity when native mapping is unavailable", () => {
  const adapter = new CliAdapter("antigravity", {
    command: process.execPath,
    args: ["-e", "process.exit(99)"],
  });
  assert.throws(
    () => adapter.start({
      prompt: "probe",
      cwd: process.cwd(),
      permissionPolicy: { effective: { writeAllowed: true, networkAllowed: true, filesystemScope: [workspace] } },
    }, () => {}),
    (error) => error instanceof NativePermissionMappingUnavailableError
      && error.code === NATIVE_PERMISSION_MAPPING_UNAVAILABLE
      && error.details.rules.allow.includes(`write_file(${workspace})`),
  );
});

test("fails closed even when ACC denies write and network", () => {
  const adapter = new CliAdapter("antigravity", {
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
  });
  assert.throws(
    () => adapter.start({
      prompt: "read-only probe",
      cwd: process.cwd(),
      permissionPolicy: { effective: { writeAllowed: false, networkAllowed: false, filesystemScope: [workspace] } },
    }, () => {}),
    (error) => error.code === NATIVE_PERMISSION_MAPPING_UNAVAILABLE,
  );
});
