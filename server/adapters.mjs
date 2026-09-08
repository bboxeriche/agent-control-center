import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { prepareAntigravityContainment, ANTIGRAVITY_CONTAINMENT_STRATEGY } from "./antigravity-containment.mjs";
import { NativePermissionMappingUnavailableError } from "./antigravity-permissions.mjs";
import { capabilitiesFor, fillTemplateArgs, parseProviderLine, redactSecrets, truncate } from "./core.mjs";

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
    return {
      agent: this.agentId,
      label: this.config.label || this.agentId,
      kind: "cli",
      command: this.config.command,
      permissionMapping: this.config.permissionMapping || { strategy: "unknown" },
      capabilities: capabilitiesFor(this.agentId, { agents: { [this.agentId]: this.config } }),
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

    return this.startProcess(spec, onEvent, {
      command: this.config.command,
      args: commandArgs(this.config, spec),
      env: this.config.env,
    });
  }

  async startContained(spec, onEvent) {
    const effective = spec.permissionPolicy?.effective || spec.permissionPolicy || {};
    // The external proxy can safely permit network=true and the macOS sandbox
    // can safely deny writes outside scope. It cannot revoke agy's own
    // headless network tool service after --dangerously-skip-permissions has
    // approved it. Refuse the unsafe write=true/network=false quadrant rather
    // than pretending that a prompt-level policy is an OS boundary.
    if (effective.writeAllowed === true && effective.networkAllowed !== true) {
      throw new NativePermissionMappingUnavailableError(
        spec.permissionPolicy,
        "task-scoped fallback cannot revoke agy's headless network tool while approving writes",
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
    let stopRequested = false;
    let settled = false;
    let finishing = false;
    let resolveWait;
    const wait = new Promise((resolve) => {
      resolveWait = resolve;
    });
    const outputLine = (line, stream) => {
      const parsed = parseProviderLine(this.agentId, line);
      if (parsed.sessionId) providerSessionId = parsed.sessionId;
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
      settled = true;
      const errorText = cleanupError
        ? `permission containment cleanup failed: ${cleanupError.message}`
        : semanticError || result.error || null;
      resolveWait({
        ...result,
        error: errorText,
        permissionCleanup: cleanupResult,
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
    try {
      const response = await fetchWithTimeout(joinUrl(this.baseUrl, "/api/v1/health"), { method: "GET", headers: workBuddyHeaders(this.config) }, 3000);
      return {
        agent: this.agentId,
        label: this.config.label || this.agentId,
        kind: "http",
        endpoint: this.baseUrl,
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
    return { exitCode: failed ? 1 : 0, signal: null, error: failed ? semanticError || "provider stream failed" : null, sessionId: "", stdout: "", stderr: "" };
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
