import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { connect as connectNet } from "node:net";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ANTIGRAVITY_CONTAINMENT_STRATEGY = "sandbox-exec-proxy";
export const ANTIGRAVITY_CONTAINMENT_UNAVAILABLE = "antigravity_containment_unavailable";

// These are the provider transport endpoints observed from agy 1.1.27. They
// remain reachable even when the task's tool-network capability is denied;
// otherwise the model backend itself cannot produce a tool decision. They are
// deliberately exact host entries rather than a broad *.googleapis.com rule.
export const DEFAULT_PROVIDER_NETWORK_HOSTS = Object.freeze([
  "accounts.google.com",
  "daily-cloudcode-pa.googleapis.com",
  "generativelanguage.googleapis.com",
  "lh3.googleusercontent.com",
  "oauth2.googleapis.com",
  "www.googleapis.com",
]);

const RUNTIME_WRITABLE_DIRECTORIES = Object.freeze([
  "log",
  "crashes",
  "conversations",
  "brain",
  "annotations",
  "presence",
  "cache",
]);

const RUNTIME_WRITABLE_LITERALS = Object.freeze([
  "bin/agentapi",
  "conversation_summaries.db",
  "conversation_summaries.db-wal",
  "conversation_summaries.db-shm",
  "jetski_state.pbtxt",
]);

function quoteProfileValue(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function profileRule(operation, kind, path) {
  return `(allow ${operation} (${kind} ${quoteProfileValue(path)}))`;
}

function exactHost(value) {
  return String(value || "").trim().toLowerCase().replace(/^\.+/, "");
}

function normalizedHostSet(value, fallback = DEFAULT_PROVIDER_NETWORK_HOSTS) {
  const values = value === undefined ? fallback : Array.isArray(value) ? value : [value];
  return [...new Set(values.map(exactHost).filter((host) => host && !host.includes("/")))];
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
  if (!result.length) throw new Error("Antigravity containment requires an explicit filesystem scope");
  return result;
}

function effectivePolicy(permissionPolicy) {
  return permissionPolicy?.effective && typeof permissionPolicy.effective === "object"
    ? permissionPolicy.effective
    : permissionPolicy && typeof permissionPolicy === "object"
      ? permissionPolicy
      : {};
}

function runtimePaths(runtimeRoot = join(homedir(), ".gemini", "antigravity-cli")) {
  const root = resolve(runtimeRoot);
  return {
    root,
    directories: RUNTIME_WRITABLE_DIRECTORIES.map((name) => join(root, name)),
    literals: RUNTIME_WRITABLE_LITERALS.map((name) => join(root, name)),
  };
}

export function antigravityRuntimeWritePaths(runtimeRoot) {
  const paths = runtimePaths(runtimeRoot);
  return [...paths.directories, ...paths.literals];
}

export function networkTargetAllowed(host, { networkAllowed = false, providerHosts = DEFAULT_PROVIDER_NETWORK_HOSTS } = {}) {
  const normalized = exactHost(host).replace(/^\[|\]$/g, "");
  if (!normalized) return false;
  // The task proxy must never become a bridge into the local ACC/control
  // surface, even for a task that requested external network access.
  if (
    normalized === "localhost"
    || normalized === "localhost.localdomain"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "0.0.0.0"
    || normalized.endsWith(".local")
  ) return false;
  const providers = new Set(normalizedHostSet(providerHosts));
  if (providers.has(normalized)) return true;
  return networkAllowed === true;
}

export function buildSandboxProfile({
  filesystemScope,
  writeAllowed = false,
  networkProxyPort,
  runtimeRoot = join(homedir(), ".gemini", "antigravity-cli"),
  command,
  taskRoot,
} = {}) {
  const scopes = canonicalScope(filesystemScope);
  const runtime = runtimePaths(runtimeRoot);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    // agy is a signed Go binary with dynamic runtime access across the macOS
    // system tree. On this host, narrow file-read subpath rules make
    // sandbox-exec abort before launch; keep the read side broad and enforce
    // the task boundary on file writes and network egress below.
    "(allow file-read*)",
    ...(writeAllowed ? scopes.map((scope) => profileRule("file-write*", "subpath", scope)) : []),
    ...runtime.directories.map((path) => profileRule("file-write*", "subpath", path)),
    ...runtime.literals.map((path) => profileRule("file-write*", "literal", path)),
    profileRule("file-write*", "literal", "/dev/null"),
    profileRule("network-outbound", "remote tcp", `localhost:${Number(networkProxyPort)}`),
    profileRule("network-inbound", "local tcp", "localhost:*"),
    // The macOS Security framework resolves the login keychain through a
    // bootstrap service name that varies by OS release. Exact names observed
    // on one release are insufficient; this is the minimum provider-runtime
    // IPC exception needed to preserve the user's existing agy login.
    "(allow mach-lookup)",
  ];
  if (taskRoot) {
    lines.push(profileRule("file-read*", "subpath", resolve(taskRoot)));
    lines.push(profileRule("file-write*", "subpath", resolve(taskRoot)));
  }
  return `${lines.join("\n")}\n`;
}

function proxyUrlFromEnvironment(environment = process.env) {
  const value = environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy || environment.ALL_PROXY || environment.all_proxy;
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:") return null;
    return parsed;
  } catch {
    return null;
  }
}

function proxyAuthorization(url) {
  if (!url?.username && !url?.password) return "";
  return `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}\r\n`;
}

function parseConnectResponse(buffer) {
  const marker = buffer.indexOf("\r\n\r\n");
  if (marker < 0) return null;
  const firstLine = buffer.slice(0, marker).toString("latin1").split("\r\n", 1)[0] || "";
  const match = firstLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
  return { statusCode: match ? Number(match[1]) : 0, bytes: marker + 4 };
}

function socketTarget(host, port) {
  const normalized = String(host || "").replace(/^\[|\]$/g, "");
  return { host: normalized, port: Number(port) || 443 };
}

function upstreamConnect(client, target, upstream) {
  const upstreamSocket = connectNet({ host: upstream.hostname, port: Number(upstream.port) || 80 });
  let responseBuffer = Buffer.alloc(0);
  let connected = false;
  client.on("error", () => {});
  upstreamSocket.on("error", () => {});
  const fail = () => {
    if (!client.destroyed) client.destroy();
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };
  upstreamSocket.once("error", fail);
  upstreamSocket.once("connect", () => {
    const hostHeader = `${target.host}:${target.port}`;
    upstreamSocket.write(`CONNECT ${hostHeader} HTTP/1.1\r\nHost: ${hostHeader}\r\n${proxyAuthorization(upstream)}\r\n`);
  });
  upstreamSocket.on("data", (chunk) => {
    if (connected) return;
    responseBuffer = Buffer.concat([responseBuffer, chunk]);
    const parsed = parseConnectResponse(responseBuffer);
    if (!parsed) return;
    if (parsed.statusCode !== 200) {
      fail();
      return;
    }
    connected = true;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const remainder = responseBuffer.subarray(parsed.bytes);
    if (remainder.length) client.unshift(remainder);
    upstreamSocket.pipe(client);
    client.pipe(upstreamSocket);
  });
}

function directConnect(client, target) {
  const remote = connectNet({ host: target.host, port: target.port });
  client.on("error", () => {});
  remote.on("error", () => {});
  const fail = () => {
    if (!client.destroyed) client.destroy();
    if (!remote.destroyed) remote.destroy();
  };
  remote.once("error", fail);
  remote.once("connect", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    remote.pipe(client);
    client.pipe(remote);
  });
}

function forwardHttpRequest(request, response, target, upstream, allowed) {
  if (!allowed) {
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("network target denied by ACC task policy\n");
    return;
  }
  const headers = { ...request.headers };
  delete headers["proxy-connection"];
  const requestOptions = upstream
    ? {
        hostname: upstream.hostname,
        port: Number(upstream.port) || 80,
        method: request.method,
        path: request.url,
        headers: { ...headers, host: target.host },
        auth: upstream.username || upstream.password
          ? `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`
          : undefined,
      }
    : {
        hostname: target.host,
        port: target.port,
        method: request.method,
        path: target.path,
        headers,
      };
  const upstreamRequest = httpRequest(requestOptions, (upstreamResponse) => {
    upstreamResponse.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("upstream network response failed\n");
    });
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  request.on("error", () => upstreamRequest.destroy());
  response.on("error", () => upstreamRequest.destroy());
  upstreamRequest.once("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end("upstream network request failed\n");
  });
  request.pipe(upstreamRequest);
}

async function startTaskNetworkProxy({ networkAllowed = false, providerHosts, upstreamEnvironment = process.env } = {}) {
  const allowedProviders = normalizedHostSet(providerHosts);
  const upstream = proxyUrlFromEnvironment(upstreamEnvironment);
  const sockets = new Set();
  const server = createServer();
  const allowed = (host) => networkTargetAllowed(host, { networkAllowed, providerHosts: allowedProviders });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("request", (request, response) => {
    let target;
    try {
      target = new URL(request.url, `http://${request.headers.host || ""}`);
    } catch {
      response.writeHead(400);
      response.end("invalid proxy target\n");
      return;
    }
    const host = target.hostname;
    const targetInfo = { host, port: Number(target.port) || (target.protocol === "https:" ? 443 : 80), path: `${target.pathname}${target.search}` };
    forwardHttpRequest(request, response, targetInfo, upstream, allowed(host));
  });
  server.on("connect", (request, clientSocket, head) => {
    let host = "";
    let port = 443;
    try {
      const parsed = new URL(`http://${request.url}`);
      host = parsed.hostname;
      port = Number(parsed.port) || 443;
    } catch {
      const parts = String(request.url || "").split(":");
      host = parts[0];
      port = Number(parts[1]) || 443;
    }
    if (!allowed(host)) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (head?.length) clientSocket.unshift(head);
    const target = socketTarget(host, port);
    if (upstream) upstreamConnect(clientSocket, target, upstream);
    else directConnect(clientSocket, target);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: "127.0.0.1", port: 0 }, resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  if (!port) {
    server.close();
    throw new Error("task network proxy did not expose a port");
  }
  let closed = false;
  return {
    port,
    providerHosts: allowedProviders,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

function containmentRoot(config = {}) {
  return resolve(config.taskRoot || join(tmpdir(), "agent-control-center-antigravity"));
}

function safeTaskDirectory(root, taskId) {
  const safeId = String(taskId || randomUUID()).replace(/[^a-zA-Z0-9_-]/g, "_");
  const directory = join(root, `${Date.now()}-${safeId}-${randomUUID().slice(0, 8)}`);
  if (!isPathInside(root, directory)) throw new Error("invalid Antigravity containment task directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function aliveProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function cleanupOrphanedAntigravityContainments({ root = containmentRoot(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const directory = resolve(root);
  if (!existsSync(directory)) return 0;
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const taskDirectory = join(directory, entry.name);
    const marker = join(taskDirectory, "owner.json");
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(marker, "utf8"));
    } catch {
      metadata = null;
    }
    const createdAt = Number(metadata?.createdAt || 0);
    if (metadata?.pid && aliveProcess(Number(metadata.pid))) continue;
    if (createdAt && createdAt > cutoff) continue;
    rmSync(taskDirectory, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export async function prepareAntigravityContainment({
  taskId = randomUUID(),
  cwd,
  permissionPolicy,
  config = {},
  command,
} = {}) {
  if (process.platform !== "darwin") {
    const error = new Error(`${ANTIGRAVITY_CONTAINMENT_UNAVAILABLE}: sandbox-exec is only available on macOS`);
    error.code = ANTIGRAVITY_CONTAINMENT_UNAVAILABLE;
    throw error;
  }
  const sandboxExecutable = config.sandboxExecutable || "/usr/bin/sandbox-exec";
  if (!existsSync(sandboxExecutable)) {
    const error = new Error(`${ANTIGRAVITY_CONTAINMENT_UNAVAILABLE}: ${sandboxExecutable} is unavailable`);
    error.code = ANTIGRAVITY_CONTAINMENT_UNAVAILABLE;
    throw error;
  }
  const effective = effectivePolicy(permissionPolicy);
  const canonicalCwd = canonicalDirectory(cwd, "task cwd");
  const scopes = canonicalScope(effective.filesystemScope || [canonicalCwd]);
  if (!scopes.every((scope) => isPathInside(canonicalCwd, scope))) {
    throw new Error("Antigravity containment scope must remain inside the task cwd");
  }
  const rootPath = containmentRoot(config);
  mkdirSync(rootPath, { recursive: true, mode: 0o700 });
  const root = realpathSync(rootPath);
  cleanupOrphanedAntigravityContainments({ root, maxAgeMs: Number(config.orphanMaxAgeMs) || 24 * 60 * 60 * 1000 });
  const taskDirectory = safeTaskDirectory(root, taskId);
  const logPath = join(taskDirectory, "agy.log");
  let proxy;
  try {
    writeFileSync(join(taskDirectory, "owner.json"), JSON.stringify({ taskId, pid: process.pid, createdAt: Date.now() }) + "\n", { mode: 0o600 });
    proxy = await startTaskNetworkProxy({
      networkAllowed: effective.networkAllowed === true,
      providerHosts: config.providerHosts,
      upstreamEnvironment: process.env,
    });
    const profile = buildSandboxProfile({
      filesystemScope: scopes,
      writeAllowed: effective.writeAllowed === true,
      networkProxyPort: proxy.port,
      runtimeRoot: config.runtimeRoot,
      command,
      taskRoot: taskDirectory,
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
        };
      })();
      return cleanupPromise;
    };
    const providerHosts = normalizedHostSet(config.providerHosts);
    return {
      sandboxExecutable,
      profilePath,
      logPath,
      providerHosts,
      argsFor(providerArgs, { skipPermissions = true } = {}) {
        const args = ["-f", profilePath, command, ...providerArgs];
        if (skipPermissions && !args.includes("--dangerously-skip-permissions")) args.push("--dangerously-skip-permissions");
        if (!args.includes("--log-file")) args.push("--log-file", logPath);
        return args;
      },
      env: {
        HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
        ALL_PROXY: `http://127.0.0.1:${proxy.port}`,
        http_proxy: `http://127.0.0.1:${proxy.port}`,
        https_proxy: `http://127.0.0.1:${proxy.port}`,
        all_proxy: `http://127.0.0.1:${proxy.port}`,
        NO_PROXY: "",
        no_proxy: "",
      },
      permissionReceipt: {
        mechanism: ANTIGRAVITY_CONTAINMENT_STRATEGY,
        taskId,
        writeAllowed: effective.writeAllowed === true,
        networkAllowed: effective.networkAllowed === true,
        filesystemScope: scopes,
        providerHosts,
        externalNetwork: effective.networkAllowed === true ? "allowlisted-proxy-wildcard" : "provider-hosts-only",
        persistentSettingsMutation: false,
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
