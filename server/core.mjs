import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export const SERVICE_VERSION = "0.1.0";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 47770;
export const TERMINAL_TASK_STATUSES = new Set([
  "succeeded",
  "failed",
  "stopped",
  "timed_out",
  "interrupted",
]);

export const SUPPORTED_ORIGINS = Object.freeze([
  "codex",
  "devspace",
  "dashboard",
  "local_cli",
]);

const APPROVAL_POLICIES = new Set([
  "provider_default",
  "require_approval",
  "deny_unapproved",
]);

const DEFAULT_AGENT_CAPABILITIES = {
  antigravity: {
    stream: "supported",
    resume: "unsupported",
    follow_up: "unsupported",
    stop: "supported",
    approval: "limited",
    worktree: "cwd-only",
    structured_events: "supported",
    permissions: { write: "unknown", network: "unknown" },
  },
  "claude-code": {
    stream: "supported",
    resume: "supported",
    follow_up: "resume-only",
    stop: "supported",
    approval: "adapter/version-dependent",
    worktree: "cwd-only",
    structured_events: "supported",
    permissions: { write: "unknown", network: "unknown" },
  },
  "codex-cli": {
    stream: "supported",
    resume: "supported",
    follow_up: "resume-only",
    stop: "supported",
    approval: "limited",
    worktree: "cwd-only",
    structured_events: "supported",
    permissions: { write: "native", network: "unknown" },
  },
  "tencent-workbuddy": {
    stream: "supported",
    resume: "supported",
    follow_up: "resume-only-or-adapter-dependent",
    stop: "supported",
    approval: "adapter/version-dependent",
    worktree: "cwd-only",
    structured_events: "supported",
    permissions: { write: "unknown", network: "unknown" },
  },
};

export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function ensureDir(directory) {
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function resolveDataDir() {
  return process.env.AGENT_CONTROL_DATA_DIR?.trim() || join(homedir(), ".codex", "agent-control-center");
}

export function authTokenPath(dataDir) {
  return join(dataDir, "auth.token");
}

export function ensureAuthToken(dataDir) {
  const configured = process.env.AGENT_CONTROL_AUTH_TOKEN?.trim();
  if (configured) return configured;
  const tokenPath = authTokenPath(dataDir);
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token) return token;
  }
  const token = randomBytes(32).toString("base64url");
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch { /* Best effort on filesystems without POSIX modes. */ }
  return token;
}

export function readAuthToken(dataDir) {
  const configured = process.env.AGENT_CONTROL_AUTH_TOKEN?.trim();
  if (configured) return configured;
  try { return readFileSync(authTokenPath(dataDir), "utf8").trim(); } catch { return ""; }
}

export function truncate(value, max = 12000) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 80))}\n… [truncated ${text.length - max + 80} chars]`;
}

export function redactSecrets(value) {
  let text = String(value ?? "");
  const patterns = [
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}/g,
    /(password|passwd|secret|api[_-]?key|access[_-]?token)\s*([:=])\s*(["']?)[^\s,"'}]+\3/gi,
  ];
  for (const pattern of patterns) {
    text = text.replace(pattern, (match, key, separator, quote) => {
      if (key) return `${key}${separator}${quote ?? ""}[REDACTED]${quote ?? ""}`;
      return "[REDACTED]";
    });
  }
  return text;
}

const WORKBUDDY_CLI_RELATIVE_PATH = join(
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "cli",
  "bin",
  "codebuddy",
);

const CODEX_CLI_RELATIVE_PATH = join(
  "Contents",
  "Resources",
  "codex",
);

export function workBuddyCliCandidates() {
  if (process.platform !== "darwin") return [];
  return ["WorkBuddy.app", "CodeBuddy.app"].flatMap((appName) => [
    join("/Applications", appName, WORKBUDDY_CLI_RELATIVE_PATH),
    join(homedir(), "Applications", appName, WORKBUDDY_CLI_RELATIVE_PATH),
  ]);
}

export function discoverWorkBuddyCli() {
  const bundled = workBuddyCliCandidates().find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  return bundled || "codebuddy";
}

export function codexCliCandidates() {
  if (process.platform !== "darwin") return [];
  return [
    join("/Applications", "ChatGPT.app", CODEX_CLI_RELATIVE_PATH),
    join(homedir(), "Applications", "ChatGPT.app", CODEX_CLI_RELATIVE_PATH),
  ];
}

export function discoverCodexCli() {
  const bundled = codexCliCandidates().find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  return bundled || "codex";
}

export function safeJson(value) {
  try {
    return redactSecrets(JSON.stringify(value));
  } catch {
    return JSON.stringify({ value: String(value), serializationError: true });
  }
}

export function normalizeOrigin(value, fallback = "local_cli") {
  const origin = String(value ?? fallback).trim().toLowerCase();
  if (!origin || !/^[a-z][a-z0-9._:-]{0,63}$/.test(origin)) {
    throw new Error("origin must be a short identifier containing letters, digits, ., _, :, or -");
  }
  return origin;
}

export function normalizeOptionalIdentifier(value, fieldName, maxLength = 256) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const identifier = String(value).trim();
  if (identifier.length > maxLength) throw new Error(`${fieldName} exceeds ${maxLength} characters`);
  if (identifier.includes("\0")) throw new Error(`${fieldName} contains an invalid null byte`);
  return identifier;
}

function isPathWithin(parent, child) {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function hasTraversalSegment(value) {
  return String(value).split(/[\\/]+/).includes("..");
}

function normalizedFilesystemScope(value, cwd, allowedRoots = []) {
  if (value === undefined || value === null || value === "cwd") return [cwd];
  const raw = Array.isArray(value) ? value : [value];
  if (!raw.length) return [cwd];
  const canonicalRoots = allowedRoots.map((root) => realpathSync(root));
  const scope = [...new Set(raw.map((item) => {
    const path = String(item || "").trim();
    if (!isAbsolute(path)) throw new Error("permissionPolicy.filesystemScope paths must be absolute");
    if (hasTraversalSegment(path)) throw new Error("permissionPolicy.filesystemScope cannot contain parent traversal segments");
    let canonical;
    try {
      canonical = realpathSync(resolve(path));
    } catch (error) {
      throw new Error(`permissionPolicy.filesystemScope path is not accessible: ${path} (${error.message})`);
    }
    if (!isPathWithin(cwd, canonical)) throw new Error("permissionPolicy.filesystemScope cannot extend outside cwd");
    if (canonicalRoots.length && !canonicalRoots.some((root) => isPathWithin(root, canonical))) {
      throw new Error("permissionPolicy.filesystemScope is outside the configured allowed workspace roots");
    }
    return canonical;
  }))];
  return scope.length ? scope : [cwd];
}

function optionalBoolean(value, fieldName, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${fieldName} must be boolean`);
  return value;
}

function optionalLabel(value, fieldName, fallback = null) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const label = String(value).trim();
  if (label.length > 256) throw new Error(`${fieldName} exceeds 256 characters`);
  if (label.includes("\0")) throw new Error(`${fieldName} contains an invalid null byte`);
  return label;
}

export function capabilitiesFor(agentId, config = {}) {
  const base = DEFAULT_AGENT_CAPABILITIES[agentId] || {
    stream: "unknown",
    resume: "unknown",
    follow_up: "unknown",
    stop: "unknown",
    approval: "unknown",
    worktree: "unknown",
    structured_events: "unknown",
    permissions: { write: "unknown", network: "unknown" },
  };
  const configured = config.agents?.[agentId]?.capabilities || {};
  const capabilities = structuredClone(base);
  for (const [key, value] of Object.entries(configured)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      capabilities[key] = { ...(capabilities[key] || {}), ...value };
    } else {
      capabilities[key] = value;
    }
  }
  if (agentId === "tencent-workbuddy" && config.agents?.[agentId]?.httpUrl?.trim()) {
    capabilities.follow_up = "supported";
  }
  return capabilities;
}

export function buildPermissionPolicy({ cwd, origin, requested = {}, capabilities = {}, allowedRoots = [], originCapabilityCeiling = {} }) {
  const remoteOrigin = origin === "devspace" || origin === "dashboard";
  const defaultWriteAllowed = !remoteOrigin;
  const requestedWriteAllowed = optionalBoolean(requested.writeAllowed, "permissionPolicy.writeAllowed", defaultWriteAllowed);
  const requestedNetworkAllowed = optionalBoolean(requested.networkAllowed, "permissionPolicy.networkAllowed", false);
  const approvalPolicy = String(requested.approvalPolicy || "provider_default").trim().toLowerCase();
  if (!APPROVAL_POLICIES.has(approvalPolicy)) {
    throw new Error(`permissionPolicy.approvalPolicy must be one of: ${[...APPROVAL_POLICIES].join(", ")}`);
  }
  const filesystemScope = normalizedFilesystemScope(requested.filesystemScope, cwd, allowedRoots);
  const worktree = optionalLabel(requested.worktree, "permissionPolicy.worktree");
  if (worktree && (!isAbsolute(worktree) || !isPathWithin(cwd, worktree))) {
    throw new Error("permissionPolicy.worktree must be an absolute path inside cwd");
  }
  const project = optionalLabel(requested.project, "permissionPolicy.project", cwd);
  const repo = optionalLabel(requested.repo, "permissionPolicy.repo");
  const ceilingWriteAllowed = remoteOrigin
    ? optionalBoolean(originCapabilityCeiling.writeAllowed, "originCapabilityCeiling.writeAllowed", false)
    : true;
  const ceilingNetworkAllowed = remoteOrigin
    ? optionalBoolean(originCapabilityCeiling.networkAllowed, "originCapabilityCeiling.networkAllowed", false)
    : false;
  const controlPolicy = {
    writeAllowed: ceilingWriteAllowed,
    networkAllowed: ceilingNetworkAllowed,
    filesystemScope: [cwd],
  };
  const effective = {
    project,
    repo,
    workspace: cwd,
    worktree,
    filesystemScope,
    writeAllowed: requestedWriteAllowed && controlPolicy.writeAllowed && capabilities.permissions?.write !== false,
    networkAllowed: requestedNetworkAllowed && controlPolicy.networkAllowed && capabilities.permissions?.network !== false,
    approvalPolicy,
  };
  const enforcement = {
    writeAllowed: capabilities.permissions?.write || "unknown",
    networkAllowed: capabilities.permissions?.network || "unknown",
    approvalPolicy: capabilities.approval || "unknown",
  };
  const limitations = [];
  if (enforcement.writeAllowed !== "native") {
    limitations.push("executor does not declare a native filesystem write boundary; write scope is not universally enforced");
  }
  if (enforcement.networkAllowed !== "native") {
    limitations.push("executor does not declare a native network boundary");
  }
  if (approvalPolicy !== "provider_default" && enforcement.approvalPolicy !== "supported") {
    limitations.push("requested approval policy is not declared as natively supported by this executor");
  }
  return {
    requested: {
      project,
      repo,
      workspace: cwd,
      worktree,
      filesystemScope,
      writeAllowed: requestedWriteAllowed,
      networkAllowed: requestedNetworkAllowed,
      approvalPolicy,
    },
    controlPolicy,
    effective,
    native: enforcement,
    status: limitations.length ? "limited" : "enforced",
    limitations,
  };
}

export function idempotencyFingerprint(input) {
  return JSON.stringify({
    agent: input.agent,
    prompt: input.prompt,
    cwd: input.cwd,
    model: input.model || null,
    timeoutMs: input.timeoutMs,
    origin: input.origin,
    permissionPolicy: input.permissionPolicy || {},
  });
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

const DEFAULT_AGENTS = {
  antigravity: {
    label: "Antigravity",
    kind: "cli",
    command: "agy",
    args: ["-p", "{prompt}", "--output-format", "stream-json"],
    modelArgs: ["--model", "{model}"],
    supportsResume: false,
    permissionMapping: {
      strategy: "sandbox-exec-proxy",
      reason: "agy 1.1.27 exposes no safe per-process permission override; use task-scoped external containment",
      providerHosts: [
        "accounts.google.com",
        "daily-cloudcode-pa.googleapis.com",
        "generativelanguage.googleapis.com",
        "lh3.googleusercontent.com",
        "oauth2.googleapis.com",
        "www.googleapis.com",
      ],
    },
  },
  "claude-code": {
    label: "Claude Code",
    kind: "cli",
    command: "claude",
    args: ["-p", "{prompt}", "--output-format", "stream-json", "--verbose"],
    modelArgs: ["--model", "{model}"],
    resumeArgs: [
      "-p",
      "{prompt}",
      "--resume",
      "{sessionId}",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    supportsResume: true,
  },
  "codex-cli": {
    label: "Codex CLI",
    kind: "cli",
    command: "codex",
    args: [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--config",
      "model_reasoning_effort=\"max\"",
      "--cd",
      "{cwd}",
      "{prompt}",
    ],
    modelArgs: ["--model", "{model}"],
    resumeArgs: [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--config",
      "model_reasoning_effort=\"max\"",
      "{sessionId}",
      "{prompt}",
    ],
    defaultModel: "gpt-5.6-luna",
    stdin: "ignore",
    supportsResume: true,
    permissionMapping: {
      flag: "--sandbox",
      writeAllowed: "workspace-write",
      writeDenied: "read-only",
    },
  },
  "tencent-workbuddy": {
    label: "Tencent WorkBuddy / CodeBuddy",
    kind: "http-or-cli",
    command: "codebuddy",
    args: ["-p", "{prompt}", "--output-format", "stream-json", "--verbose"],
    modelArgs: ["--model", "{model}"],
    resumeArgs: ["-p", "{prompt}", "--resume", "{sessionId}", "--output-format", "stream-json", "--verbose"],
    httpUrl: "",
    tokenEnv: "WORKBUDDY_HTTP_TOKEN",
    supportsResume: true,
  },
};

export function defaultConfig() {
  const agents = structuredClone(DEFAULT_AGENTS);
  agents["tencent-workbuddy"].command = discoverWorkBuddyCli();
  agents["codex-cli"].command = discoverCodexCli();
  return {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    defaultCwd: "",
    allowedRoots: [],
    maxConcurrentTasks: 4,
    defaultTimeoutMs: 30 * 60 * 1000,
    maxWaitMs: 60 * 1000,
    maxPromptChars: 20000,
    maxDiscussionRounds: 3,
    originCapabilityCeilings: {
      codex: { writeAllowed: true, networkAllowed: false },
      devspace: { writeAllowed: false, networkAllowed: false },
      dashboard: { writeAllowed: false, networkAllowed: false },
      local_cli: { writeAllowed: true, networkAllowed: false },
    },
    agents,
  };
}

function mergeConfig(base, override) {
  const result = { ...base, ...override };
  result.originCapabilityCeilings = {
    ...(base.originCapabilityCeilings || {}),
    ...(override?.originCapabilityCeilings || {}),
  };
  result.agents = { ...base.agents };
  for (const [id, agent] of Object.entries(override?.agents ?? {})) {
    result.agents[id] = { ...(base.agents[id] ?? {}), ...agent };
  }
  return result;
}

export function loadConfig(dataDir) {
  const defaults = defaultConfig();
  const configPath = process.env.AGENT_CONTROL_CONFIG?.trim() || join(dataDir, "config.json");
  let fileConfig = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot read Agent Control Center config ${configPath}: ${error.message}`);
    }
  }
  const config = mergeConfig(defaults, fileConfig);
  const configuredWorkBuddyCommand = fileConfig?.agents?.["tencent-workbuddy"]?.command;
  const usesLegacyDefault = configuredWorkBuddyCommand === undefined
    || String(configuredWorkBuddyCommand).trim() === ""
    || String(configuredWorkBuddyCommand).trim() === "codebuddy";
  const bundledWorkBuddyCli = discoverWorkBuddyCli();
  if (usesLegacyDefault && bundledWorkBuddyCli !== "codebuddy") {
    config.agents["tencent-workbuddy"] = {
      ...config.agents["tencent-workbuddy"],
      command: bundledWorkBuddyCli,
    };
  }
  const configuredCodexCommand = fileConfig?.agents?.["codex-cli"]?.command;
  const usesLegacyCodexDefault = configuredCodexCommand === undefined
    || String(configuredCodexCommand).trim() === ""
    || String(configuredCodexCommand).trim() === "codex";
  const bundledCodexCli = discoverCodexCli();
  if (usesLegacyCodexDefault && bundledCodexCli !== "codex") {
    config.agents["codex-cli"] = {
      ...config.agents["codex-cli"],
      command: bundledCodexCli,
    };
  }
  config.host = String(process.env.AGENT_CONTROL_HOST || config.host || DEFAULT_HOST);
  config.defaultCwd = String(process.env.AGENT_CONTROL_DEFAULT_CWD || config.defaultCwd || "");
  const configuredRoots = process.env.AGENT_CONTROL_ALLOWED_ROOTS
    ? process.env.AGENT_CONTROL_ALLOWED_ROOTS.split(process.platform === "win32" ? ";" : ":")
    : config.allowedRoots;
  config.allowedRoots = Array.isArray(configuredRoots)
    ? configuredRoots.map((root) => String(root).trim()).filter(Boolean)
    : [];
  config.port = positiveInteger(process.env.AGENT_CONTROL_PORT || config.port, DEFAULT_PORT);
  config.maxConcurrentTasks = positiveInteger(config.maxConcurrentTasks, 4);
  config.defaultTimeoutMs = positiveInteger(config.defaultTimeoutMs, 30 * 60 * 1000);
  config.maxWaitMs = Math.max(1000, positiveInteger(config.maxWaitMs, 60 * 1000));
  config.maxPromptChars = positiveInteger(config.maxPromptChars, 20000);
  config.maxDiscussionRounds = Math.min(3, positiveInteger(config.maxDiscussionRounds, 3));

  const commandEnvironmentOverrides = {
    antigravity: process.env.AGENT_CONTROL_ANTIGRAVITY_COMMAND,
    "claude-code": process.env.AGENT_CONTROL_CLAUDE_COMMAND,
    "codex-cli": process.env.AGENT_CONTROL_CODEX_COMMAND,
    "tencent-workbuddy": process.env.AGENT_CONTROL_WORKBUDDY_COMMAND,
  };
  for (const [id, command] of Object.entries(commandEnvironmentOverrides)) {
    if (command?.trim()) config.agents[id] = { ...config.agents[id], command: command.trim() };
  }
  if (process.env.WORKBUDDY_HTTP_URL?.trim()) {
    config.agents["tencent-workbuddy"] = {
      ...config.agents["tencent-workbuddy"],
      httpUrl: process.env.WORKBUDDY_HTTP_URL.trim(),
    };
  }
  return { config, configPath };
}

export function validateCwd(cwd, { allowedRoots = [], enforceAllowedRoot = false, rejectTraversal = false } = {}) {
  const value = cwd?.trim() || process.cwd();
  if (!isAbsolute(value)) throw new Error("cwd must be an absolute path");
  if (value.includes("\0")) throw new Error("cwd contains an invalid null byte");
  if (rejectTraversal && hasTraversalSegment(value)) throw new Error("cwd cannot contain parent traversal segments");
  try {
    if (!statSync(value).isDirectory()) throw new Error("cwd is not a directory");
    const canonicalCwd = realpathSync(value);
    const canonicalRoots = allowedRoots.map((root) => realpathSync(root));
    if (enforceAllowedRoot && (!canonicalRoots.length || !canonicalRoots.some((root) => isPathWithin(root, canonicalCwd)))) {
      throw new Error("cwd is outside the configured allowed workspace roots");
    }
    return canonicalCwd;
  } catch (error) {
    throw new Error(`cwd is not an accessible directory: ${value} (${error.message})`);
  }
}

export function validatePrompt(prompt, maxPromptChars) {
  const value = String(prompt ?? "").trim();
  if (!value) throw new Error("prompt is required");
  if (value.length > maxPromptChars) throw new Error(`prompt exceeds ${maxPromptChars} characters`);
  return value;
}

export function fillTemplateArgs(template, values) {
  return (template ?? []).map((part) => {
    const token = String(part);
    return token.replace(/\{(prompt|cwd|sessionId|model)\}/g, (_, key) => String(values[key] ?? ""));
  });
}

export function isTerminalStatus(status) {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function extractText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const candidates = [
    value.text,
    value.text_delta,
    value.delta,
    value.content,
    value.message,
    value.result,
    value.output,
    value.response,
    value.item,
    value.items,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (Array.isArray(candidate)) {
      const text = candidate
        .map((item) => (typeof item === "string" ? item : item?.text ?? item?.content ?? ""))
        .join("");
      if (text.trim()) return text;
    }
    if (candidate && typeof candidate === "object") {
      const nested = extractText(candidate);
      if (nested.trim()) return nested;
    }
  }
  return "";
}

export function extractSessionId(value) {
  if (!value || typeof value !== "object") return "";
  const direct = value.session_id
    || value.sessionId
    || value.thread_id
    || value.threadId
    || value.conversation_id
    || value.conversationId;
  if (typeof direct === "string" && direct.trim()) return direct;
  for (const key of ["session", "conversation", "thread", "result", "data", "job"]) {
    if (value[key] && typeof value[key] === "object") {
      const nested = extractSessionId(value[key]);
      if (nested) return nested;
    }
  }
  return "";
}

export function parseProviderLine(agent, line) {
  const json = parseJsonLine(line);
  return {
    agent,
    raw: redactSecrets(line),
    json: json ? JSON.parse(redactSecrets(JSON.stringify(json))) : null,
    text: json ? redactSecrets(extractText(json)) : redactSecrets(line),
    sessionId: json ? extractSessionId(json) : "",
  };
}
