import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSandboxProfile,
  cleanupOrphanedAntigravityContainments,
  startTaskNetworkProxy,
} from "./antigravity-containment.mjs";
import {
  preflightWorkBuddyExecutionProfile,
  WORKBUDDY_CONTAINMENT_STRATEGY,
} from "./workbuddy-permissions.mjs";

export const WORKBUDDY_CONTAINMENT_UNAVAILABLE = "workbuddy_containment_unavailable";

function effectivePolicy(permissionPolicy) {
  return permissionPolicy?.effective && typeof permissionPolicy.effective === "object"
    ? permissionPolicy.effective
    : permissionPolicy && typeof permissionPolicy === "object"
      ? permissionPolicy
      : {};
}

function isPathInside(parent, child) {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
}

function canonicalDirectory(path, label) {
  if (!path || typeof path !== "string") throw new Error(`${label} is required`);
  if (!path.startsWith("/")) throw new Error(`${label} must be absolute`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}

function canonicalScope(scope) {
  const values = Array.isArray(scope) ? scope : [scope];
  const result = [...new Set(values.filter(Boolean).map((value) => canonicalDirectory(String(value), "filesystem scope")))];
  if (!result.length) throw new Error("WorkBuddy containment requires an explicit filesystem scope");
  return result;
}

function containmentRoot(config = {}) {
  return resolve(config.taskRoot || join(tmpdir(), "agent-control-center-workbuddy"));
}

function safeTaskDirectory(root, taskId) {
  const safeId = String(taskId || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "_");
  const directory = join(root, `${Date.now()}-${safeId}-${randomUUID().slice(0, 8)}`);
  if (!isPathInside(root, directory)) throw new Error("invalid WorkBuddy containment task directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function workBuddyProjectRuntimeRoot(cwd, home = homedir()) {
  const canonical = resolve(cwd).replace(/^\/+/, "").replaceAll("/", "-");
  return join(home, ".codebuddy", "projects", canonical);
}

export function workBuddyRuntimePath(cwd, home = homedir()) {
  return workBuddyProjectRuntimeRoot(cwd, home);
}

export async function prepareWorkBuddyContainment({
  taskId = randomUUID(),
  cwd,
  permissionPolicy,
  config = {},
  command,
} = {}) {
  if (process.platform !== "darwin") {
    const error = new Error(`${WORKBUDDY_CONTAINMENT_UNAVAILABLE}: sandbox-exec is only available on macOS`);
    error.code = WORKBUDDY_CONTAINMENT_UNAVAILABLE;
    throw error;
  }
  const sandboxExecutable = config.sandboxExecutable || "/usr/bin/sandbox-exec";
  if (!existsSync(sandboxExecutable)) {
    const error = new Error(`${WORKBUDDY_CONTAINMENT_UNAVAILABLE}: ${sandboxExecutable} is unavailable`);
    error.code = WORKBUDDY_CONTAINMENT_UNAVAILABLE;
    throw error;
  }
  const effective = effectivePolicy(permissionPolicy);
  const preflight = preflightWorkBuddyExecutionProfile(permissionPolicy, {
    strategy: config.strategy || WORKBUDDY_CONTAINMENT_STRATEGY,
    platform: process.platform,
    sandboxExecutable,
    nativePermissionMode: config.nativePermissionMode,
    providerHosts: config.providerHosts,
    containedTools: config.containedTools,
  });
  if (preflight.status !== "SUPPORTED") {
    const error = new Error(`${preflight.code}: ${preflight.reason}`);
    error.code = preflight.code;
    error.preflight = preflight;
    throw error;
  }
  const canonicalCwd = canonicalDirectory(cwd, "task cwd");
  const scopes = canonicalScope(effective.filesystemScope || [canonicalCwd]);
  if (!scopes.every((scope) => isPathInside(canonicalCwd, scope))) {
    throw new Error("WorkBuddy containment scope must remain inside the task cwd");
  }
  const rootPath = containmentRoot(config);
  mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  const root = realpathSync(rootPath);
  cleanupOrphanedAntigravityContainments({ root, maxAgeMs: Number(config.orphanMaxAgeMs) || 24 * 60 * 60 * 1000 });
  const taskDirectory = safeTaskDirectory(root, taskId);
  const providerRuntimeRoot = workBuddyProjectRuntimeRoot(canonicalCwd, config.homeDir || homedir());
  mkdirSync(providerRuntimeRoot, { recursive: true, mode: 0o700 });
  let proxy;
  try {
    writeFileSync(join(taskDirectory, "owner.json"), JSON.stringify({ taskId, pid: process.pid, createdAt: Date.now(), provider: "tencent-workbuddy" }) + "\n", { mode: 0o600 });
    proxy = await startTaskNetworkProxy({
      networkAllowed: effective.networkAllowed === true,
      providerHosts: config.providerHosts,
      upstreamEnvironment: process.env,
    });
    const profile = buildSandboxProfile({
      filesystemScope: scopes,
      writeAllowed: effective.writeAllowed === true,
      networkProxyPort: proxy.port,
      networkProxyWildcard: true,
      runtimeRoot: providerRuntimeRoot,
      allowSystemCaBundle: true,
      // WorkBuddy records its provider-managed session JSONL under this
      // project-specific runtime path. It is not the task filesystem scope.
      taskRoot: providerRuntimeRoot,
      sensitivePathPolicy: effective.sensitivePathPolicy,
    });
    const profilePath = join(taskDirectory, "profile.sb");
    writeFileSync(profilePath, profile, { mode: 0o600 });
    let cleaned = false;
    let cleanupPromise;
    const cleanup = async (reason = "task_finished") => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        await proxy.close();
        rmSync(taskDirectory, { recursive: true, force: true });
        cleaned = true;
        return {
          state: "cleaned",
          reason,
          taskId,
          taskDirectory,
          providerRuntimeRoot,
          providerRuntimeCleanup: "provider-managed-not-deleted",
        };
      })();
      return cleanupPromise;
    };
    const providerHosts = [...new Set((config.providerHosts || []).map((host) => String(host || "").trim().toLowerCase()).filter(Boolean))];
    return {
      sandboxExecutable,
      profilePath,
      providerHosts,
      providerRuntimeRoot,
      argsFor(providerArgs) {
        return ["-f", profilePath, command, ...providerArgs];
      },
      env: {
        HTTP_PROXY: `http://localhost:${proxy.port}`,
        HTTPS_PROXY: `http://localhost:${proxy.port}`,
        ALL_PROXY: `http://localhost:${proxy.port}`,
        http_proxy: `http://localhost:${proxy.port}`,
        https_proxy: `http://localhost:${proxy.port}`,
        all_proxy: `http://localhost:${proxy.port}`,
        NO_PROXY: "",
        no_proxy: "",
      },
      permissionReceipt: {
        mechanism: WORKBUDDY_CONTAINMENT_STRATEGY,
        taskId,
        writeAllowed: effective.writeAllowed === true,
        networkAllowed: effective.networkAllowed === true,
        filesystemScope: scopes,
        providerHosts,
        externalNetwork: effective.networkAllowed === true ? "allowlisted-proxy-wildcard-with-loopback-limit" : "provider-hosts-only-with-loopback-limit",
        localLoopback: "not-denied-by-seatbelt-compatibility-rule",
        providerRuntimeRoot,
        providerRuntimeCleanup: "provider-managed-not-deleted",
        persistentSettingsMutation: false,
        sensitivePathPolicy: effective.sensitivePathPolicy,
        executionProfile: preflight,
      },
      cleanup,
      get cleaned() {
        return cleaned;
      },
    };
  } catch (error) {
    try { await proxy?.close(); } catch { /* Preserve the original preparation error. */ }
    rmSync(taskDirectory, { recursive: true, force: true });
    throw error;
  }
}
