import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FinalAnswerCollector, normalizeDeliveryContract, snapshotDeliveryFiles, assessDelivery, replayDeliveryDiagnosis } from "../server/delivery.mjs";
import { collectProviderFacts, emptyProviderFacts, classifyMechanicalOutcome, defaultConfig, isTerminalStatus } from "../server/core.mjs";
import { ControlPlane, startControlServer } from "../server/service.mjs";
import { lineDecoder } from "../server/adapters.mjs";

const result = response => ({ event: "result", result: { status: "SUCCESS", response } });
const step = (text, state = "ACTIVE", index = 3) => ({ event: "step_update", step_update: { conversation_id: "fixture", step_index: index, state, step_type: "agent_response", text_delta: text } });
const mechanical = { outcome: "succeeded" };

test("UTF-8 streaming preserves Chinese text split at every byte and flushes the last JSON line", () => {
  const lines = [];
  const decoder = lineDecoder(line => lines.push(line));
  const first = JSON.stringify(result("最终报告：中文字符完整。"));
  const last = JSON.stringify(result("最后一行没有换行"));
  const bytes = Buffer.from(first + "\n" + last);
  for (let i = 0; i < bytes.length; i++) decoder.push(bytes.subarray(i, i + 1));
  decoder.flush();
  assert.deepEqual(lines, [first, last]);
});

test("streaming final fragments are joined without reasoning/progress or duplicated terminal text", () => {
  const collector = new FinalAnswerCollector("antigravity");
  collector.observe(step("progress", "DONE", 1), { eventId: 1 });
  collector.observe({ event: "step_update", step_update: { step_type: "thinking", text_delta: "private thinking" } });
  collector.observe(step("Final "), { eventId: 2 });
  collector.observe(step("report", "DONE"), { eventId: 3 });
  assert.equal(collector.answer, null, "step DONE is not task completion");
  collector.observe(result("Final report\n"), { eventId: 4 });
  assert.equal(collector.answer.text, "Final report");
  assert.deepEqual(collector.answer.evidence, { terminalEventId: 4, streamEventIds: [2, 3], confirmation: "stream-confirmed-by-terminal-result" });
});

test("empty terminal response never promotes arbitrary agent progress to a required report", () => {
  const collector = new FinalAnswerCollector("antigravity");
  collector.observe(step("I read some files", "DONE"));
  collector.observe(result(""));
  assert.equal(collector.answer, null);
  assert.equal(assessDelivery({ contract: { type: "final_answer" }, finalAnswer: collector.answer, mechanicalOutcome: mechanical }).outcome, "missing_required_final_answer");
});

test("a delivered error report remains distinct from failed execution and unperformed semantic acceptance", () => {
  const delivery = assessDelivery({ contract: { type: "final_answer" }, finalAnswer: { text: "The requested operation was denied." }, mechanicalOutcome: { outcome: "failed" } });
  assert.equal(delivery.outcome, "complete");
  assert.equal(delivery.semanticVerification, "not_performed");
});

test("other explicit terminal answer shapes work and later empty turns cannot reuse prior answers", () => {
  const collector = new FinalAnswerCollector("antigravity");
  collector.observe({ conversation_id: "fixture", status: "SUCCESS", response: "json-envelope answer" });
  assert.equal(collector.answer.text, "json-envelope answer");
  collector.observe({ event: "result", result: { status: "SUCCESS", response: "", structured_output: { report: "done" }, json_schema: { type: "object" } } });
  assert.equal(collector.answer.eventType, "result/structured_output");
  collector.observe(result(""));
  assert.equal(collector.answer, null);
  collector.observe(result("stderr spoof"), { stream: "stderr" });
  assert.equal(collector.answer, null);
});

test("delivery defaults are explicit and do not infer semantics from prompts", () => {
  assert.deepEqual(normalizeDeliveryContract(undefined, { agent: "antigravity" }), { type: "final_answer" });
  assert.deepEqual(normalizeDeliveryContract(undefined, { agent: "codex-cli" }), { type: "execution_only" });
  assert.throws(() => normalizeDeliveryContract({ type: "files", files: [] }), /explicit files/);
});

test("file contracts verify explicit changed regular artifacts without requiring a text answer", () => {
  const root = mkdtempSync(join(tmpdir(), "acc-delivery-files-"));
  try {
    const policy = { effective: { filesystemScope: [root] } };
    const contract = normalizeDeliveryContract({ type: "files", files: [{ path: "report.txt" }] }, { cwd: root, permissionPolicy: policy });
    const before = snapshotDeliveryFiles(contract, policy);
    writeFileSync(join(root, "report.txt"), "fixture report");
    const files = snapshotDeliveryFiles(contract, policy);
    assert.equal(assessDelivery({ contract, mechanicalOutcome: mechanical, before, files }).outcome, "complete");
    assert.equal(assessDelivery({ contract, mechanicalOutcome: mechanical, before: files, files }).outcome, "missing_required_files", "an unchanged preexisting file is not a new delivery");
    const explicitExisting = { ...contract, files: contract.files.map(file => ({ ...file, requireChanged: false })) };
    assert.equal(assessDelivery({ contract: explicitExisting, mechanicalOutcome: mechanical, files }).outcome, "complete");
    assert.equal(assessDelivery({ contract, mechanicalOutcome: { outcome: "timed_out" }, before, files }).outcome, "not_completed");
    assert.throws(() => normalizeDeliveryContract({ type: "files", files: [{ path: "../escape.txt" }] }, { cwd: root, permissionPolicy: policy }), /traversal/);
    assert.throws(() => normalizeDeliveryContract({ type: "files", files: [{ path: ".env" }] }, { cwd: root, permissionPolicy: policy }), /sensitive/);
    symlinkSync(join(root, "report.txt"), join(root, "link.txt"));
    const link = normalizeDeliveryContract({ type: "files", files: [{ path: "link.txt" }] }, { cwd: root, permissionPolicy: policy });
    assert.equal(snapshotDeliveryFiles(link, policy)[0].state, "not_regular_file");
    mkdirSync(join(root, "nested"));
    const outside = mkdtempSync(join(tmpdir(), "acc-delivery-outside-"));
    try {
      writeFileSync(join(outside, "escape.txt"), "outside fixture");
      symlinkSync(outside, join(root, "outside"));
      const escaped = normalizeDeliveryContract({ type: "files", files: [{ path: "outside/escape.txt" }] }, { cwd: root, permissionPolicy: policy });
      assert.equal(snapshotDeliveryFiles(escaped, policy)[0].state, "outside_scope");
    } finally { rmSync(outside, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminal SUCCESS reason is not the first intermediate DONE; permissions still override success", () => {
  const facts = emptyProviderFacts();
  collectProviderFacts(step("", "DONE"), facts);
  collectProviderFacts(result(""), facts);
  assert.equal(classifyMechanicalOutcome({ result: { exitCode: 0 }, providerFacts: facts }).reason, "provider reported status SUCCESS");
  collectProviderFacts({ event: "result", result: { status: "SUCCESS", denied_actions: ["command"] } }, facts);
  assert.equal(classifyMechanicalOutcome({ result: { exitCode: 0 }, providerFacts: facts }).code, "provider_denied_actions");
});

test("actual model requires explicit envelope evidence, not requested/default/tool model strings", () => {
  const facts = emptyProviderFacts();
  collectProviderFacts({ event: "init", init: { model: "requested-only" } }, facts);
  collectProviderFacts({ tool_info: { model: "tool-claim", actual_model: "tool-claim" } }, facts);
  assert.equal(facts.actualModel, null);
  collectProviderFacts({ event: "result", result: { status: "SUCCESS", actual_model: "provider-reported" } }, facts);
  assert.equal(facts.actualModel, "provider-reported");
});

function fixtureConfig(events, extra = "") {
  const config = defaultConfig();
  config.agents.antigravity = { ...config.agents.antigravity, command: process.execPath, args: ["-e", `for(const e of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(e)+"\\n");${extra}`, "--"], permissionMapping: { strategy: "test-double" } };
  return config;
}

test("SUCCESS/zero exit with empty answer persists separate outcomes through API, summary and terminal events", async () => {
  const root = mkdtempSync(join(tmpdir(), "acc-missing-delivery-"));
  const running = await startControlServer({ dataDir: root, port: 0, config: fixtureConfig([step("progress", "DONE"), result("")]) });
  try {
    const task = running.plane.createTask({ agent: "antigravity", cwd: root, prompt: "fixture report" });
    const finished = await running.plane.waitForTask(task.id, 5000);
    assert.equal(finished.status, "completed_without_delivery");
    assert.equal(finished.metadata.mechanicalOutcome.outcome, "succeeded");
    assert.equal(finished.metadata.deliveryOutcome.outcome, "missing_required_final_answer");
    assert.equal(finished.metadata.providerFinalAnswer, null);
    assert.equal(isTerminalStatus(finished.status), true);
    const event = running.plane.listTaskEvents(task.id, 0).find(e => e.eventType === "task_finished");
    assert.equal(event.payload.deliveryOutcome.outcome, "missing_required_final_answer");
    const payload = await fetch(`http://${running.host}:${running.port}/api/tasks/${task.id}`, { headers: { authorization: `Bearer ${running.plane.authToken}` } }).then(r => r.json());
    assert.equal(payload.resultSummary.semanticVerification, "not_performed");
    assert.equal(payload.resultSummary.deliveryOutcome.outcome, "missing_required_final_answer");
    assert.equal(payload.resultSummary.executionIdentity.status, "unknown");
    const page = running.plane.listTaskSummaryPage({ status: "completed_without_delivery" });
    assert.equal(page.tasks[0].deliveryOutcome.outcome, "missing_required_final_answer");
    await assert.rejects(running.plane.replyTask(task.id, "try again"), error => error.statusCode === 409 && error.recovery.resume === "unsupported");
    assert.equal(running.plane.getTask(task.id).attemptNo, 1);
  } finally { await running.close(); rmSync(root, { recursive: true, force: true }); }
});

test("explicit execution-only and file contracts do not force a long final text", async () => {
  const root = mkdtempSync(join(tmpdir(), "acc-file-delivery-"));
  const config = fixtureConfig([result("")], `require("node:fs").writeFileSync(${JSON.stringify(join(root, "report.txt"))},"fixture report "+process.pid);`);
  const plane = new ControlPlane({ dataDir: join(root, "data"), config });
  try {
    for (const deliveryContract of [{ type: "execution_only" }, { type: "files", files: [{ path: "report.txt" }] }]) {
      const task = plane.createTask({ agent: "antigravity", cwd: root, prompt: "fixture", deliveryContract });
      const finished = await plane.waitForTask(task.id, 5000);
      assert.equal(finished.status, "succeeded");
      assert.equal(finished.metadata.deliveryOutcome.outcome, deliveryContract.type === "files" ? "complete" : "not_required");
    }
  } finally { await plane.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("intermediate DONE cannot finalize a running process; timeout preserves public evidence without retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "acc-delivery-timeout-"));
  const plane = new ControlPlane({ dataDir: root, config: fixtureConfig([step("progress", "DONE")], "setTimeout(()=>{},6000);") });
  try {
    const task = plane.createTask({ agent: "antigravity", cwd: root, prompt: "fixture", timeoutMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(plane.getTask(task.id).status, "running");
    const finished = await plane.waitForTask(task.id, 5000);
    assert.equal(finished.status, "timed_out");
    assert.equal(finished.metadata.deliveryOutcome.outcome, "not_completed");
    assert.equal(finished.metadata.providerFinalAnswer, null);
    assert.ok(plane.listTaskEvents(task.id, 0).some(e => e.payload?.json?.step_update));
    assert.equal(finished.attemptNo, 1);
  } finally { await plane.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("unsupported native profile is synchronously blocked without running/spawn, including idempotent replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "acc-preflight-delivery-"));
  const config = defaultConfig();
  config.agents.antigravity.command = "/deliberately-missing-provider";
  const plane = new ControlPlane({ dataDir: root, config });
  try {
    const input = { agent: "antigravity", cwd: root, prompt: "fixture", permissionPolicy: { writeAllowed: true, networkAllowed: false }, idempotencyKey: "preflight-fixture" };
    const task = plane.createTaskRequest(input).task;
    assert.equal(task.status, "blocked_preflight");
    assert.equal(task.startedAt, null);
    assert.equal(task.metadata.preflight.providerStarted, false);
    assert.equal(task.permissionPolicy.effective.networkAllowed, false);
    assert.equal(task.permissionPolicy.executionProfile.status, "UNSUPPORTED");
    assert.equal(plane.activeCount, 0);
    assert.equal(plane.queue.length, 0);
    const events = plane.listTaskEvents(task.id, 0);
    assert.ok(!events.some(e => ["task_started", "provider_started"].includes(e.eventType)));
    assert.equal(plane.createTaskRequest(input).reused, true);
    assert.equal(plane.listTaskEvents(task.id, 0).length, events.length);
  } finally { await plane.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("read-only replay diagnostics do not mutate historical successful-empty records", () => {
  const task = { id: "historical-fixture", agent: "antigravity", status: "succeeded", metadata: { mechanicalOutcome: mechanical } };
  const original = JSON.stringify(task);
  const diagnostic = replayDeliveryDiagnosis(task, [{ id: 1, stream: "stdout", payload: { json: result("") } }]);
  assert.equal(diagnostic.deliveryOutcome.outcome, "missing_required_final_answer");
  assert.equal(JSON.stringify(task), original);
  assert.equal(diagnostic.originalRecordModified, false);
});

test("HTTP creation clearly returns blocked preflight rather than accepted/running, without widening permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "acc-preflight-http-"));
  const config = defaultConfig();
  config.agents.antigravity.command = "/deliberately-missing-provider";
  const running = await startControlServer({ dataDir: root, port: 0, config });
  try {
    const response = await fetch(`http://${running.host}:${running.port}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${running.plane.authToken}` }, body: JSON.stringify({ agent: "antigravity", cwd: root, prompt: "fixture", permissionPolicy: { writeAllowed: true, networkAllowed: false } }) });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.task.status, "blocked_preflight");
    assert.equal(payload.resultSummary.mechanicalOutcome.outcome, "not_started");
    assert.equal(payload.resultSummary.preflight.providerStarted, false);
    assert.equal(payload.resultSummary.permission.effective.writeAllowed, true);
    assert.equal(payload.resultSummary.permission.effective.networkAllowed, false);
  } finally { await running.close(); rmSync(root, { recursive: true, force: true }); }
});

test("delivery contracts participate in idempotency and unsupported recovery never changes attempts", async () => {
  const root = mkdtempSync(join(tmpdir(), "acc-delivery-idempotent-"));
  const config = fixtureConfig([result("")]); config.maxConcurrentTasks = 0;
  const plane = new ControlPlane({ dataDir: root, config });
  try {
    const input = { agent: "antigravity", cwd: root, prompt: "fixture", idempotencyKey: "contract-fixture", deliveryContract: { type: "execution_only" } };
    const task = plane.createTaskRequest(input).task;
    assert.equal(plane.createTaskRequest(input).reused, true);
    assert.throws(() => plane.createTaskRequest({ ...input, deliveryContract: { type: "final_answer" } }), /idempotency_conflict/);
    await plane.stopTask(task.id);
    const finished = plane.getTask(task.id);
    assert.equal(finished.status, "stopped");
    await assert.rejects(plane.replyTask(task.id, "continue"), /provider_resume_unsupported/);
    assert.equal(plane.getTask(task.id).attemptNo, 1);
  } finally { await plane.shutdown(); rmSync(root, { recursive: true, force: true }); }
});
