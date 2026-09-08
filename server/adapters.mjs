import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { prepareAntigravityContainment, ANTIGRAVITY_CONTAINMENT_STRATEGY } from "./antigravity-containment.mjs";
import { prepareWorkBuddyContainment } from "./workbuddy-containment.mjs";
import {
  antigravityCapabilityReport,
  NativePermissionMappingUnavailableError,
  preflightAntigravityExecutionProfile,
} from "./antigravity-permissions.mjs";
import {
  preflightWorkBuddyExecutionProfile,
  WorkBuddyPermissionMappingUnavailableError,
  workBuddyCapabilityReport,
  workBuddyModelReport,
  WORKBUDDY_CONTAINED_TOOLS,
  WORKBUDDY_CONTAINMENT_STRATEGY,
  WORKBUDDY_NATIVE_PERMISSION_MODE,
} from "./workbuddy-permissions.mjs";
import {
  capabilitiesFor,
  collectProviderFacts,
  emptyProviderFacts,
  fillTemplateArgs,
  parseProviderLine,
  redactSecrets,
  truncate,
} from "./core.mjs";

function lineDecoder(onLine) {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk.toString("utf8");
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line) onLine(line);
      }
    },
    flush() {
      const line = buffer.replace(/\r$/, "");
      buffer = "";
      if (line) onLine(line);
    },
  };
}

function commandArgs(config, spec) {
  const values = {
    prompt: spec.prompt,
    cwd: spec.cwd,
    sessionId: spec.sessionId || "",
    model: spec.model || "",
  };
  const template = spec.sessionId && config.supportsResume && config.resumeArgs?.length
    ? config.resumeArgs
    : config.args;
  const args = fillTemplateArgs(template, values);
  const permissionMapping = config.permissionMapping;
  if (permissionMapping?.flag && !spec.sessionId) {
    const flagIndex = args.indexOf(permissionMapping.flag);
    if (flagIndex >= 0 && args[flagIndex + 1] !== undefined) {
      const requestedValue = spec.permissionPolicy?.effective?.writeAllowed === false
        ? permissionMapping.writeDenied
        : permissionMapping.writeAllowed;
      if (requestedValue) args[flagIndex + 1] = requestedValue;
    }
  }
  if (permissionMapping?.nativePermissionMode && spec.permissionPolicy && !args.includes("--permission-mode")) {
    args.push("--permission-mode", permissionMapping.nativePermissionMode || WORKBUDDY_NATIVE_PERMISSION_MODE);
    if (!args.includes("--tools")) {
      const containedTools = Array.isArray(permissionMapping.containedTools) && permissionMapping.containedTools.length
        ? permissionMapping.containedTools
        : WORKBUDDY_CONTAINED_TOOLS;
      args.push("--tools", containedTools.join(","));
    }
  }
  if (spec.model && config.modelArgs?.length) {
    args.push(...fillTemplateArgs(config.modelArgs, values));
  }
  return args;
}

const PROVIDER_FAILURE_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "cancelled",
  "canceled",
  "rejected",
]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? truncate(value.trim(), 4000) : "";
}

function isExplicitProviderSuccess(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.is_error === false || value.isError === false) return true;
  const status = value.status ?? value.state ?? value.subtype;
  return ["success", "succeeded", "completed", "done"].includes(String(status || "").toLowerCase());
}

function nestedProviderError(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = nestedProviderError(item, depth + 1);
      if (nested) return nested;
    }
    return "";
  }
  if (isExplicitProviderSuccess(value)) return "";
  for (const key of ["error", "errorMessage", "error_message", "failure", "failureReason", "failure_reason"]) {
    const direct = nonEmptyString(value[key]);
    if (direct) return direct;
    const nested = nestedProviderError(value[key], depth + 1);
    if (nested) return nested;
  }
  const status = value.status ?? value.state;
  const type = String(value.type || "").toLowerCase();
  const typeReportsFailure = ["error", "failed", "failure", "cancelled", "canceled", "rejected"]
    .some((marker) => type === marker || type.endsWith(`.${marker}`) || type.endsWith(`_${marker}`) || type.endsWith(`-${marker}`));
  if (PROVIDER_FAILURE_STATUSES.has(String(status || "").toLowerCase()) || typeReportsFailure) {
    for (const key of ["message", "detail", "details", "text", "result", "output"]) {
      const detail = nonEmptyString(value[key]);
      if (detail) return detail;
    }
    return status ? `provider reported status ${status}` : `provider reported event ${type || "failure"}`;
  }
  const code = value.code ?? value.statusCode ?? value.httpStatus;
  if ((typeof code === "number" && code >= 400) || (typeof code === "string" && /^([45]\d{2})$/.test(code.trim()))) {
    const detail = nonEmptyString(value.message) || nonEmptyString(value.detail) || nonEmptyString(value.result);
    return `provider reported code ${code}${detail ? `: ${detail}` : ""}`;
  }
  for (const key of ["result", "data", "job", "response", "payload", "event"]) {
    const nested = nestedProviderError(value[key], depth + 1);
    if (nested) return nested;
  }
  return "";
}

const PROVIDER_ERROR_TEXT = /^\s*(?:[45]\d{2}\b[\s\S]*(?:model|service|error|failed|not found)|invalid model\b|model\b[\s\S]*(?:not found|service info not found|invalid)|service info not found\b|(?:authentication|authorization) failed\b|(?:unauthorized|forbidden)\b)/i;

function providerSemanticError(value, text = "") {
  const structured = nestedProviderError(value);
  if (structured) return structured;
  for (const candidate of [value?.result, value?.error, value?.failure, value?.message, text]) {
    const detail = nonEmptyString(candidate);
    if (detail && PROVIDER_ERROR_TEXT.test(detail)) return detail;
  }
  return "";
}

function boundedProviderFact(value, max = 800) {
  return truncate(redactSecrets(String(value ?? "").trim()), max);
}

function workBuddyToolName(value) {
  if (!value || typeof value !== "object") return "";
  return String(value.name || value.tool_name || value.toolName || value.tool || value.action || "").trim();
}

function workBuddyToolUseId(value) {
  if (!value || typeof value !== "object") return "";
  return String(value.id || value.tool_use_id || value.toolUseId || "").trim();
}

function workBuddyContentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => workBuddyContentText(item)).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  return [value.text, value.message, value.error, value.detail, value.result, value.content, value.output, value.response]
    .map((item) => (item && typeof item === "object" ? workBuddyContentText(item) : item))
    .filter((item) => typeof item === "string" && item.trim())
    .join("\n");
}

function addWorkBuddyStructuredError(facts, { tool = "", code = "provider_structured_tool_error", message = "" } = {}) {
  const entry = {
    tool: boundedProviderFact(tool, 200) || null,
    code: boundedProviderFact(code, 200) || null,
    message: boundedProviderFact(message, 800) || "structured WorkBuddy tool error",
  };
  const fingerprint = JSON.stringify(entry);
  if (!facts.structuredToolErrors.some((item) => JSON.stringify(item) === fingerprint) && facts.structuredToolErrors.length < 32) {
    facts.structuredToolErrors.push(entry);
  }
}

function workBuddyPermissionDenial(value) {
  const text = workBuddyContentText(value);
  const match = text.match(/Error:\s*Permission to use ([A-Za-z][A-Za-z0-9_.:-]*) has been denied\b/i);
  if (match) return { tool: match[1], message: text };
  if (/Error:\s*.*permission.*denied\b/i.test(text)) return { tool: "", message: text };
  // WorkBuddy currently serializes an external sandbox denial as a failed
  // tool_result with is_error=false, for example "Error: Write error: EPERM".
  // Keep this fallback provider-specific and restricted to the structured
  // tool_result path; it is not a general natural-language verifier.
  if (/Error:\s*(?:[A-Za-z][A-Za-z0-9_.:-]*\s+error:\s*)?(?:EPERM|EACCES|operation not permitted)\b/i.test(text)) {
    return { tool: "", message: text };
  }
  return null;
}

function workBuddyToolResultFailure(value) {
  const rawResponse = value?._meta?.rawResponse || value?.meta?.rawResponse || value?.rawResponse;
  if (rawResponse && rawResponse.sandboxDenied === true) {
    return { code: "provider_permission_denied", message: workBuddyContentText(value) || "WorkBuddy sandbox denied the tool" };
  }
  const rawExitCode = rawResponse?.exitCode ?? rawResponse?.exit_code;
  if (Number.isFinite(Number(rawExitCode)) && Number(rawExitCode) !== 0) {
    return { code: "provider_tool_exit_nonzero", message: workBuddyContentText(value) || `WorkBuddy tool exited with code ${rawExitCode}` };
  }
  const text = workBuddyContentText(value);
  const exitMatch = text.match(/\b(?:Exit Code|exit_code|exit code)\s*:\s*(-?\d+)\b/i);
  if (exitMatch && Number(exitMatch[1]) !== 0) {
    return { code: "provider_tool_exit_nonzero", message: text };
  }
  return null;
}

function collectWorkBuddyProviderFacts(value, facts, toolUses = new Map(), depth = 0) {
  if (!value || depth > 10) return facts;
  if (Array.isArray(value)) {
    for (const item of value) collectWorkBuddyProviderFacts(item, facts, toolUses, depth + 1);
    return facts;
  }
  if (typeof value !== "object") return facts;

  const type = String(value.type || "").toLowerCase();
  for (const key of ["actual_model", "actualModel", "resolved_model", "resolvedModel"]) {
    if (typeof value[key] === "string" && value[key].trim()) facts.actualModel = boundedProviderFact(value[key], 200);
  }
  if ((["assistant", "result"].includes(type) || value.role === "assistant") && typeof value.model === "string" && value.model.trim()) {
    facts.actualModel = boundedProviderFact(value.model, 200);
  }
  if (type === "tool_use") {
    const id = workBuddyToolUseId(value);
    const name = workBuddyToolName(value);
    if (id && name) toolUses.set(id, name);
  }
  if (type === "tool_result") {
    const tool = toolUses.get(workBuddyToolUseId(value)) || workBuddyToolName(value) || "unknown";
    const denial = workBuddyPermissionDenial(value);
    const toolFailure = workBuddyToolResultFailure(value);
    if (denial || toolFailure || value.is_error === true || value.isError === true) {
      addWorkBuddyStructuredError(facts, {
        tool: denial?.tool || tool,
        code: denial?.message ? "provider_permission_denied" : toolFailure?.code || "provider_structured_tool_error",
        message: denial?.message || toolFailure?.message || workBuddyContentText(value),
      });
    }
  }

  for (const key of ["permission_denials", "permissionDenials", "permission-denials"]) {
    const denials = value[key];
    if (!denials) continue;
    const values = Array.isArray(denials) ? denials : [denials];
    for (const item of values) {
      const action = typeof item === "string" ? item : workBuddyToolName(item) || item?.action || item?.name || "unknown";
      const message = workBuddyContentText(item) || `WorkBuddy denied ${action}`;
      addWorkBuddyStructuredError(facts, { tool: action, code: "provider_permission_denied", message });
    }
  }

  for (const key of ["errors", "error_details", "errorDetails"]) {
    const errors = value[key];
    if (!errors) continue;
    const values = Array.isArray(errors) ? errors : [errors];
    for (const item of values) {
      const message = workBuddyContentText(item) || boundedProviderFact(item, 800);
      if (message) addWorkBuddyStructuredError(facts, { tool: workBuddyToolName(item), message });
    }
  }

  for (const nested of Object.values(value)) collectWorkBuddyProviderFacts(nested, facts, toolUses, depth + 1);
  return facts;
}

async function probeCommand(command, versionArgs = ["--version"]) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, latencyMs: Date.now() - startedAt });
    };
    try {
      child = spawn(command, versionArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ available: false, error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ available: false, error: "version probe timed out" });
    }, 3000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ available: false, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish({
        available: code === 0,
        version: truncate(redactSecrets(output).trim(), 300),
        exitCode: code,
        signal,
        error: code === 0 ? null : truncate(redactSecrets(output).trim(), 500),
      });
    });
  });
}

function emitSafely(onEvent, event) {
  try {
    onEvent(event);
  } catch {
    // Event persistence must not crash a provider process.
  }
}

export class CliAdapter {
  constructor(agentId, config) {
    this.agentId = agentId;
    this.config = config;
  }

  async health() {
    const probe = await probeCommand(this.config.command, this.config.versionArgs || ["--version"]);
    const capabilityReport = this.agentId === "antigravity"
      ? antigravityCapabilityReport(this.config.permissionMapping || {})
      : this.agentId === "tencent-workbuddy"
        ? workBuddyCapabilityReport(this.config)
        : null;
    const modelReport = this.agentId === "tencent-workbuddy"
      ? workBuddyModelReport(this.config)
      : {};
    return {
      agent: this.agentId,
      label: this.config.label || this.agentId,
      kind: "cli",
      command: this.config.command,
      permissionMapping: capabilityReport
        ? { ...(this.config.permissionMapping || { strategy: "unknown" }), capabilityReport }
        : this.config.permissionMapping || { strategy: "unknown" },
      capabilityReport,
      capabilities: capabilitiesFor(this.agentId, { agents: { [this.agentId]: this.config } }),
      ...modelReport,
      ...probe,
    };
  }

  start(spec, onEvent) {
    if (this.agentId === "antigravity" && this.config.permissionMapping?.strategy === ANTIGRAVITY_CONTAINMENT_STRATEGY) {
      return this.startContained(spec, onEvent);
    }
    if (this.agentId === "antigravity" && spec.permissionPolicy && this.config.permissionMapping?.strategy !== "test-double") {
      // agy 1.1.27 has no per-process native permission override. Do not let a
      // persistent provider grant drift away from ACC's task policy.
      throw new NativePermissionMappingUnavailableError(spec.permissionPolicy);
    }
    if (this.agentId === "tencent-workbuddy" && this.config.permissionMapping?.strategy === WORKBUDDY_CONTAINMENT_STRATEGY) {
      return this.startWorkBuddyContained(spec, onEvent);
    }
    if (this.agentId === "tencent-workbuddy" && spec.permissionPolicy && this.config.permissionMapping?.strategy !== "test-double") {
      const mapping = this.config.permissionMapping || {};
      const preflight = preflightWorkBuddyExecutionProfile(spec.permissionPolicy, {
        strategy: mapping.strategy || "unknown",
        sandboxExecutable: mapping.sandboxExecutable || "/usr/bin/sandbox-exec",
        nativePermissionMode: mapping.nativePermissionMode || WORKBUDDY_NATIVE_PERMISSION_MODE,
        providerHosts: mapping.providerHosts,
        containedTools: mapping.containedTools,
      });
      throw new WorkBuddyPermissionMappingUnavailableError(
        spec.permissionPolicy,
        preflight.reason || "approved WorkBuddy containment mapping is unavailable",
        preflight,
      );
    }

    return this.startProcess(spec, onEvent, {
      command: this.config.command,
      args: commandArgs(this.config, spec),
      env: this.config.env,
    });
  }

  async startContained(spec, onEvent) {
    const effective = spec.permissionPolicy?.effective || spec.permissionPolicy || {};
    const preflight = preflightAntigravityExecutionProfile(spec.permissionPolicy, {
      strategy: this.config.permissionMapping?.strategy || ANTIGRAVITY_CONTAINMENT_STRATEGY,
      sandboxExecutable: this.config.permissionMapping?.sandboxExecutable || "/usr/bin/sandbox-exec",
    });
    if (preflight.status !== "SUPPORTED") {
      throw new NativePermissionMappingUnavailableError(
        spec.permissionPolicy,
        preflight.reason,
        preflight,
      );
    }
    const containment = await prepareAntigravityContainment({
      taskId: spec.taskId,
      cwd: spec.cwd,
      permissionPolicy: spec.permissionPolicy,
      config: this.config.permissionMapping,
      command: this.config.command,
    });
    try {
      return this.startProcess(spec, onEvent, {
        command: containment.sandboxExecutable,
        args: containment.argsFor(commandArgs(this.config, spec), {
          // With no capabilities requested, leave agy in its own headless
          // request-review mode so native write/network requests are denied.
          // Any policy that needs a capability uses the skip flag, with the
          // external sandbox enforcing the remaining filesystem boundary.
          skipPermissions: effective.writeAllowed === true || effective.networkAllowed === true,
        }),
        env: { ...this.config.env, ...containment.env },
        cleanup: containment.cleanup,
        permissionReceipt: containment.permissionReceipt,
      });
    } catch (error) {
      await containment.cleanup("spawn_error").catch(() => {});
      throw error;
    }
  }

  async startWorkBuddyContained(spec, onEvent) {
    const mapping = this.config.permissionMapping || {};
    const preflight = preflightWorkBuddyExecutionProfile(spec.permissionPolicy, {
      strategy: mapping.strategy || WORKBUDDY_CONTAINMENT_STRATEGY,
      sandboxExecutable: mapping.sandboxExecutable || "/usr/bin/sandbox-exec",
      nativePermissionMode: mapping.nativePermissionMode || WORKBUDDY_NATIVE_PERMISSION_MODE,
      providerHosts: mapping.providerHosts,
      containedTools: mapping.containedTools,
    });
    if (preflight.status !== "SUPPORTED") {
      throw new WorkBuddyPermissionMappingUnavailableError(
        spec.permissionPolicy,
        preflight.reason,
        preflight,
      );
    }
    let containment;
    try {
      containment = await prepareWorkBuddyContainment({
        taskId: spec.taskId,
        cwd: spec.cwd,
        permissionPolicy: spec.permissionPolicy,
        config: mapping,
        command: this.config.command,
      });
      return this.startProcess(spec, onEvent, {
        command: containment.sandboxExecutable,
        args: containment.argsFor(commandArgs(this.config, spec)),
        env: { ...this.config.env, ...containment.env },
        cleanup: containment.cleanup,
        permissionReceipt: containment.permissionReceipt,
      });
    } catch (error) {
      await containment?.cleanup("spawn_error").catch(() => {});
      throw error;
    }
  }

  startProcess(spec, onEvent, {
    command,
    args,
    env,
    cleanup = null,
    permissionReceipt = null,
  }) {
    const child = spawn(command, args, {
      cwd: spec.cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: [this.config.stdin === "ignore" ? "ignore" : "pipe", "pipe", "pipe"],
    });
    // These adapters are non-interactive by contract. Closing stdin prevents
    // CLIs that wait for terminal input from hanging indefinitely in headless use.
    child.stdin?.end();
    let providerSessionId = "";
    let stdout = "";
    let stderr = "";
    let semanticError = "";
    const providerFacts = emptyProviderFacts();
    let stopRequested = false;
    let settled = false;
    let finishing = false;
    const workBuddyToolUses = this.agentId === "tencent-workbuddy" ? new Map() : null;
    let resolveWait;
    const wait = new Promise((resolve) => {
      resolveWait = resolve;
    });
    const outputLine = (line, stream) => {
      const parsed = parseProviderLine(this.agentId, line);
      if (parsed.sessionId) providerSessionId = parsed.sessionId;
      collectProviderFacts(parsed.json, providerFacts);
      if (this.agentId === "tencent-workbuddy") {
        collectWorkBuddyProviderFacts(parsed.json, providerFacts, workBuddyToolUses);
      }
      const failure = providerSemanticError(parsed.json, parsed.text);
      if (failure && !semanticError) semanticError = failure;
      emitSafely(onEvent, {
        type: failure ? "provider_error" : parsed.json ? "provider_message" : stream === "stderr" ? "stderr" : "stdout",
        stream,
        text: failure || parsed.text,
        sessionId: parsed.sessionId || null,
        payload: {
          line: parsed.raw,
          json: parsed.json,
          error: failure || null,
        },
      });
    };
    const stdoutLines = lineDecoder((line) => outputLine(line, "stdout"));
    const stderrLines = lineDecoder((line) => outputLine(line, "stderr"));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      stdoutLines.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      stderrLines.push(chunk);
    });
    const finish = async (result) => {
      if (finishing) return;
      finishing = true;
      let cleanupResult = null;
      let cleanupError = null;
      if (cleanup) {
        try {
          cleanupResult = await cleanup(result.stopRequested ? "stopped" : result.error ? "provider_error" : "task_finished");
        } catch (error) {
          cleanupError = error;
        }
      }
      if (cleanupError) {
        cleanupResult = {
          state: "failed",
          reason: result.stopRequested ? "stopped" : result.error ? "provider_error" : "task_finished",
          taskId: spec.taskId || null,
          error: redactSecrets(cleanupError.message),
        };
      }
      settled = true;
      const errorText = cleanupError
        ? `permission containment cleanup failed: ${cleanupError.message}`
        : semanticError || result.error || null;
      resolveWait({
        ...result,
        error: errorText,
        permissionCleanup: cleanupResult,
        providerFacts,
        sessionId: providerSessionId,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
      });
    };
    child.on("error", (error) => {
      stderr += error.message;
      emitSafely(onEvent, {
        type: "provider_error",
        stream: "process",
        text: error.message,
        payload: { error: error.message },
      });
      void finish({ exitCode: null, signal: null, error: error.message, stopRequested });
    });
    child.on("close", (exitCode, signal) => {
      stdoutLines.flush();
      stderrLines.flush();
      void finish({
        exitCode,
        signal,
        error: semanticError || null,
        stopRequested,
      });
    });
    return {
      provider: "cli",
      pid: child.pid,
      args,
      permissionReceipt,
      getProviderSessionId: () => providerSessionId,
      wait,
      async stop() {
        if (settled || finishing) return;
        stopRequested = true;
        child.kill("SIGTERM");
        await delay(2000);
        if (!settled) child.kill("SIGKILL");
      },
    };
  }
}

function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, "")}${path}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: options.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function workBuddyHeaders(config) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-codebuddy-request": "1",
  };
  const token = config.token ? String(config.token) : config.tokenEnv ? process.env[config.tokenEnv] : "";
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { text };
  }
}

function providerId(payload) {
  const object = payload?.job || payload?.data || payload;
  return object?.id || object?.jobId || object?.job_id || "";
}

export class WorkBuddyHttpAdapter {
  constructor(agentId, config) {
    this.agentId = agentId;
    this.config = config;
    this.baseUrl = String(config.httpUrl).replace(/\/+$/, "");
  }

  async health() {
    const capabilityReport = workBuddyCapabilityReport(this.config, { http: true });
    const modelReport = workBuddyModelReport(this.config);
    try {
      const response = await fetchWithTimeout(joinUrl(this.baseUrl, "/api/v1/health"), { method: "GET", headers: workBuddyHeaders(this.config) }, 3000);
      return {
        agent: this.agentId,
        label: this.config.label || this.agentId,
        kind: "http",
        endpoint: this.baseUrl,
        permissionMapping: {
          ...(this.config.permissionMapping || { strategy: "http-endpoint-unqualified" }),
          strategy: "http-endpoint-unqualified",
          capabilityReport,
        },
        capabilityReport,
        ...modelReport,
        capabilities: capabilitiesFor(this.agentId, { agents: { [this.agentId]: this.config } }),
        configured: true,
        available: response.ok,
        reachable: response.status < 500,
        statusCode: response.status,
        error: response.ok ? null : `health endpoint returned HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        agent: this.agentId,
        label: this.config.label || this.agentId,
        kind: "http",
        endpoint: this.baseUrl,
        permissionMapping: {
          ...(this.config.permissionMapping || { strategy: "http-endpoint-unqualified" }),
          strategy: "http-endpoint-unqualified",
          capabilityReport,
        },
        capabilityReport,
        ...modelReport,
        configured: true,
        available: false,
        error: error.name === "AbortError" ? "health probe timed out" : error.message,
      };
    }
  }

  async start(spec, onEvent) {
    const adapter = this;
    const body = { prompt: spec.prompt, cwd: spec.cwd };
    if (spec.sessionId) body.sourceSessionId = spec.sessionId;
    if (spec.model) body.model = spec.model;
    const response = await fetchWithTimeout(joinUrl(this.baseUrl, "/api/v1/jobs"), {
      method: "POST",
      headers: workBuddyHeaders(this.config),
      body: JSON.stringify(body),
    }, 15000);
    const payload = await parseResponse(response);
    if (!response.ok) throw new Error(`WorkBuddy HTTP ${response.status}: ${truncate(JSON.stringify(payload), 800)}`);
    const jobId = providerId(payload);
    if (!jobId) throw new Error("WorkBuddy job response did not include a job id");
    let providerSessionId = payload?.sessionId || payload?.session_id || payload?.job?.sessionId || "";
    const controller = new AbortController();
    let stopped = false;
    const wait = this.stream(jobId, controller, onEvent, (sessionId) => {
      if (sessionId) providerSessionId = sessionId;
    });
    const handle = {
      provider: "workbuddy-http",
      providerJobId: String(jobId),
      getProviderSessionId: () => providerSessionId,
      wait,
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await fetchWithTimeout(joinUrl(adapter.baseUrl, `/api/v1/jobs/${encodeURIComponent(jobId)}/stop`), {
            method: "POST",
            headers: workBuddyHeaders(adapter.config),
            body: "{}",
          }, 8000);
        } finally {
          controller.abort();
        }
      },
      async reply(prompt) {
        const replyResponse = await fetchWithTimeout(joinUrl(adapter.baseUrl, `/api/v1/jobs/${encodeURIComponent(jobId)}/reply`), {
          method: "POST",
          headers: workBuddyHeaders(adapter.config),
          body: JSON.stringify({ text: prompt, bash: false }),
        }, 15000);
        const replyPayload = await parseResponse(replyResponse);
        if (!replyResponse.ok) throw new Error(`WorkBuddy reply HTTP ${replyResponse.status}: ${truncate(JSON.stringify(replyPayload), 800)}`);
        return replyPayload;
      },
    };
    return handle;
  }

  async stream(jobId, controller, onEvent, onSessionId = () => {}) {
    let failed = false;
    let semanticError = "";
    const providerFacts = emptyProviderFacts();
    const workBuddyToolUses = new Map();
    let response;
    try {
      response = await fetch(joinUrl(this.baseUrl, `/api/v1/jobs/${encodeURIComponent(jobId)}/stream`), {
        headers: workBuddyHeaders(this.config),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await parseResponse(response);
        throw new Error(`WorkBuddy stream HTTP ${response.status}: ${truncate(JSON.stringify(payload), 800)}`);
      }
      let buffer = "";
      let dataLines = [];
      const dispatch = () => {
        if (!dataLines.length) return;
        const line = dataLines.join("\n");
        dataLines = [];
        const parsed = parseProviderLine(this.agentId, line);
        if (parsed.sessionId) onSessionId(parsed.sessionId);
        collectProviderFacts(parsed.json, providerFacts);
        collectWorkBuddyProviderFacts(parsed.json, providerFacts, workBuddyToolUses);
        const failure = providerSemanticError(parsed.json, parsed.text);
        if (failure && !semanticError) semanticError = failure;
        const status = parsed.json?.status || parsed.json?.job?.status || parsed.json?.data?.status;
        if (["failed", "error", "cancelled", "canceled"].includes(String(status).toLowerCase())) failed = true;
        if (failure) failed = true;
        emitSafely(onEvent, {
          type: failure ? "provider_error" : parsed.json ? "provider_message" : "stdout",
          stream: "sse",
          text: failure || parsed.text,
          sessionId: parsed.sessionId || null,
          payload: { line: parsed.raw, json: parsed.json, error: failure || null },
        });
      };
      for await (const chunk of response.body) {
        buffer += Buffer.from(chunk).toString("utf8");
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + 1);
          if (line === "") dispatch();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
      }
      if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
      dispatch();
    } catch (error) {
      if (error.name !== "AbortError") {
        failed = true;
        emitSafely(onEvent, { type: "provider_error", stream: "sse", text: error.message, payload: { error: error.message } });
      }
    }
    return {
      exitCode: failed ? 1 : 0,
      signal: null,
      error: failed ? semanticError || "provider stream failed" : null,
      sessionId: "",
      stdout: "",
      stderr: "",
      providerFacts,
    };
  }
}

export function adapterFor(agentId, config) {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) throw new Error(`Unknown agent: ${agentId}`);
  if (agentId === "tencent-workbuddy" && agentConfig.httpUrl?.trim()) {
    return new WorkBuddyHttpAdapter(agentId, agentConfig);
  }
  return new CliAdapter(agentId, agentConfig);
}

export async function healthFor(agentId, config) {
  const agentConfig = config.agents[agentId];
  if (!agentConfig) return { agent: agentId, capabilities: capabilitiesFor(agentId, config), available: false, error: "not registered" };
  if (agentId === "tencent-workbuddy" && agentConfig.httpUrl?.trim()) {
    return adapterFor(agentId, config).health();
  }
  if (!agentConfig.command) {
    return { agent: agentId, capabilities: capabilitiesFor(agentId, config), available: false, error: "no command configured" };
  }
  const result = await new CliAdapter(agentId, agentConfig).health();
  if (agentId === "tencent-workbuddy" && !result.available) {
    return { ...result, configured: false, error: result.error || "codebuddy executable unavailable" };
  }
  return result;
}
