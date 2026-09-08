import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

export const NATIVE_PERMISSION_MAPPING_UNAVAILABLE = "native_permission_mapping_unavailable";

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
  constructor(permissionPolicy, reason = "agy 1.1.27 exposes no safe per-run permission override") {
    super(`${NATIVE_PERMISSION_MAPPING_UNAVAILABLE}: ${reason}`);
    this.name = "NativePermissionMappingUnavailableError";
    this.code = NATIVE_PERMISSION_MAPPING_UNAVAILABLE;
    this.details = {
      rules: rulesForEffectivePolicy(permissionPolicy),
      reason,
    };
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
