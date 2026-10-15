import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_SENSITIVE_PATH_PATTERNS, redactSecrets, truncate, emptyProviderFacts, collectProviderFacts, collectProviderDiagnosticLine, classifyMechanicalOutcome } from "./core.mjs";

export const DELIVERY_CONTRACT_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["final_answer", "files", "execution_only"] },
    files: { type: "array", maxItems: 16, items: {
      type: "object", required: ["path"], additionalProperties: false,
      properties: { path: { type: "string" }, minBytes: { type: "integer", minimum: 1 }, sha256: { type: "string" }, requireChanged: { type: "boolean" } },
    } },
  },
  required: ["type"],
};

function within(root, path) {
  const part = relative(root, path);
  return part === "" || (!part.startsWith("..") && !isAbsolute(part));
}

export function normalizeDeliveryContract(input, { agent, cwd, permissionPolicy } = {}) {
  const raw = input ?? { type: agent === "antigravity" ? "final_answer" : "execution_only" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !["final_answer", "files", "execution_only"].includes(raw.type)) throw new Error("invalid deliveryContract.type");
  if (Object.keys(raw).some(key => !["type", "files"].includes(key))) throw new Error("unknown deliveryContract field");
  if (raw.type !== "files") {
    if (raw.files !== undefined) throw new Error("deliveryContract.files requires type=files");
    return { type: raw.type };
  }
  if (!Array.isArray(raw.files) || !raw.files.length || raw.files.length > 16) throw new Error("file delivery requires 1-16 explicit files");
  const effective = permissionPolicy?.effective || {};
  const roots = effective.filesystemScope || [cwd];
  const patterns = effective.sensitivePathPolicy?.mode === "allow" ? [] : (effective.sensitivePathPolicy?.patterns || DEFAULT_SENSITIVE_PATH_PATTERNS);
  const files = raw.files.map(file => {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || !file.path.trim() || file.path.includes("\0") || file.path.length > 4096) throw new Error("invalid delivery file path");
    if (Object.keys(file).some(key => !["path", "minBytes", "sha256", "requireChanged"].includes(key))) throw new Error("unknown delivery file field");
    if (file.path.split(/[\\/]+/).includes("..")) throw new Error("delivery file cannot contain traversal");
    const path = resolve(cwd, file.path);
    if (!roots.some(root => within(root, path))) throw new Error("delivery file outside authorized filesystem scope");
    if (patterns.some(pattern => new RegExp(pattern).test(path))) throw new Error("sensitive delivery file is denied");
    const minBytes = file.minBytes ?? 1;
    if (!Number.isSafeInteger(minBytes) || minBytes < 1 || minBytes > 32 * 1024 * 1024) throw new Error("invalid delivery file minBytes");
    if (file.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error("invalid delivery file sha256");
    if (file.requireChanged !== undefined && typeof file.requireChanged !== "boolean") throw new Error("invalid delivery file requireChanged");
    return { path, minBytes, requireChanged: file.requireChanged ?? true, ...(file.sha256 ? { sha256: file.sha256.toLowerCase() } : {}) };
  });
  if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("duplicate delivery files");
  return { type: "files", files };
}

function fileEvidence(file, roots, patterns) {
  try {
    if (!lstatSync(file.path).isFile()) return { path: file.path, state: "not_regular_file" };
    const canonical = realpathSync(file.path);
    if (!roots.some(root => within(realpathSync(root), canonical))) return { path: file.path, state: "outside_scope" };
    if (patterns.some(pattern => new RegExp(pattern).test(canonical))) return { path: file.path, state: "sensitive_path_denied" };
    const stat = lstatSync(canonical);
    if (stat.size > 32 * 1024 * 1024) return { path: file.path, state: "too_large" };
    const bytes = readFileSync(canonical);
    return { path: file.path, state: "verified", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    return { path: file.path, state: error.code === "ENOENT" ? "missing" : "unreadable" };
  }
}

export function snapshotDeliveryFiles(contract, permissionPolicy) {
  if (contract.type !== "files") return [];
  const effective = permissionPolicy.effective;
  const patterns = effective.sensitivePathPolicy?.mode === "allow" ? [] : (effective.sensitivePathPolicy?.patterns || DEFAULT_SENSITIVE_PATH_PATTERNS);
  return contract.files.map(file => fileEvidence(file, effective.filesystemScope, patterns));
}

// Only terminal protocol envelopes establish a final answer. Agent-response
// fragments are candidates, never independently promoted from progress to final.
export class FinalAnswerCollector {
  constructor(agent) { this.agent = agent; this.steps = new Map(); this.answer = null; }
  observe(value, { eventId = null, stream = "stdout" } = {}) {
    if (!value || stream !== "stdout") return;
    const step = value.event === "step_update" ? value.step_update : null;
    if (this.agent === "antigravity" && step?.step_type === "agent_response" && Number.isSafeInteger(step.step_index)) {
      const key = `${step.conversation_id || value.conversation_id || ""}:${step.step_index}`;
      const entry = this.steps.get(key) || { text: "", ids: [], done: false };
      if (!entry.done && typeof step.text_delta === "string") entry.text = truncate(entry.text + step.text_delta, 60000);
      if (eventId !== null && !entry.ids.includes(eventId)) entry.ids.push(eventId);
      entry.done ||= step.state === "DONE";
      this.steps.set(key, entry);
      if (this.steps.size > 16) this.steps.delete(this.steps.keys().next().value);
    }
    let text = "", eventType = "";
    if (this.agent === "antigravity") {
      const result = value.event === "result" ? value.result : !value.event && value.conversation_id && value.status ? value : null;
      if (!result) return;
      this.answer = null; // A later empty turn must not reuse an earlier answer.
      if (result.status !== "SUCCESS") return;
      if (typeof result.response === "string" && result.response.trim()) {
        text = result.response; eventType = "result/response";
      } else if (result.structured_output !== undefined && result.structured_output !== null && result.json_schema) {
        text = JSON.stringify(result.structured_output); eventType = "result/structured_output";
      }
    } else if (value.type === "result" && typeof value.result === "string") {
      text = value.result; eventType = "result";
    } else if (this.agent === "codex-cli" && value.type === "item.completed" && value.item?.type === "agent_message" && typeof value.item.text === "string") {
      text = value.item.text; eventType = "item.completed/agent_message";
    }
    if (!text.trim()) return;
    const matched = [...this.steps.values()].reverse().find(step => step.done && step.text.trim() === text.trim());
    this.answer = {
      source: "provider_final_event", eventType, text: truncate(redactSecrets(text.trim()), 60000),
      evidence: { terminalEventId: eventId, streamEventIds: matched?.ids || [], confirmation: matched ? "stream-confirmed-by-terminal-result" : "terminal-result" },
    };
  }
}

export function assessDelivery({ contract, finalAnswer, mechanicalOutcome, files = [], before = [] }) {
  const base = { contract, semanticVerification: "not_performed" };
  // Receiving a terminal report about a failed execution is still report
  // delivery; it does not turn mechanical failure into task or business success.
  if (contract.type === "final_answer" && finalAnswer?.text?.trim()) return { ...base, outcome: "complete", code: "required_final_answer_present", evidence: finalAnswer.evidence || { source: finalAnswer.source } };
  if (mechanicalOutcome?.outcome !== "succeeded") return { ...base, outcome: "not_completed", code: "execution_not_completed", evidence: { files, finalAnswerAvailable: Boolean(finalAnswer?.text) } };
  if (contract.type === "execution_only") return { ...base, outcome: "not_required", code: "execution_only_contract" };
  if (contract.type === "final_answer") return { ...base, outcome: "missing_required_final_answer", code: "missing_required_final_answer", reason: "execution ended successfully but the required final answer was not delivered" };
  const checks = contract.files.map(file => {
    const evidence = files.find(item => item.path === file.path) || { path: file.path, state: "not_verified" };
    const prior = before.find(item => item.path === file.path);
    const complete = evidence.state === "verified" && evidence.bytes >= file.minBytes
      && (!file.sha256 || file.sha256 === evidence.sha256)
      && (!file.requireChanged || (before.length > 0 && evidence.sha256 !== prior?.sha256));
    return { ...evidence, complete };
  });
  return { ...base, outcome: checks.every(file => file.complete) ? "complete" : "missing_required_files", code: checks.every(file => file.complete) ? "required_files_verified" : "missing_required_files", evidence: { files: checks } };
}

export function recoverySummary(task) {
  const resumable = task.capabilities?.resume === "supported" && Boolean(task.providerSessionId);
  return {
    resume: task.capabilities?.resume || "unknown", followUp: task.capabilities?.follow_up || "unknown",
    mode: resumable ? "explicit_bounded_resume" : "explicit_new_bounded_task",
    automaticRetry: false, evidenceCursor: task.eventCursor || 0,
    artifacts: task.metadata?.deliveryOutcome?.evidence?.files || [],
    unfinishedWork: "not_semantically_evaluated",
    limitation: resumable ? null : "inspect durable public events and authorized artifacts before explicitly creating a new task; no session continuation is qualified",
  };
}

export function replayDeliveryDiagnosis(task, events, contract = { type: "final_answer" }) {
  const collector = new FinalAnswerCollector(task.agent);
  const facts = emptyProviderFacts();
  for (const event of events) {
    collector.observe(event.payload?.json, { eventId: event.id, stream: event.stream || "stdout" });
    if (event.stream === "stdout") collectProviderFacts(event.payload?.json, facts);
    collectProviderDiagnosticLine(task.agent, event.payload?.line, facts, { stream: event.stream, eventId: event.id });
  }
  const blocked = task.permissionPolicy?.executionProfile?.status === "UNSUPPORTED" && !events.some(event => event.eventType === "provider_started");
  const mechanicalOutcome = blocked ? { outcome: "not_started", code: "blocked_preflight", reason: task.permissionPolicy.executionProfile.reason } : classifyMechanicalOutcome({
    result: { exitCode: task.exitCode, signal: task.signal, error: task.errorText, permissionCleanup: task.metadata?.permissionCleanup },
    providerFacts: facts, timedOut: task.status === "timed_out", stopRequested: task.status === "stopped",
  });
  return {
    taskId: task.id, historicalStatus: task.status, source: "read-only-event-replay", originalRecordModified: false,
    providerFinalAnswer: collector.answer,
    mechanicalOutcome,
    deliveryOutcome: blocked ? { outcome: "not_evaluated", code: "blocked_preflight", semanticVerification: "not_performed" } : assessDelivery({ contract, finalAnswer: collector.answer, mechanicalOutcome }),
    semanticVerification: "not_performed", recovery: recoverySummary(task),
  };
}
