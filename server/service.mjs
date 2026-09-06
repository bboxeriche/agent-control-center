import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { extname, join, resolve } from "node:path";
import { adapterFor, healthFor } from "./adapters.mjs";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  SERVICE_VERSION,
  buildPermissionPolicy,
  capabilitiesFor,
  ensureDir,
  ensureAuthToken,
  idempotencyFingerprint,
  isTerminalStatus,
  loadConfig,
  makeId,
  nowIso,
  normalizeOptionalIdentifier,
  normalizeOrigin,
  resolveDataDir,
  redactSecrets,
  truncate,
  validateCwd,
  validatePrompt,
} from "./core.mjs";
import { Store } from "./store.mjs";

const WEB_ROOT = resolve(fileURLToPath(new URL("../web/", import.meta.url)));

class EventHub {
  constructor() {
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected stream must not affect task execution.
      }
    }
  }
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(Math.max(number, minimum), maximum);
}

function cursorValue(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw statusError(400, "event cursor must be a non-negative integer");
  return number;
}

function taskIsTerminal(task) {
  return Boolean(task && isTerminalStatus(task.status));
}

function statusError(status, message) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function discussionAgentNames(config, requested) {
  const names = requested?.length ? requested : Object.keys(config.agents);
  const unique = [...new Set(names.map((name) => String(name)))];
  if (!unique.length) throw new Error("at least one agent is required");
  if (unique.length > 6) throw new Error("a discussion can include at most six agents");
  for (const name of unique) {
    if (!config.agents[name]) throw new Error(`unknown agent: ${name}`);
  }
  return unique;
}

function terminalStatusForResult(result, runtime) {
  if (runtime.stopRequested || result?.stopRequested) return "stopped";
  if (runtime.timedOut) return "timed_out";
  if (result?.error || result?.exitCode !== 0) return "failed";
  return "succeeded";
}

function safeResultText(runtime, result) {
  const streamed = runtime.textParts.filter(Boolean).join("\n").trim();
  if (streamed) return truncate(redactSecrets(streamed), 60000);
  return truncate(redactSecrets(result?.stdout || ""), 60000);
}

export class ControlPlane {
  constructor({ dataDir = resolveDataDir(), config = null } = {}) {
    this.dataDir = ensureDir(dataDir);
    this.authToken = ensureAuthToken(this.dataDir);
    this.store = new Store(this.dataDir);
    this.config = config || loadConfig(this.dataDir).config;
    this.hub = new EventHub();
    this.runtime = new Map();
    this.runningPromises = new Map();
    this.replyLocks = new Map();
    this.discussionPromises = new Map();
    this.queue = [];
    this.stoppedDiscussions = new Set();
    this.activeCount = 0;
    this.store.recoverActiveTasks();
  }

  emit(input) {
    const event = this.store.addEvent(input);
    this.hub.publish(event);
    return event;
  }

  createTask(input = {}) {
    return this.createTaskRequest(input).task;
  }

  createTaskRequest(input = {}) {
    const agentConfig = this.config.agents[input.agent];
    if (!agentConfig) throw new Error(`unknown agent: ${input.agent}`);
    const prompt = validatePrompt(input.prompt, this.config.maxPromptChars);
    const origin = normalizeOrigin(input.origin, "local_cli");
    const cwd = validateCwd(input.cwd || this.config.defaultCwd || process.env.AGENT_CONTROL_DEFAULT_CWD, {
      allowedRoots: this.config.allowedRoots,
      enforceAllowedRoot: origin === "devspace" || origin === "dashboard",
      rejectTraversal: origin === "devspace" || origin === "dashboard",
    });
    const timeoutMs = clamp(input.timeoutMs, 1000, 4 * 60 * 60 * 1000, this.config.defaultTimeoutMs);
    const model = input.model === undefined || input.model === null || String(input.model).trim() === ""
      ? agentConfig.defaultModel || null
      : String(input.model).trim();
    const originRequestId = normalizeOptionalIdentifier(input.originRequestId, "originRequestId");
    const idempotencyKey = normalizeOptionalIdentifier(input.idempotencyKey, "idempotencyKey");
    const capabilities = capabilitiesFor(input.agent, this.config);
    const requestedPermissions = input.permissionPolicy ?? {};
    if (typeof requestedPermissions !== "object" || Array.isArray(requestedPermissions)) {
      throw new Error("permissionPolicy must be an object");
    }
    const permissionPolicy = buildPermissionPolicy({
      cwd,
      origin,
      requested: requestedPermissions,
      capabilities,
    });
    const requestFingerprint = idempotencyFingerprint({
      agent: input.agent,
      prompt,
      cwd,
      model,
      timeoutMs,
      origin,
      permissionPolicy: permissionPolicy.effective,
    });
    if (idempotencyKey) {
      const existing = this.store.getTaskByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.idempotencyFingerprint !== requestFingerprint) throw statusError(409, "idempotency_conflict");
        return { task: existing, reused: true };
      }
    }
    let task;
    try {
      task = this.store.createTask({
        id: input.id,
        parentTaskId: input.parentTaskId,
        discussionId: input.discussionId,
        roundNo: input.roundNo,
        agent: input.agent,
        prompt,
        cwd,
        timeoutMs,
        model,
        origin,
        originRequestId,
        idempotencyKey,
        idempotencyFingerprint: requestFingerprint,
        permissionPolicy,
        capabilities,
        providerSessionId: input.sessionId || input.providerSessionId,
        metadata: input.metadata || {},
      });
    } catch (error) {
      if (idempotencyKey && /UNIQUE constraint failed: tasks\.idempotency_key/.test(error.message)) {
        const existing = this.store.getTaskByIdempotencyKey(idempotencyKey);
        if (existing) {
          if (existing.idempotencyFingerprint !== requestFingerprint) throw statusError(409, "idempotency_conflict");
          return { task: existing, reused: true };
        }
      }
      throw error;
    }
    this.emit({
      taskId: task.id,
      eventType: "task_created",
      source: "control-plane",
      payload: {
        taskId: task.id,
        agent: task.agent,
        cwd: task.cwd,
        origin: task.origin,
        originRequestId: task.originRequestId,
        discussionId: task.discussionId,
        roundNo: task.roundNo,
      },
    });
    this.queue.push(task.id);
    this.pump();
    return { task: this.getTask(task.id), reused: false };
  }

  pump() {
    while (this.activeCount < this.config.maxConcurrentTasks && this.queue.length) {
      const taskId = this.queue.shift();
      const task = this.store.getTask(taskId);
      if (!task || taskIsTerminal(task) || this.runningPromises.has(taskId) || task.status === "running") continue;
      this.activeCount += 1;
      const running = this.runTask(taskId).catch((error) => {
        try {
          const current = this.store.getTask(taskId);
          if (current && !taskIsTerminal(current)) {
            const failed = this.store.updateTask(taskId, {
              status: "failed",
              finishedAt: nowIso(),
              errorText: error.message,
            });
            this.emit({ taskId, eventType: "task_finished", source: "control-plane", payload: { taskId, status: failed.status, error: failed.errorText } });
            return failed;
          }
        } catch {
          // The service may already be closing; preserve the original failure.
        }
        return null;
      });
      this.runningPromises.set(taskId, running);
      void running.then(() => {
        this.activeCount -= 1;
        this.runtime.delete(taskId);
        this.runningPromises.delete(taskId);
        this.pump();
      });
    }
  }

  async runTask(taskId) {
    const task = this.store.getTask(taskId);
    if (!task) return;
    const runtime = {
      textParts: [],
      handle: null,
      stopRequested: false,
      timedOut: false,
      providerSessionId: task.providerSessionId || "",
      providerJobId: task.providerJobId || "",
    };
    this.runtime.set(taskId, runtime);
    this.store.updateTask(taskId, { status: "running", startedAt: nowIso(), errorText: null });
    this.emit({
      taskId,
      eventType: "task_started",
      source: "control-plane",
      payload: {
        taskId,
        agent: task.agent,
        cwd: task.cwd,
        timeoutMs: task.timeoutMs,
        origin: task.origin,
        attemptNo: task.attemptNo,
        permissionStatus: task.permissionPolicy.status || "unknown",
      },
    });
    let result;
    try {
      const adapter = adapterFor(task.agent, this.config);
      const handle = await adapter.start({
        prompt: task.prompt,
        cwd: task.cwd,
        model: task.model,
        sessionId: task.providerSessionId,
        permissionPolicy: task.permissionPolicy,
        capabilities: task.capabilities,
      }, (event) => {
        const sessionId = event.sessionId || runtime.providerSessionId || "";
        if (sessionId && sessionId !== runtime.providerSessionId) {
          runtime.providerSessionId = sessionId;
          this.store.updateTask(taskId, { providerSessionId: sessionId });
        }
        if (event.text && !["provider_error", "stderr"].includes(event.type)) runtime.textParts.push(event.text);
        this.emit({
          taskId,
          eventType: event.type || "provider_message",
          source: task.agent,
          stream: event.stream,
          payload: event.payload || { text: event.text },
        });
      });
      runtime.handle = handle;
      if (handle.providerSessionId) runtime.providerSessionId = handle.providerSessionId;
      if (handle.providerJobId) runtime.providerJobId = handle.providerJobId;
      this.store.updateTask(taskId, {
        providerSessionId: runtime.providerSessionId || null,
        providerJobId: runtime.providerJobId || null,
      });
      this.emit({
        taskId,
        eventType: "provider_started",
        source: task.agent,
          payload: {
          provider: handle.provider,
          pid: handle.pid || null,
          providerJobId: runtime.providerJobId || null,
          command: this.config.agents[task.agent].command || null,
          argCount: handle.args?.length || 0,
        },
      });
      const timeoutPromise = new Promise((resolve) => {
        runtime.timeoutTimer = setTimeout(() => {
          runtime.timedOut = true;
          void Promise.resolve(handle.stop()).catch(() => {}).then(() => {
            resolve({ exitCode: null, signal: "SIGTERM", error: "task timed out" });
          });
        }, task.timeoutMs);
      });
      result = await Promise.race([Promise.resolve(handle.wait).catch((error) => ({ exitCode: null, error: error.message })), timeoutPromise]);
      clearTimeout(runtime.timeoutTimer);
      if (runtime.providerSessionId === "" && handle.getProviderSessionId) runtime.providerSessionId = handle.getProviderSessionId() || "";
    } catch (error) {
      result = { exitCode: null, signal: null, error: error.message, stdout: "", stderr: "" };
      this.emit({ taskId, eventType: "provider_error", source: task.agent, payload: { error: error.message } });
    }
    const finalStatus = terminalStatusForResult(result, runtime);
    const errorText = result?.error || (finalStatus === "failed" ? truncate(result?.stderr || "provider exited with an error", 4000) : null);
    const finished = this.store.updateTask(taskId, {
      status: finalStatus,
      finishedAt: nowIso(),
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      providerSessionId: runtime.providerSessionId || null,
      providerJobId: runtime.providerJobId || null,
      resultText: safeResultText(runtime, result),
      errorText,
    });
    this.emit({
      taskId,
      eventType: "task_finished",
      source: "control-plane",
      payload: {
        taskId,
        status: finalStatus,
        exitCode: finished.exitCode,
        signal: finished.signal,
        providerSessionId: finished.providerSessionId,
        providerJobId: finished.providerJobId,
        error: errorText,
      },
    });
    return finished;
  }

  getTask(id) {
    const task = this.store.getTask(id);
    if (!task) throw statusError(404, `task not found: ${id}`);
    return task;
  }

  listTasks(limit) {
    return this.store.listTasks(limit);
  }

  listTaskEvents(id, after) {
    this.getTask(id);
    return this.store.listEvents({ taskId: id, after: cursorValue(after) });
  }

  listTaskEventPage(id, afterCursor, limit) {
    const task = this.getTask(id);
    return {
      ...this.store.listEventsPage({ taskId: id, after: cursorValue(afterCursor), limit }),
      eventCursor: task.eventCursor,
    };
  }

  async stopTask(id) {
    const task = this.getTask(id);
    if (taskIsTerminal(task)) return task;
    const queuedIndex = this.queue.indexOf(id);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      const stopped = this.store.updateTask(id, { status: "stopped", finishedAt: nowIso(), errorText: "Stopped while queued" });
      this.emit({ taskId: id, eventType: "task_finished", source: "control-plane", payload: { taskId: id, status: "stopped" } });
      return stopped;
    }
    const runtime = this.runtime.get(id);
    if (!runtime?.handle) throw new Error(`task is not controllable at the moment: ${id}`);
    runtime.stopRequested = true;
    this.emit({ taskId: id, eventType: "stop_requested", source: "control-plane", payload: { taskId: id } });
    await runtime.handle.stop();
    try {
      return await this.waitForTask(id, 5000);
    } catch {
      return this.getTask(id);
    }
  }

  async replyTask(id, prompt, options = {}) {
    const taskBeforeLock = this.getTask(id);
    const hadQueuedReply = this.replyLocks.has(id);
    if (!taskIsTerminal(taskBeforeLock) && !this.runtime.get(id)?.handle?.reply && !hadQueuedReply) {
      throw statusError(409, "provider does not support live replies; wait for task completion before resuming the session");
    }
    const previous = this.replyLocks.get(id) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.replyLocks.set(id, current);
    try {
      await previous;
      return await this._replyTask(id, prompt, options);
    } finally {
      release();
      if (this.replyLocks.get(id) === current) this.replyLocks.delete(id);
    }
  }

  async _replyTask(id, prompt, options = {}) {
    const task = this.getTask(id);
    const value = validatePrompt(prompt, this.config.maxPromptChars);
    const actionOrigin = normalizeOrigin(options.origin, task.origin || "local_cli");
    const actionRequestId = normalizeOptionalIdentifier(options.originRequestId, "originRequestId");
    const runtime = this.runtime.get(id);
    if (!taskIsTerminal(task) && runtime?.handle?.reply) {
      const response = await runtime.handle.reply(value);
      this.emit({
        taskId: id,
        eventType: "provider_reply_sent",
        source: task.agent,
        payload: {
          prompt: redactSecrets(value),
          response,
          origin: actionOrigin,
          originRequestId: actionRequestId,
        },
      });
      return this.getTask(id);
    }
    if (!taskIsTerminal(task)) {
      const priorRun = this.runningPromises.get(id);
      if (priorRun) {
        await Promise.allSettled([priorRun]);
        return this._replyTask(id, value, options);
      }
      throw statusError(409, "provider does not support live replies; wait for task completion before resuming the session");
    }
    const priorRun = this.runningPromises.get(id);
    if (priorRun) await Promise.allSettled([priorRun]);
    const nextAttemptNo = Number(task.attemptNo || 1) + 1;
    const resumed = this.store.updateTask(id, {
      status: "queued",
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      signal: null,
      resultText: null,
      errorText: null,
      providerJobId: null,
      prompt: value,
      attemptNo: nextAttemptNo,
      metadata: {
        ...task.metadata,
        replyTo: task.id,
        resumed: Boolean(task.providerSessionId),
        lastReplyOrigin: actionOrigin,
        lastReplyOriginRequestId: actionRequestId,
      },
    });
    this.emit({
      taskId: id,
      eventType: "task_resumed",
      source: "control-plane",
      payload: {
        taskId: id,
        attemptNo: nextAttemptNo,
        providerSessionId: task.providerSessionId,
        providerResumeSupported: capabilitiesFor(task.agent, this.config).resume,
        origin: actionOrigin,
        originRequestId: actionRequestId,
      },
    });
    this.queue.push(id);
    this.pump();
    return this.getTask(resumed.id);
  }

  async agentHealth() {
    const entries = await Promise.all(Object.keys(this.config.agents).map((agent) => healthFor(agent, this.config)));
    return entries;
  }

  createDiscussion(input) {
    const prompt = validatePrompt(input.prompt, this.config.maxPromptChars);
    const agents = discussionAgentNames(this.config, input.agents);
    const rounds = clamp(input.rounds, 1, this.config.maxDiscussionRounds, 2);
    const origin = normalizeOrigin(input.origin, "local_cli");
    const cwd = validateCwd(input.cwd || this.config.defaultCwd || process.env.AGENT_CONTROL_DEFAULT_CWD, {
      allowedRoots: this.config.allowedRoots,
      enforceAllowedRoot: origin === "devspace" || origin === "dashboard",
      rejectTraversal: origin === "devspace" || origin === "dashboard",
    });
    const originRequestId = normalizeOptionalIdentifier(input.originRequestId, "originRequestId");
    const discussion = this.store.createDiscussion({ prompt, cwd, agents, rounds, origin, originRequestId });
    this.stoppedDiscussions.delete(discussion.id);
    this.emit({ discussionId: discussion.id, eventType: "discussion_created", source: "control-plane", payload: { discussionId: discussion.id, agents, rounds, origin, originRequestId } });
    const running = this.runDiscussion(discussion.id);
    this.discussionPromises.set(discussion.id, running);
    void running.then(() => {
      if (this.discussionPromises.get(discussion.id) === running) this.discussionPromises.delete(discussion.id);
    }, () => {
      if (this.discussionPromises.get(discussion.id) === running) this.discussionPromises.delete(discussion.id);
    });
    return discussion;
  }

  discussionPrompt(discussion, roundNo, priorMessages) {
    const role = roundNo === 1
      ? "Analyze the problem independently."
      : "Critique the peer responses below, identify disagreements, and revise your recommendation.";
    const peerContext = roundNo === 1
      ? ""
      : `\n\nPeer responses from the previous round:\n${truncate(priorMessages.map((message) => `### ${message.agent}\n${message.text}`).join("\n\n"), 11000)}`;
    return truncate(`You are one participant in a controlled multi-agent engineering discussion. ${role}\n\nOriginal problem:\n${discussion.prompt}\n\nRepository working directory: ${discussion.cwd}\n\nReturn a concise response with these labels when applicable:\nRecommendation:\nAssumptions:\nRisks:\nNext steps:\nDo not make file changes unless the original problem explicitly asks for implementation.${peerContext}`, this.config.maxPromptChars);
  }

  async runDiscussion(id) {
    const initial = this.store.getDiscussion(id);
    if (!initial) return;
    this.store.updateDiscussion(id, { status: "running", startedAt: nowIso(), errorText: null });
    this.emit({ discussionId: id, eventType: "discussion_started", source: "control-plane", payload: { discussionId: id } });
    try {
      for (let roundNo = 1; roundNo <= initial.rounds; roundNo += 1) {
        if (this.stoppedDiscussions.has(id)) return;
        const current = this.store.getDiscussion(id);
        const priorMessages = current.messages.filter((message) => message.roundNo === roundNo - 1);
        const taskIds = current.agents.map((agent) => this.createTask({
          agent,
          prompt: this.discussionPrompt(current, roundNo, priorMessages),
          cwd: current.cwd,
          origin: current.origin,
          originRequestId: current.originRequestId,
          discussionId: id,
          roundNo,
          metadata: { discussionRound: roundNo },
        }).id);
        const finishedTasks = await Promise.all(taskIds.map(async (taskId) => {
          try {
            return await this.waitForTask(taskId, current.rounds * this.config.defaultTimeoutMs);
          } catch {
            return this.getTask(taskId);
          }
        }));
        for (const task of finishedTasks) {
          this.store.addDiscussionMessage({
            discussionId: id,
            taskId: task.id,
            agent: task.agent,
            roundNo,
            role: "response",
            text: task.resultText || task.errorText || `[${task.status}] no response recorded`,
          });
        }
        this.emit({ discussionId: id, eventType: "discussion_round_finished", source: "control-plane", payload: { discussionId: id, roundNo, taskIds } });
      }
      if (this.stoppedDiscussions.has(id)) return;
      const completedDiscussion = this.store.getDiscussion(id);
      const completedStatus = completedDiscussion.tasks.some((task) => task.status !== "succeeded") ? "completed_with_errors" : "succeeded";
      const completed = this.store.updateDiscussion(id, { status: completedStatus, finishedAt: nowIso() });
      this.emit({ discussionId: id, eventType: "discussion_finished", source: "control-plane", payload: { discussionId: id, status: completed.status } });
    } catch (error) {
      if (this.stoppedDiscussions.has(id)) return;
      const failed = this.store.updateDiscussion(id, { status: "failed", finishedAt: nowIso(), errorText: error.message });
      this.emit({ discussionId: id, eventType: "discussion_finished", source: "control-plane", payload: { discussionId: id, status: failed.status, error: error.message } });
    } finally {
      try {
        this.ensureFinalMinutes(id);
      } catch (error) {
        this.emit({ discussionId: id, eventType: "minutes_error", source: "control-plane", payload: { discussionId: id, error: error.message } });
      }
    }
  }

  ensureFinalMinutes(id) {
    const discussion = this.getDiscussion(id);
    if (["queued", "running"].includes(discussion.status)) return null;
    const latest = this.store.getLatestMinutesForDiscussion(id);
    const payload = latest?.payload || {};
    if (
      latest &&
      payload.status === discussion.status &&
      Number(payload.messageCount) === discussion.messages.length &&
      Array.isArray(payload.taskIds) &&
      payload.taskIds.length === discussion.tasks.length
    ) return latest;
    return this.generateMinutes(id);
  }

  waitForTask(id, timeoutMs) {
    const existing = this.getTask(id);
    if (taskIsTerminal(existing)) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = (task) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        resolve(task);
      };
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out waiting for task: ${id}`));
      }, Math.max(timeoutMs || this.config.defaultTimeoutMs, 1000));
      unsubscribe = this.hub.subscribe((event) => {
        if (event.taskId !== id || event.eventType !== "task_finished") return;
        finish(this.getTask(id));
      });
      const latest = this.getTask(id);
      if (taskIsTerminal(latest)) finish(latest);
    });
  }

  waitTask(id, timeoutMs, afterCursor) {
    const initial = this.getTask(id);
    const baselineCursor = cursorValue(afterCursor, initial.eventCursor);
    const waitMs = clamp(timeoutMs, 1000, this.config.maxWaitMs, 20000);
    const snapshot = (timedOut) => {
      const task = this.getTask(id);
      const page = this.listTaskEventPage(id, baselineCursor, 500);
      return {
        task,
        events: page.events,
        afterCursor: page.afterCursor,
        nextCursor: page.nextCursor,
        eventCursor: task.eventCursor,
        hasMore: page.hasMore,
        timedOut,
        waitMs,
      };
    };
    if (taskIsTerminal(initial)) return Promise.resolve(snapshot(false));
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      const finish = (timedOut) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(snapshot(timedOut));
      };
      const timer = setTimeout(() => finish(true), waitMs);
      unsubscribe = this.hub.subscribe((event) => {
        if (event.taskId !== id || event.id <= baselineCursor) return;
        finish(false);
      });
      const latest = this.getTask(id);
      const page = this.listTaskEventPage(id, baselineCursor, 500);
      if (taskIsTerminal(latest) || page.events.length) finish(false);
    });
  }

  getDiscussion(id) {
    const discussion = this.store.getDiscussion(id);
    if (!discussion) throw statusError(404, `discussion not found: ${id}`);
    return discussion;
  }

  listDiscussions(limit) {
    return this.store.listDiscussions(limit);
  }

  listDiscussionEvents(id, after) {
    this.getDiscussion(id);
    return this.store.listEvents({ discussionId: id, after });
  }

  listDiscussionEventPage(id, afterCursor, limit) {
    const discussion = this.getDiscussion(id);
    return {
      ...this.store.listEventsPage({ discussionId: id, after: cursorValue(afterCursor), limit }),
      eventCursor: discussion.eventCursor,
    };
  }

  async stopDiscussion(id) {
    const discussion = this.getDiscussion(id);
    this.stoppedDiscussions.add(id);
    for (const task of discussion.tasks.filter((item) => !taskIsTerminal(item))) {
      try {
        await this.stopTask(task.id);
      } catch {
        // Continue stopping the remaining tasks.
      }
    }
    const stopped = this.store.updateDiscussion(id, { status: "stopped", finishedAt: nowIso(), errorText: "Stopped by user" });
    this.emit({ discussionId: id, eventType: "discussion_finished", source: "control-plane", payload: { discussionId: id, status: "stopped" } });
    const running = this.discussionPromises.get(id);
    if (running) await Promise.allSettled([running]);
    this.ensureFinalMinutes(id);
    return this.getDiscussion(stopped.id);
  }

  generateMinutes(id) {
    const discussion = this.getDiscussion(id);
    const lines = [
      "# Agent Control Center discussion minutes",
      "",
      `- Discussion ID: ${discussion.id}`,
      `- Status: ${discussion.status}`,
      `- Created: ${discussion.createdAt}`,
      `- Finished: ${discussion.finishedAt || "in progress"}`,
      `- Working directory: ${discussion.cwd}`,
      `- Participants: ${discussion.agents.join(", ")}`,
      "",
      "## Objective",
      "",
      discussion.prompt,
      "",
      "## Discussion record",
      "",
    ];
    const roundNumbers = [...new Set(discussion.messages.map((message) => message.roundNo))].sort((a, b) => a - b);
    for (const roundNo of roundNumbers) {
      lines.push(`### Round ${roundNo}`, "");
      for (const message of discussion.messages.filter((item) => item.roundNo === roundNo)) {
        const task = discussion.tasks.find((item) => item.id === message.taskId);
        lines.push(`#### ${message.agent}`, "", `Task: ${message.taskId || "n/a"}`, `Provider status: ${task?.status || "unknown"}`, "", message.text || "[empty response]", "");
      }
    }
    lines.push(
      "## Decision record",
      "",
      "This section is an assembled record. It does not claim consensus unless the responses explicitly agree.",
      "",
      ...this.extractLabeledLines(discussion.messages, "Recommendation"),
      "",
      "## Risks and unresolved points",
      "",
      ...this.extractLabeledLines(discussion.messages, "Risks"),
      "",
      "## Proposed next steps",
      "",
      ...this.extractLabeledLines(discussion.messages, "Next steps"),
      "",
      "## Traceability",
      "",
      ...discussion.tasks.map((task) => `- ${task.id}: ${task.agent}, ${task.status}, provider session ${task.providerSessionId || "none"}`),
      "",
    );
    const payload = {
      discussionId: discussion.id,
      status: discussion.status,
      agents: discussion.agents,
      rounds: discussion.rounds,
      taskIds: discussion.tasks.map((task) => task.id),
      messageCount: discussion.messages.length,
      generatedAt: nowIso(),
    };
    const minutes = this.store.saveMinutes({ discussionId: id, markdown: lines.join("\n"), payload });
    this.emit({ discussionId: id, eventType: "minutes_generated", source: "control-plane", payload: { minutesId: minutes.id, filePath: minutes.filePath } });
    return minutes;
  }

  extractLabeledLines(messages, label) {
    const output = [];
    const matcher = new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, "im");
    for (const message of messages) {
      const match = message.text.match(matcher);
      if (match) output.push(`- ${message.agent}: ${match[1].trim()}`);
    }
    return output.length ? output : ["- No explicitly labeled entries were returned."];
  }

  getMinutes(id) {
    const minutes = this.store.getMinutes(id);
    if (!minutes) throw statusError(404, `minutes not found: ${id}`);
    return minutes;
  }

  latestMinutes(discussionId) {
    this.getDiscussion(discussionId);
    return this.store.getLatestMinutesForDiscussion(discussionId);
  }

  async shutdown() {
    for (const discussion of this.store.listDiscussions(100)) {
      if (taskIsTerminal({ status: discussion.status })) continue;
      this.stoppedDiscussions.add(discussion.id);
      const interrupted = this.store.updateDiscussion(discussion.id, {
        status: "interrupted",
        finishedAt: nowIso(),
        errorText: "Control service is shutting down",
      });
      this.emit({ discussionId: discussion.id, eventType: "discussion_finished", source: "control-plane", payload: { discussionId: discussion.id, status: interrupted.status } });
    }
    for (const taskId of [...this.queue]) {
      this.queue.splice(this.queue.indexOf(taskId), 1);
      const task = this.store.getTask(taskId);
      if (!task || taskIsTerminal(task)) continue;
      const interrupted = this.store.updateTask(taskId, { status: "interrupted", finishedAt: nowIso(), errorText: "Control service is shutting down" });
      this.emit({ taskId, eventType: "task_finished", source: "control-plane", payload: { taskId, status: interrupted.status } });
    }
    const active = [...this.runtime.entries()];
    await Promise.all(active.map(async ([id, runtime]) => {
      runtime.stopRequested = true;
      try {
        await runtime.handle?.stop?.();
      } catch {
        // Best effort during shutdown.
      }
      this.emit({ taskId: id, eventType: "service_shutdown", source: "control-plane", payload: { taskId: id } });
    }));
    await Promise.allSettled([...this.runningPromises.values()]);
    await Promise.allSettled([...this.discussionPromises.values()]);
    this.store.close();
  }
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  const status = Number(error.statusCode) || 400;
  jsonResponse(response, status, { error: error.message || String(error) });
}

async function readJsonBody(request, maxBytes = 2_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw statusError(413, "request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw statusError(400, "request body must be valid JSON");
  }
}

function requestMetadata(request) {
  return {
    origin: request.headers["x-agent-control-origin"],
    originRequestId: request.headers["x-agent-control-request-id"],
    idempotencyKey: request.headers["idempotency-key"],
  };
}

function eventMatches(event, scope, id) {
  return scope === "task" ? event.taskId === id : event.discussionId === id;
}

function writeSse(response, event) {
  response.write(`id: ${event.id}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
}

function streamEvents(request, response, plane, scope, id, after) {
  const initial = scope === "task" ? plane.listTaskEvents(id, after) : plane.listDiscussionEvents(id, after);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  response.write("retry: 2000\n\n");
  for (const event of initial) writeSse(response, event);
  const unsubscribe = plane.hub.subscribe((event) => {
    if (eventMatches(event, scope, id)) writeSse(response, event);
  });
  const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15000);
  request.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

function isLoopbackAddress(address) {
  const value = String(address || "").replace(/^::ffff:/, "");
  return value === "127.0.0.1" || value === "::1";
}

function staticResponse(response, path, plane, request) {
  const file = resolve(WEB_ROOT, path === "/" ? "index.html" : path.slice(1));
  if (file !== WEB_ROOT && !file.startsWith(`${WEB_ROOT}/`)) return jsonResponse(response, 404, { error: "not found" });
  try {
    const content = readFileSync(file);
    const type = extname(file) === ".html" ? "text/html; charset=utf-8" : extname(file) === ".css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
    const headers = {
      "content-type": type,
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    };
    if (path === "/" && isLoopbackAddress(request.socket.remoteAddress)) headers["set-cookie"] = `acc_token=${encodeURIComponent(plane.authToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
    response.writeHead(200, headers);
    response.end(content);
  } catch {
    jsonResponse(response, 404, { error: "not found" });
  }
}

export function createRequestHandler(plane) {
  return async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`}`);
      const path = url.pathname;
      const origin = request.headers.origin;
      if (origin) {
        const expectedOrigin = `http://${request.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`}`;
        if (origin !== expectedOrigin) return jsonResponse(response, 403, { error: "cross-origin request rejected" });
        response.setHeader("access-control-allow-origin", origin);
        response.setHeader("access-control-allow-credentials", "true");
        response.setHeader("vary", "Origin");
      }
      if (!path.startsWith("/api/")) {
        if (request.method !== "GET") return jsonResponse(response, 405, { error: "method not allowed" });
        return staticResponse(response, path, plane, request);
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, { "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type,idempotency-key,x-agent-control-origin,x-agent-control-request-id" });
        return response.end();
      }
      if (request.method === "GET" && path === "/api/healthz") return jsonResponse(response, 200, { status: "ok", service: "agent-control-center", version: SERVICE_VERSION, pid: process.pid });
      const authorization = request.headers.authorization || "";
      const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      const cookieToken = String(request.headers.cookie || "").split(";").map((value) => value.trim()).find((value) => value.startsWith("acc_token="))?.slice("acc_token=".length) || "";
      let decodedCookieToken = "";
      try { decodedCookieToken = decodeURIComponent(cookieToken); } catch { /* Treat malformed cookies as unauthenticated. */ }
      if (bearer !== plane.authToken && decodedCookieToken !== plane.authToken) return jsonResponse(response, 401, { error: "authentication required" });
      if (request.method === "GET" && path === "/api/agents") return jsonResponse(response, 200, { agents: await plane.agentHealth() });
      if (request.method === "GET" && path === "/api/tasks") return jsonResponse(response, 200, { tasks: plane.listTasks(url.searchParams.get("limit")) });
      if (request.method === "POST" && path === "/api/tasks") {
        const outcome = plane.createTaskRequest({ ...requestMetadata(request), ...(await readJsonBody(request)) });
        return jsonResponse(response, 202, outcome);
      }
      if (request.method === "GET" && path === "/api/discussions") return jsonResponse(response, 200, { discussions: plane.listDiscussions(url.searchParams.get("limit")) });
      if (request.method === "POST" && path === "/api/discussions") return jsonResponse(response, 202, { discussion: plane.createDiscussion(await readJsonBody(request)) });

      const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(?:\/(events|wait|stream|stop|reply))?$/);
      if (taskMatch) {
        const id = decodeURIComponent(taskMatch[1]);
        const action = taskMatch[2];
        if (request.method === "GET" && !action) return jsonResponse(response, 200, { task: plane.getTask(id) });
        if (request.method === "GET" && action === "events") {
          const afterCursor = url.searchParams.has("afterCursor") ? url.searchParams.get("afterCursor") : url.searchParams.get("after");
          return jsonResponse(response, 200, plane.listTaskEventPage(id, afterCursor, url.searchParams.get("limit")));
        }
        if (request.method === "GET" && action === "wait") {
          const afterCursor = url.searchParams.has("afterCursor") ? url.searchParams.get("afterCursor") : undefined;
          const timeoutMs = url.searchParams.has("timeoutMs") ? url.searchParams.get("timeoutMs") : url.searchParams.get("timeout");
          return jsonResponse(response, 200, await plane.waitTask(id, timeoutMs, afterCursor));
        }
        if (request.method === "GET" && action === "stream") {
          const afterCursor = url.searchParams.has("afterCursor") ? url.searchParams.get("afterCursor") : url.searchParams.get("after");
          return streamEvents(request, response, plane, "task", id, afterCursor);
        }
        if (request.method === "POST" && action === "stop") return jsonResponse(response, 200, { task: await plane.stopTask(id) });
        if (request.method === "POST" && action === "reply") {
          const body = { ...requestMetadata(request), ...(await readJsonBody(request)) };
          return jsonResponse(response, 202, { task: await plane.replyTask(id, body.prompt, body) });
        }
      }

      const discussionMatch = path.match(/^\/api\/discussions\/([^/]+)(?:\/(events|stream|stop|minutes))?$/);
      if (discussionMatch) {
        const id = decodeURIComponent(discussionMatch[1]);
        const action = discussionMatch[2];
        if (request.method === "GET" && !action) return jsonResponse(response, 200, { discussion: plane.getDiscussion(id) });
        if (request.method === "GET" && action === "events") {
          const afterCursor = url.searchParams.has("afterCursor") ? url.searchParams.get("afterCursor") : url.searchParams.get("after");
          return jsonResponse(response, 200, plane.listDiscussionEventPage(id, afterCursor, url.searchParams.get("limit")));
        }
        if (request.method === "GET" && action === "stream") {
          const afterCursor = url.searchParams.has("afterCursor") ? url.searchParams.get("afterCursor") : url.searchParams.get("after");
          return streamEvents(request, response, plane, "discussion", id, afterCursor);
        }
        if (request.method === "POST" && action === "stop") return jsonResponse(response, 200, { discussion: await plane.stopDiscussion(id) });
        if (request.method === "GET" && action === "minutes") return jsonResponse(response, 200, { minutes: plane.latestMinutes(id) });
        if (request.method === "POST" && action === "minutes") return jsonResponse(response, 201, { minutes: plane.generateMinutes(id) });
      }

      const minutesMatch = path.match(/^\/api\/minutes\/([^/]+)$/);
      if (minutesMatch && request.method === "GET") return jsonResponse(response, 200, { minutes: plane.getMinutes(decodeURIComponent(minutesMatch[1])) });
      return jsonResponse(response, 404, { error: "not found" });
    } catch (error) {
      return sendError(response, error);
    }
  };
}

export async function startControlServer({ host, port, dataDir, config } = {}) {
  const plane = new ControlPlane({ dataDir, config });
  const server = createServer(createRequestHandler(plane));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port ?? plane.config.port ?? DEFAULT_PORT, host ?? plane.config.host ?? DEFAULT_HOST, resolve);
  });
  const address = server.address();
  return {
    plane,
    server,
    host: typeof address === "object" && address ? address.address : host || DEFAULT_HOST,
    port: typeof address === "object" && address ? address.port : port || DEFAULT_PORT,
    async close() {
      await plane.shutdown();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const running = await startControlServer();
  console.error(`Agent Control Center listening at http://${running.host}:${running.port}`);
  const close = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
