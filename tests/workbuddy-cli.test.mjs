import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CliAdapter, commandArgs } from "../server/adapters.mjs";
import { networkTargetAllowed } from "../server/antigravity-containment.mjs";
import { defaultConfig, discoverWorkBuddyCli, workBuddyCliCandidates, classifyMechanicalOutcome } from "../server/core.mjs";
import { ControlPlane } from "../server/service.mjs";
import {
  preflightWorkBuddyExecutionProfile,
  workBuddyCapabilityReport,
  WORKBUDDY_CONTAINED_TOOLS,
  WORKBUDDY_CONTAINMENT_STRATEGY,
  WORKBUDDY_DEFAULT_MODEL,
  WORKBUDDY_NATIVE_PERMISSION_MODE,
  WorkBuddyPermissionMappingUnavailableError,
} from "../server/workbuddy-permissions.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const fixture = join(process.cwd(), "tests", "fixtures", "fake-agent.mjs");

test("prefers a standalone WorkBuddy CLI and skips lite-only desktop layouts", () => {
  const root = mkdtempSync(join(tmpdir(), "acc-wb-discovery-"));
  try {
    const bin = join(root, "standalone");
    const app = join(root, "desktop");
    mkdirSync(bin); mkdirSync(join(app, "bin"), { recursive: true }); mkdirSync(join(app, "dist"));
    const standalone = join(bin, "codebuddy");
    const bundled = join(app, "bin", "codebuddy");
    writeFileSync(standalone, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(bundled, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(app, "dist", "codebuddy-lite-wb.mjs"), "");
    assert.equal(discoverWorkBuddyCli({ candidates: [bundled], searchPath: bin }), standalone);
    assert.equal(discoverWorkBuddyCli({ candidates: [bundled], searchPath: "" }), "codebuddy");
    writeFileSync(join(app, "dist", "codebuddy-headless.js"), "");
    assert.equal(discoverWorkBuddyCli({ candidates: [bundled], searchPath: "" }), bundled);
    assert.equal(defaultConfig().agents["tencent-workbuddy"].command, discoverWorkBuddyCli());
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("permits the current WorkBuddy provider origin without granting task network access", () => {
  const providerHosts = defaultConfig().agents["tencent-workbuddy"].permissionMapping.providerHosts;
  const policy = { networkAllowed: false, providerHosts };
  assert.equal(networkTargetAllowed("www.workbuddy.cn", policy), true);
  assert.equal(networkTargetAllowed("copilot.tencent.com", policy), true);
  assert.equal(networkTargetAllowed("example.com", policy), false);
  assert.equal(networkTargetAllowed("www.workbuddy.cn.example.com", policy), false);
  assert.equal(networkTargetAllowed("127.0.0.1", policy), false);
});

test("marks WorkBuddy permission profiles unverified when the observed CLI version drifts", async () => {
  const config = defaultConfig().agents["tencent-workbuddy"];
  const adapter = new CliAdapter("tencent-workbuddy", {
    ...config,
    command: process.execPath,
    versionArgs: ["-e", "process.stdout.write('codebuddy 2.156.0')"],
    startupProbeArgs: ["-e", "process.stdout.write('--model --permission-mode --tools --output-format')"],
  });
  const health = await adapter.health();
  assert.equal(health.available, true);
  assert.equal(health.observedProviderVersion, "2.156.0");
  assert.equal(health.providerVersionValidation.status, "version_mismatch");
  assert.equal(health.providerVersionValidation.validatedProviderVersion, "2.106.4");
  for (const profile of Object.values(health.capabilityReport.executionProfiles)) {
    assert.notEqual(profile.status, "SUPPORTED");
  }
});

test("does not report WorkBuddy available when version works but runtime bootstrap fails", async () => {
  const adapter = new CliAdapter("tencent-workbuddy", {
    ...defaultConfig().agents["tencent-workbuddy"], command: process.execPath,
    versionArgs: ["-e", "console.log('2.161.0')"],
    startupProbeArgs: ["-e", "console.error(\"Cannot find module '../dist/codebuddy'\");process.exit(1)"],
  });
  const health = await adapter.health();
  assert.equal(health.available, false);
  assert.equal(health.version, "2.161.0");
  assert.equal(health.startupReadiness.available, false);
  assert.match(health.error, /Cannot find module/);
});

test("requires the headless permission and output options in WorkBuddy startup help", async () => {
  const adapter = new CliAdapter("tencent-workbuddy", {
    command: process.execPath, versionArgs: ["-e", "console.log('2.161.0')"],
    startupProbeArgs: ["-e", "console.log('lite help --model')"],
  });
  const health = await adapter.health();
  assert.equal(health.available, false);
  assert.match(health.error, /--permission-mode/);
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

test("explicit WorkBuddy overload fallback keeps the same invocation and permissions on initial/resume", () => {
  const config = {
    command: process.execPath, args: [fixture, "-p", "{prompt}"],
    resumeArgs: [fixture, "-p", "{prompt}", "--resume", "{sessionId}"], supportsResume: true,
    modelArgs: ["--model", "{model}"], fallbackModel: "hy4-preview",
    permissionMapping: { strategy: WORKBUDDY_CONTAINMENT_STRATEGY, nativePermissionMode: "bypassPermissions" },
  };
  for (const sessionId of [null, "existing-session"]) {
    const spec = { prompt: "fallback fixture", cwd: process.cwd(), model: "deepseek-v4.1-flash", sessionId,
      timeoutMs: 5000, permissionPolicy: { effective: { writeAllowed: false, networkAllowed: false, filesystemScope: [process.cwd()] } } };
    const args = commandArgs(config, spec);
    assert.equal(args[args.indexOf("--fallback-model") + 1], "hy4-preview");
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.equal(args[args.indexOf("--model") + 1], "deepseek-v4.1-flash");
    assert.equal(args.includes("--resume"), Boolean(sessionId));
    assert.equal(spec.timeoutMs, 5000);
    assert.equal(spec.permissionPolicy.effective.networkAllowed, false);
    assert.equal(commandArgs({ ...config, fallbackModel: null }, spec).includes("--fallback-model"), false);
  }
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

test("pins the WorkBuddy default model while preserving explicit provider overrides", async () => {
  const config = defaultConfig();
  config.maxConcurrentTasks = 0;
  const plane = new ControlPlane({ dataDir: await mkdtemp(join(tmpdir(), "acc-workbuddy-model-")), config });
  try {
    const defaultTask = plane.createTask({ agent: "tencent-workbuddy", prompt: "default model", cwd: process.cwd() });
    assert.equal(defaultTask.model, WORKBUDDY_DEFAULT_MODEL);
    assert.equal(defaultTask.metadata.providerModel.defaultModel, WORKBUDDY_DEFAULT_MODEL);
    assert.equal(defaultTask.metadata.providerModel.requestedModel, null);
    assert.equal(defaultTask.metadata.providerModel.resolvedModel, WORKBUDDY_DEFAULT_MODEL);

    const explicitTask = plane.createTask({
      agent: "tencent-workbuddy",
      model: "deepseek-v4-flash",
      prompt: "explicit provider model",
      cwd: process.cwd(),
    });
    assert.equal(explicitTask.model, "deepseek-v4-flash");
    assert.equal(explicitTask.metadata.providerModel.requestedModel, "deepseek-v4-flash");
    assert.equal(explicitTask.metadata.providerModel.resolvedModel, "deepseek-v4-flash");
  } finally {
    await plane.shutdown();
  }
});

test("reports WorkBuddy native bypass separately from external containment", () => {
  const config = defaultConfig().agents["tencent-workbuddy"];
  const report = workBuddyCapabilityReport(config);
  assert.equal(report.native.permissionMode, WORKBUDDY_NATIVE_PERMISSION_MODE);
  assert.equal(report.native.enforcement.write, "broad");
  assert.equal(report.mapping.strategy, WORKBUDDY_CONTAINMENT_STRATEGY);
  assert.equal(report.externalContainment.enforcement.write, "canonical-scope");
  assert.equal(report.externalContainment.enforcement.sensitivePaths, "default-deny");
  assert.equal(report.externalContainment.localLoopback, "not-denied-by-seatbelt-compatibility-rule");
  assert.match(report.externalContainment.networkProxyReason, /direct local-loopback connections/);
  assert.match(report.effectiveEnforcement.network, /direct-loopback-limitation/);
  assert.deepEqual(report.mapping.containedTools, [...WORKBUDDY_CONTAINED_TOOLS]);
  assert.equal(report.native.remoteNetworkTools, "disabled-in-contained-runs");
  assert.ok(["SUPPORTED", "UNSUPPORTED"].includes(report.executionProfiles.read_only.status));
  assert.ok(["SUPPORTED", "UNSUPPORTED"].includes(preflightWorkBuddyExecutionProfile({
    effective: { writeAllowed: false, networkAllowed: false, filesystemScope: [process.cwd()] },
  }).status));
  const unsafe = workBuddyCapabilityReport({
    ...config,
    permissionMapping: { ...config.permissionMapping, containedTools: [...WORKBUDDY_CONTAINED_TOOLS, "WebFetch"] },
  });
  assert.equal(unsafe.externalContainment.available, false);
  assert.equal(unsafe.executionProfiles.network_only.status, "UNSUPPORTED");
});

test("fails closed before spawning when a remote WorkBuddy network tool is re-enabled", async () => {
  const adapter = new CliAdapter("tencent-workbuddy", {
    command: process.execPath,
    args: ["-e", "process.exit(99)"],
    supportsResume: false,
    permissionMapping: {
      strategy: WORKBUDDY_CONTAINMENT_STRATEGY,
      nativePermissionMode: WORKBUDDY_NATIVE_PERMISSION_MODE,
      providerHosts: ["copilot.tencent.com"],
      containedTools: [...WORKBUDDY_CONTAINED_TOOLS, "WebFetch"],
    },
  });
  await assert.rejects(
    () => adapter.start({
      taskId: "unsafe-remote-tool",
      prompt: "probe",
      cwd: process.cwd(),
      permissionPolicy: { effective: { writeAllowed: false, networkAllowed: false, filesystemScope: [process.cwd()] } },
    }, () => {}),
    (error) => error instanceof WorkBuddyPermissionMappingUnavailableError
      && error.code === "workbuddy_permission_mapping_unavailable"
      && /remote WebFetch\/WebSearch/.test(error.message),
  );
});

test("fails closed before spawning when the WorkBuddy mapping is not approved", async () => {
  const adapter = new CliAdapter("tencent-workbuddy", {
    command: process.execPath,
    args: ["-e", "process.exit(99)"],
    supportsResume: false,
    permissionMapping: {},
  });
  assert.throws(
    () => adapter.start({
      taskId: "unknown-workbuddy-mapping",
      prompt: "probe",
      cwd: process.cwd(),
      permissionPolicy: { effective: { writeAllowed: false, networkAllowed: false, filesystemScope: [process.cwd()] } },
    }, () => {}),
    (error) => error instanceof WorkBuddyPermissionMappingUnavailableError
      && error.code === "workbuddy_permission_mapping_unavailable"
      && /native approval must run inside/.test(error.message),
  );
});

test("injects the WorkBuddy permission mode on both initial and resumed attempts", async () => {
  const adapter = new CliAdapter("tencent-workbuddy", {
    command: process.execPath,
    args: [fixture, "-p", "{prompt}"],
    resumeArgs: [fixture, "-p", "{prompt}", "--resume", "{sessionId}"],
    modelArgs: ["--model", "{model}"],
    supportsResume: true,
    permissionMapping: { strategy: "test-double", nativePermissionMode: WORKBUDDY_NATIVE_PERMISSION_MODE, containedTools: [...WORKBUDDY_CONTAINED_TOOLS] },
  });
  const policy = { effective: { writeAllowed: true, networkAllowed: false } };
  const first = adapter.start({ prompt: "initial", cwd: process.cwd(), model: WORKBUDDY_DEFAULT_MODEL, permissionPolicy: policy }, () => {});
  assert.deepEqual(first.args, [fixture, "-p", "initial", "--permission-mode", WORKBUDDY_NATIVE_PERMISSION_MODE, "--tools", WORKBUDDY_CONTAINED_TOOLS.join(","), "--model", WORKBUDDY_DEFAULT_MODEL]);
  await first.wait;
  const resumed = adapter.start({ prompt: "resume", cwd: process.cwd(), model: WORKBUDDY_DEFAULT_MODEL, sessionId: "wb-session", permissionPolicy: policy }, () => {});
  assert.deepEqual(resumed.args, [fixture, "-p", "resume", "--resume", "wb-session", "--permission-mode", WORKBUDDY_NATIVE_PERMISSION_MODE, "--tools", WORKBUDDY_CONTAINED_TOOLS.join(","), "--model", WORKBUDDY_DEFAULT_MODEL]);
  await resumed.wait;
});

test("closes the WorkBuddy permission false-success path from structured tool_result events", async () => {
  const script = [
    "process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'toolu-write',name:'Write',input:{}}]}})+'\\n')",
    "process.stdout.write(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu-write',is_error:true,content:'Error: Permission to use Write has been denied because this tool requires approval but permission prompts are not available in non-interactive mode'}]}})+'\\n')",
    "process.stdout.write(JSON.stringify({type:'result',subtype:'success',status:'completed',result:'I am unable to complete this probe'})+'\\n')",
  ].join(";");
  const adapter = new CliAdapter("tencent-workbuddy", {
    command: process.execPath,
    args: ["-e", script],
    supportsResume: false,
  });
  const handle = adapter.start({ prompt: "permission denial", cwd: process.cwd() }, () => {});
  const result = await handle.wait;
  assert.equal(result.exitCode, 0);
  assert.equal(result.providerFacts.structuredToolErrors.some((item) => item.code === "provider_permission_denied"), true);
  const outcome = classifyMechanicalOutcome({ result, providerFacts: result.providerFacts });
  assert.equal(outcome.outcome, "failed");
  assert.equal(outcome.code, "provider_permission_denied");
});

test("classifies WorkBuddy's sandbox-shaped EPERM tool_result as permission denial", async () => {
  const script = [
    "process.stdout.write(JSON.stringify({type:'assistant',model:'hy4-preview',message:{content:[{type:'tool_use',id:'toolu-write',name:'Write',input:{}}]}})+'\\n')",
    "process.stdout.write(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu-write',content:[{type:'text',text:'Error: Write error: EPERM: operation not permitted'}],is_error:false}]}})+'\\n')",
    "process.stdout.write(JSON.stringify({type:'result',subtype:'success',status:'completed',result:'Write was denied'})+'\\n')",
  ].join(";");
  const adapter = new CliAdapter("tencent-workbuddy", {
    command: process.execPath,
    args: ["-e", script],
    supportsResume: false,
  });
  const result = await adapter.start({ prompt: "sandbox denial", cwd: process.cwd() }, () => {}).wait;
  assert.equal(result.providerFacts.actualModel, "hy4-preview");
  assert.equal(classifyMechanicalOutcome({ result, providerFacts: result.providerFacts }).code, "provider_permission_denied");
});

test("does not treat a WorkBuddy tool_result with a nonzero raw exit code as success", async () => {
  const script = [
    "process.stdout.write(JSON.stringify({type:'assistant',role:'assistant',model:'hy4-preview',message:{content:[{type:'tool_use',id:'toolu-bash',name:'Bash',input:{command:'curl'}}]}})+'\\n')",
    "process.stdout.write(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu-bash',content:[{type:'text',text:'Command: curl\\nStdout: (empty)\\nStderr: 403\\n\\nExit Code: 22\\nSignal: (none)'}],is_error:false,_meta:{rawResponse:{exitCode:22,signal:null,sandboxDenied:false}}}]}})+'\\n')",
    "process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'403'})+'\\n')",
  ].join(";");
  const adapter = new CliAdapter("tencent-workbuddy", {
    command: process.execPath,
    args: ["-e", script],
    supportsResume: false,
  });
  const handle = adapter.start({ prompt: "nonzero tool result", cwd: process.cwd() }, () => {});
  const result = await handle.wait;
  assert.equal(result.exitCode, 0);
  assert.equal(result.providerFacts.structuredToolErrors.some((item) => item.code === "provider_tool_exit_nonzero"), true);
  assert.equal(classifyMechanicalOutcome({ result, providerFacts: result.providerFacts }).outcome, "failed");
});
