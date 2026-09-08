import { existsSync } from "node:fs";

export const WORKBUDDY_VERSION = "2.106.4";
export const WORKBUDDY_DEFAULT_MODEL = "hy4-preview";
export const WORKBUDDY_VALIDATED_MODELS = Object.freeze(["hy4-preview"]);
export const WORKBUDDY_NATIVE_PERMISSION_MODE = "bypassPermissions";
export const WORKBUDDY_CONTAINMENT_STRATEGY = "workbuddy-bypass-with-containment";
export const WORKBUDDY_PROFILE_UNSUPPORTED = "workbuddy_execution_profile_unsupported";
export const WORKBUDDY_CONTAINED_TOOLS = Object.freeze(["Read", "Write", "Edit", "Bash", "Glob", "Grep"]);
export const WORKBUDDY_PROVIDER_NETWORK_HOSTS = Object.freeze([
  "copilot.tencent.com",
  "galileotelemetry.tencent.com",
]);
export const WORKBUDDY_LOOPBACK_NETWORK_LIMITATION = "WorkBuddy normalizes its proxy to 127.0.0.1; the compatibility loopback rule does not prevent a provider Bash process from making direct local-loopback connections outside the task proxy";

const PROFILE_CATALOG = Object.freeze({
  read_only: Object.freeze({
    profile: "read_only",
    writeAllowed: false,
    networkAllowed: false,
    status: "SUPPORTED",
    code: "workbuddy_profile_read_only_supported",
    reason: "provider approval is bypassed per run while external containment denies task writes and proxy-routed non-provider network targets",
    nativeMode: WORKBUDDY_NATIVE_PERMISSION_MODE,
    externalWrite: "deny",
    externalNetwork: "provider-hosts-only-with-loopback-limit",
  }),
  network_only: Object.freeze({
    profile: "network_only",
    writeAllowed: false,
    networkAllowed: true,
    status: "SUPPORTED",
    code: "workbuddy_profile_network_only_supported",
    reason: "provider approval is bypassed per run while external containment denies task writes and routes network through the task proxy; direct local-loopback access remains a host-specific limitation",
    nativeMode: WORKBUDDY_NATIVE_PERMISSION_MODE,
    externalWrite: "deny",
    externalNetwork: "proxy-allowlist-with-loopback-limit",
  }),
  bounded_write_no_network: Object.freeze({
    profile: "bounded_write_no_network",
    writeAllowed: true,
    networkAllowed: false,
    status: "SUPPORTED",
    code: "workbuddy_profile_bounded_write_no_network_supported",
    reason: "provider approval is bypassed per run while external containment scopes writes and permits only provider transport hosts through the proxy path; direct local-loopback access remains a host-specific limitation",
    nativeMode: WORKBUDDY_NATIVE_PERMISSION_MODE,
    externalWrite: "scope-only",
    externalNetwork: "provider-hosts-only-with-loopback-limit",
  }),
  bounded_write_network: Object.freeze({
    profile: "bounded_write_network",
    writeAllowed: true,
    networkAllowed: true,
    status: "SUPPORTED",
    code: "workbuddy_profile_bounded_write_network_supported",
    reason: "provider approval is bypassed per run while external containment scopes writes and routes network through the task proxy; direct local-loopback access remains a host-specific limitation",
    nativeMode: WORKBUDDY_NATIVE_PERMISSION_MODE,
    externalWrite: "scope-only",
    externalNetwork: "proxy-allowlist-with-loopback-limit",
  }),
});

export const WORKBUDDY_EXECUTION_PROFILES = Object.freeze({ ...PROFILE_CATALOG });

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

function unavailableProfile({ code = WORKBUDDY_PROFILE_UNSUPPORTED, reason, profile, effective } = {}) {
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

function normalizedContainedTools(value) {
  const values = value === undefined || value === null
    ? WORKBUDDY_CONTAINED_TOOLS
    : Array.isArray(value)
      ? value
      : [value];
  return [...new Set(values.map((tool) => String(tool || "").trim()).filter(Boolean))];
}

function remoteNetworkToolPresent(value) {
  const tools = new Set(normalizedContainedTools(value));
  return tools.has("WebFetch") || tools.has("WebSearch");
}

export function preflightWorkBuddyExecutionProfile(
  permissionPolicy,
  {
    strategy = WORKBUDDY_CONTAINMENT_STRATEGY,
    platform = process.platform,
    sandboxExecutable = "/usr/bin/sandbox-exec",
    nativePermissionMode = WORKBUDDY_NATIVE_PERMISSION_MODE,
    providerHosts = WORKBUDDY_PROVIDER_NETWORK_HOSTS,
    containedTools = WORKBUDDY_CONTAINED_TOOLS,
  } = {},
) {
  const effective = effectivePolicy(permissionPolicy);
  const key = profileKey(effective);
  const base = PROFILE_CATALOG[key];
  const common = {
    mechanism: strategy,
    effective: { writeAllowed: effective.writeAllowed === true, networkAllowed: effective.networkAllowed === true },
    providerHosts: [...new Set((providerHosts || []).map((host) => String(host || "").trim().toLowerCase()).filter(Boolean))],
    containedTools: normalizedContainedTools(containedTools),
  };
  if (strategy === "test-double") {
    return {
      ...base,
      ...common,
      status: "SUPPORTED",
      code: "workbuddy_profile_test_double_supported",
      reason: "test-double executor; no provider boundary claim",
      mechanism: "test-double",
    };
  }
  if (strategy !== WORKBUDDY_CONTAINMENT_STRATEGY) {
    return {
      ...unavailableProfile({
        reason: "WorkBuddy native approval must run inside the approved task-scoped external containment strategy",
        profile: key,
        effective,
      }),
      ...common,
    };
  }
  if (nativePermissionMode !== WORKBUDDY_NATIVE_PERMISSION_MODE) {
    return {
      ...unavailableProfile({
        reason: `unsupported WorkBuddy native permission mode: ${nativePermissionMode || "unknown"}`,
        profile: key,
        effective,
      }),
      ...common,
    };
  }
  if (remoteNetworkToolPresent(containedTools)) {
    return {
      ...unavailableProfile({
        reason: "WorkBuddy remote WebFetch/WebSearch tools cannot be placed inside the local ACC network boundary",
        profile: key,
        effective,
      }),
      ...common,
    };
  }
  if (platform !== "darwin") {
    return {
      ...unavailableProfile({
        code: "workbuddy_containment_unavailable",
        reason: "sandbox-exec external containment is only available on macOS",
        profile: key,
        effective,
      }),
      ...common,
    };
  }
  if (!existsSync(sandboxExecutable)) {
    return {
      ...unavailableProfile({
        code: "workbuddy_containment_unavailable",
        reason: `sandbox-exec executable is unavailable: ${sandboxExecutable}`,
        profile: key,
        effective,
      }),
      ...common,
    };
  }
  if (!common.providerHosts.length) {
    return {
      ...unavailableProfile({
        reason: "WorkBuddy provider transport hosts are not configured; network policy cannot fail closed",
        profile: key,
        effective,
      }),
      ...common,
    };
  }
  return { ...base, ...common };
}

export function workBuddyModelReport(config = {}, { requestedModel = null, actualModel = null } = {}) {
  return {
    providerVersion: config.providerVersion || WORKBUDDY_VERSION,
    defaultModel: config.defaultModel || WORKBUDDY_DEFAULT_MODEL,
    validatedModels: [...(config.validatedModels || WORKBUDDY_VALIDATED_MODELS)],
    requestedModel: requestedModel || null,
    actualModel: actualModel || null,
  };
}

export function workBuddyCapabilityReport(
  config = {},
  {
    platform = process.platform,
    sandboxExecutable = config.sandboxExecutable || config.permissionMapping?.sandboxExecutable || "/usr/bin/sandbox-exec",
    http = Boolean(config.httpUrl?.trim()),
  } = {},
) {
  const strategy = http ? "http-endpoint-unqualified" : String(config.permissionMapping?.strategy || "unknown");
  const providerHosts = [...new Set((config.permissionMapping?.providerHosts || WORKBUDDY_PROVIDER_NETWORK_HOSTS)
    .map((host) => String(host || "").trim().toLowerCase()).filter(Boolean))];
  const containedTools = normalizedContainedTools(config.permissionMapping?.containedTools);
  const remoteNetworkToolsDisabled = !remoteNetworkToolPresent(containedTools);
  const externalAvailable = !http
    && strategy === WORKBUDDY_CONTAINMENT_STRATEGY
    && platform === "darwin"
    && existsSync(sandboxExecutable)
    && providerHosts.length > 0
    && remoteNetworkToolsDisabled;
  const profilePolicy = Object.fromEntries(Object.entries(PROFILE_CATALOG).map(([key, profile]) => [
    key,
    externalAvailable
      ? { ...profile, mechanism: strategy, providerHosts, containedTools }
      : {
        ...unavailableProfile({
          reason: http
          ? "the configured WorkBuddy HTTP endpoint is outside this local process containment boundary"
            : !remoteNetworkToolsDisabled
              ? "WorkBuddy remote WebFetch/WebSearch tools are not contained by the local ACC boundary"
            : "approved WorkBuddy task containment is unavailable or unconfigured",
          profile: key,
          effective: profile,
        }),
        mechanism: strategy,
        providerHosts,
        containedTools,
      },
  ]));
  return {
    provider: "tencent-workbuddy",
    providerVersion: config.providerVersion || WORKBUDDY_VERSION,
    defaultModel: config.defaultModel || WORKBUDDY_DEFAULT_MODEL,
    validatedModels: [...(config.validatedModels || WORKBUDDY_VALIDATED_MODELS)],
    native: {
      available: true,
      permissionMode: config.permissionMapping?.nativePermissionMode || WORKBUDDY_NATIVE_PERMISSION_MODE,
      permissionFlag: "--permission-mode",
      enforcement: { write: "broad", network: "broad", sensitivePaths: "none" },
      reason: "WorkBuddy bypasses its approval UX per run; it is not the ACC security boundary",
      persistentSettingsMutation: false,
      containedTools,
      remoteNetworkTools: "disabled-in-contained-runs",
    },
    mapping: {
      strategy,
      scope: "task",
      safePerProcessOverride: !http,
      providerArgs: ["--permission-mode", WORKBUDDY_NATIVE_PERMISSION_MODE],
      persistentSettingsMutation: false,
      providerHosts,
      containedTools,
    },
    externalContainment: {
      strategy: externalAvailable ? strategy : "none",
      executable: sandboxExecutable,
      networkProxyRule: "localhost:*",
      networkProxyReason: WORKBUDDY_LOOPBACK_NETWORK_LIMITATION,
      localLoopback: "not-denied-by-seatbelt-compatibility-rule",
      available: externalAvailable,
      enforcement: {
        write: externalAvailable ? "canonical-scope" : "unavailable",
        network: externalAvailable ? "task-proxy" : "unavailable",
        sensitivePaths: externalAvailable ? "default-deny" : "unavailable",
        cleanup: externalAvailable ? "task-receipt" : "unavailable",
      },
      providerHosts,
    },
    effectiveEnforcement: {
      write: externalAvailable ? "scope-only-or-denied" : "unknown",
      network: externalAvailable ? "provider-hosts-or-proxy-with-direct-loopback-limitation" : "unknown",
      sensitivePaths: externalAvailable ? "task-default-deny" : "unknown",
      cleanup: externalAvailable ? "task-scoped" : "unknown",
    },
    executionProfiles: profilePolicy,
  };
}

export class WorkBuddyPermissionMappingUnavailableError extends Error {
  constructor(permissionPolicy, reason, preflight = null) {
    super(`workbuddy_permission_mapping_unavailable: ${reason}`);
    this.name = "WorkBuddyPermissionMappingUnavailableError";
    this.code = "workbuddy_permission_mapping_unavailable";
    this.details = { permissionPolicy, reason, preflight };
    this.preflight = preflight;
  }
}
