import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export const NATIVE_PERMISSION_MAPPING_UNAVAILABLE = "native_permission_mapping_unavailable";
export const ANTIGRAVITY_EXTERNAL_CONTAINMENT_STRATEGY = "sandbox-exec-proxy";
export const ANTIGRAVITY_PROFILE_UNSUPPORTED = "antigravity_execution_profile_unsupported";

export function antigravityHeadlessApprovalMode(config = {}) {
  const mode = config.headlessApprovalMode || "project-grants";
  if (!["project-grants", "skip-permissions"].includes(mode)) {
    throw new Error(`unknown Antigravity headlessApprovalMode: ${mode}`);
  }
  return mode;
}

const PROFILE_CATALOG = Object.freeze({
  read_only: Object.freeze({
    profile: "read_only",
    writeAllowed: false,
    networkAllowed: false,
    status: "SUPPORTED",
    code: "antigravity_profile_read_only_supported",
    reason: "task-scoped native project grants approve common read-only commands; native write/web/MCP tools are denied and external containment enforces task writes and network egress",
    nativeMode: "request-review-with-task-project-grants",
    externalWrite: "deny",
    externalNetwork: "provider-hosts-only",
  }),
  network_only: Object.freeze({
    profile: "network_only",
    writeAllowed: false,
    networkAllowed: true,
    status: "SUPPORTED",
    code: "antigravity_profile_network_only_supported",
    reason: "external containment denies task writes and the task proxy permits network targets",
    nativeMode: "skip-permissions-inside-containment",
    externalWrite: "deny",
    externalNetwork: "proxy-allowlist",
  }),
  bounded_write_network: Object.freeze({
    profile: "bounded_write_network",
    writeAllowed: true,
    networkAllowed: true,
    status: "SUPPORTED",
    code: "antigravity_profile_bounded_write_network_supported",
    reason: "external containment scopes writes to the canonical task scope and routes network through the task proxy",
    nativeMode: "skip-permissions-inside-containment",
    externalWrite: "scope-only",
    externalNetwork: "proxy-allowlist",
  }),
  bounded_write_no_network: Object.freeze({
    profile: "bounded_write_no_network",
    writeAllowed: true,
    networkAllowed: false,
    status: "UNSUPPORTED",
    code: "antigravity_profile_write_without_network_unsupported",
    reason: "task-scoped fallback cannot revoke agy's headless network tool while approving writes; agy headless network tools can execute outside the child process path",
    nativeMode: "unavailable",
    externalWrite: "scope-only",
    externalNetwork: "provider-hosts-only",
  }),
});

export const ANTIGRAVITY_EXECUTION_PROFILES = Object.freeze({ ...PROFILE_CATALOG });

function executionProfile(key, approvalMode) {
  const base = PROFILE_CATALOG[key];
  if (key !== "read_only" || approvalMode !== "skip-permissions") return base;
  return {
    ...base,
    nativeMode: "skip-permissions-with-task-project-denies",
    reason: "skip-permissions bypasses command Ask prompts; explicit task-project write/web/MCP deny rules and external write/egress containment remain in force (qualified with agy 1.3.3)",
  };
}

const NETWORK_ACTIONS = Object.freeze([
  "read_url",
  "search_web",
]);

function effectivePolicy(permissionPolicy) {
  return permissionPolicy?.effective && typeof permissionPolicy.effective === "object"
    ? permissionPolicy.effective
    : permissionPolicy && typeof permissionPolicy === "object"
      ? permissionPolicy
      : {};
}

function profileKey(effective) {
  const writeAllowed = effective.writeAllowed === true;
  const networkAllowed = effective.networkAllowed === true;
  if (writeAllowed && networkAllowed) return "bounded_write_network";
  if (writeAllowed && !networkAllowed) return "bounded_write_no_network";
  if (!writeAllowed && networkAllowed) return "network_only";
  return "read_only";
}

function unavailableProfile({ code = ANTIGRAVITY_PROFILE_UNSUPPORTED, reason, profile = "unknown", effective = {} } = {}) {
  return {
    profile,
    writeAllowed: effective.writeAllowed === true,
    networkAllowed: effective.networkAllowed === true,
    status: "UNSUPPORTED",
    code,
    reason,
    nativeMode: "unavailable",
    externalWrite: "none",
    externalNetwork: "none",
  };
}

export function preflightAntigravityExecutionProfile(
  permissionPolicy,
  { strategy = ANTIGRAVITY_EXTERNAL_CONTAINMENT_STRATEGY, platform = process.platform, sandboxExecutable = "/usr/bin/sandbox-exec", headlessApprovalMode = "project-grants" } = {},
) {
  const effective = effectivePolicy(permissionPolicy);
  const key = profileKey(effective);
  const approvalMode = antigravityHeadlessApprovalMode({ headlessApprovalMode });
  const base = executionProfile(key, approvalMode);
  if (approvalMode === "skip-permissions" && effective.approvalPolicy && effective.approvalPolicy !== "provider_default") {
    return { ...unavailableProfile({ code: "antigravity_headless_skip_conflicts_with_approval_policy", reason: "skip-permissions cannot satisfy an explicit require_approval or deny_unapproved request; no provider was spawned", profile: key, effective }), mechanism: strategy, effective };
  }
  if (key === "read_only" && effective.approvalPolicy === "require_approval") {
    return { ...unavailableProfile({ code: "antigravity_headless_approval_required", reason: "explicit require_approval cannot be satisfied by Antigravity's non-interactive print mode; no auto-approval grants were installed", profile: key, effective }), mechanism: strategy, effective };
  }
  if (strategy === "test-double") {
    return {
      ...base,
      status: "SUPPORTED",
      code: "antigravity_profile_test_double_supported",
      reason: "test-double executor; no provider boundary claim",
      mechanism: "test-double",
      effective: { writeAllowed: effective.writeAllowed === true, networkAllowed: effective.networkAllowed === true },
    };
  }
  if (strategy !== ANTIGRAVITY_EXTERNAL_CONTAINMENT_STRATEGY) {
    return {
      ...unavailableProfile({
        reason: "no qualified general per-process native permission override or approved external containment strategy is configured",
        profile: key,
        effective,
      }),
      mechanism: strategy || "unknown",
      effective: { writeAllowed: effective.writeAllowed === true, networkAllowed: effective.networkAllowed === true },
    };
  }
  if (platform !== "darwin") {
    return {
      ...unavailableProfile({
        code: "antigravity_containment_unavailable",
        reason: "sandbox-exec external containment is only available on macOS",
        profile: key,
        effective,
      }),
      mechanism: strategy,
      effective: { writeAllowed: effective.writeAllowed === true, networkAllowed: effective.networkAllowed === true },
    };
  }
  if (!existsSync(sandboxExecutable)) {
    return {
      ...unavailableProfile({
        code: "antigravity_containment_unavailable",
        reason: `sandbox-exec executable is unavailable: ${sandboxExecutable}`,
        profile: key,
        effective,
      }),
      mechanism: strategy,
      effective: { writeAllowed: effective.writeAllowed === true, networkAllowed: effective.networkAllowed === true },
    };
  }
  return {
    ...base,
    mechanism: strategy,
    effective: { writeAllowed: effective.writeAllowed === true, networkAllowed: effective.networkAllowed === true },
  };
}

export function antigravityCapabilityReport(
  config = {},
  { platform = process.platform, sandboxExecutable = config.sandboxExecutable || "/usr/bin/sandbox-exec" } = {},
) {
  const strategy = String(config.strategy || "unknown");
  const approvalMode = antigravityHeadlessApprovalMode(config);
  const externalAvailable = strategy === ANTIGRAVITY_EXTERNAL_CONTAINMENT_STRATEGY
    && platform === "darwin"
    && existsSync(sandboxExecutable);
  return {
    provider: "antigravity",
    native: {
      available: false,
      permissionOverride: "unsupported",
      enforcement: { write: "unavailable", network: "unavailable", sensitivePaths: "unavailable" },
      reasonCode: NATIVE_PERMISSION_MAPPING_UNAVAILABLE,
      reason: "general per-process native permission enforcement remains unqualified; read-only command approvals use an isolated task project with external containment",
    },
    mapping: {
      strategy,
      scope: "task",
      safePerProcessOverride: false,
      persistentSettingsMutation: false,
      headlessCommandApproval: {
        strategy: approvalMode === "skip-permissions" ? "task-scoped-project-denies-with-skip-permissions" : "task-scoped-project-grants",
        approvalMode,
        profile: "read_only",
        qualifiedProviderVersions: approvalMode === "skip-permissions" ? ["1.3.3"] : ["1.2.17", "1.3.3"],
        globalSettingsMutation: false,
      },
    },
    externalContainment: {
      strategy: strategy === ANTIGRAVITY_EXTERNAL_CONTAINMENT_STRATEGY ? strategy : "none",
      executable: sandboxExecutable,
      available: externalAvailable,
      enforcement: {
        write: externalAvailable ? "canonical-scope" : "unavailable",
        network: externalAvailable ? "task-proxy" : "unavailable",
        sensitivePaths: externalAvailable ? "default-deny" : "unavailable",
        cleanup: externalAvailable ? "task-receipt" : "unavailable",
      },
      limitation: "file reads remain broad because agy aborts on narrow startup read rules",
    },
    effectiveEnforcement: {
      write: externalAvailable ? "scope-only-or-denied" : "unknown",
      network: externalAvailable ? "provider-hosts-or-proxy" : "unknown",
      sensitivePaths: externalAvailable ? "task-default-deny" : "unknown",
      cleanup: externalAvailable ? "task-scoped" : "unknown",
    },
    executionProfiles: Object.keys(PROFILE_CATALOG).map((key) => executionProfile(key, approvalMode)),
  };
}

function normalizedScope(value) {
  const raw = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  return [...new Set(raw.map((item) => String(item ?? "").trim()).filter(Boolean))];
}

function validateScope(scope) {
  for (const path of scope) {
    if (!isAbsolute(path)) throw new Error("Antigravity filesystem permission scope must be absolute");
    if (path.split(/[\\/]+/).includes("..")) {
      throw new Error("Antigravity filesystem permission scope cannot contain parent traversal segments");
    }
  }
  return scope;
}

/**
 * Convert an already-merged ACC policy into the native rule vocabulary that a
 * future Antigravity per-run adapter would need. This function does not claim
 * that the current agy CLI can install these rules safely.
 */
export function rulesForEffectivePolicy(permissionPolicy) {
  const effective = effectivePolicy(permissionPolicy);
  const filesystemScope = validateScope(normalizedScope(effective.filesystemScope));
  const writeAllowed = effective.writeAllowed === true;
  const networkAllowed = effective.networkAllowed === true;
  if (writeAllowed && !filesystemScope.length) {
    throw new Error("Antigravity write permission requires an explicit filesystem scope");
  }
  const allow = [];

  if (writeAllowed) {
    for (const scope of filesystemScope) allow.push(`write_file(${scope})`);
  }
  if (networkAllowed) {
    for (const action of NETWORK_ACTIONS) allow.push(`${action}(*)`);
  }

  return {
    provider: "antigravity",
    filesystemScope,
    writeAllowed,
    networkAllowed,
    sensitivePathPolicy: effective.sensitivePathPolicy || { mode: "deny" },
    allow,
    deniedActions: {
      write: writeAllowed ? [] : ["write_file"],
      network: networkAllowed ? [] : [...NETWORK_ACTIONS],
    },
    limitations: networkAllowed
      ? ["ACC currently has no domain allowlist, so native network rules are capability-level"]
      : [],
  };
}

export class NativePermissionMappingUnavailableError extends Error {
  constructor(permissionPolicy, reason = "no qualified general per-run native permission override is available", preflight = null) {
    super(`${NATIVE_PERMISSION_MAPPING_UNAVAILABLE}: ${reason}`);
    this.name = "NativePermissionMappingUnavailableError";
    this.code = NATIVE_PERMISSION_MAPPING_UNAVAILABLE;
    this.details = {
      rules: rulesForEffectivePolicy(permissionPolicy),
      reason,
      preflight,
    };
    this.preflight = preflight;
  }
}

/**
 * Lifecycle primitive for a verified future native adapter. Installation and
 * cleanup are injected so this module cannot accidentally write the user's
 * persistent Antigravity settings while the current CLI lacks an override.
 */
export function createEphemeralPermissionLifecycle({
  taskId = randomUUID(),
  rules,
  install = async () => {},
  cleanup = async () => {},
} = {}) {
  let state = "new";
  let cleanupPromise = null;

  const lifecycle = {
    taskId,
    rules,
    get state() {
      return state;
    },
    async start() {
      if (state === "active") return lifecycle;
      if (state !== "new") throw new Error(`permission lifecycle cannot start from ${state}`);
      await install({ taskId, rules });
      state = "active";
      return lifecycle;
    },
    async finish(reason = "task_finished") {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = Promise.resolve()
        .then(() => cleanup({ taskId, rules, reason }))
        .then(() => {
          state = "cleaned";
          return lifecycle;
        });
      return cleanupPromise;
    },
  };

  return lifecycle;
}
