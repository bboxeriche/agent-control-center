import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ensureDir,
  makeId,
  nowIso,
  redactSecrets,
  safeJson,
  truncate,
} from "./core.mjs";

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function mapTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    parentTaskId: row.parent_task_id,
    discussionId: row.discussion_id,
    roundNo: row.round_no,
    agent: row.agent,
    prompt: row.prompt,
    cwd: row.cwd,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    signal: row.signal,
    providerSessionId: row.provider_session_id,
    providerJobId: row.provider_job_id,
    resultText: row.result_text,
    errorText: row.error_text,
    model: row.model,
    timeoutMs: row.timeout_ms,
    attemptNo: row.attempt_no ?? 1,
    origin: row.origin || "local_cli",
    originRequestId: row.origin_request_id,
    idempotencyKey: row.idempotency_key,
    idempotencyFingerprint: row.idempotency_fingerprint,
    permissionPolicy: parseJson(row.permission_policy_json, {}),
    capabilities: parseJson(row.capability_snapshot_json, {}),
    eventCursor: Number(row.event_cursor || 0),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function mapDiscussion(row) {
  if (!row) return null;
  return {
    id: row.id,
    prompt: row.prompt,
    cwd: row.cwd,
    origin: row.origin || "local_cli",
    originRequestId: row.origin_request_id,
    agents: parseJson(row.agents_json, []),
    rounds: row.rounds,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorText: row.error_text,
    eventCursor: Number(row.event_cursor || 0),
  };
}

export class Store {
  constructor(dataDir) {
    this.dataDir = ensureDir(dataDir);
    this.minutesDir = ensureDir(join(dataDir, "minutes"));
    this.dbPath = join(dataDir, "control.sqlite");
    this.eventsPath = join(dataDir, "events.jsonl");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_task_id TEXT,
        discussion_id TEXT,
        round_no INTEGER,
        agent TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        signal TEXT,
        provider_session_id TEXT,
        provider_job_id TEXT,
        result_text TEXT,
        error_text TEXT,
      model TEXT,
      timeout_ms INTEGER NOT NULL,
      attempt_no INTEGER NOT NULL DEFAULT 1,
      origin TEXT NOT NULL DEFAULT 'local_cli',
      origin_request_id TEXT,
        idempotency_key TEXT,
        idempotency_fingerprint TEXT,
      permission_policy_json TEXT NOT NULL DEFAULT '{}',
      capability_snapshot_json TEXT NOT NULL DEFAULT '{}',
      event_cursor INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
      CREATE INDEX IF NOT EXISTS tasks_discussion_idx ON tasks(discussion_id);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT,
        discussion_id TEXT,
        created_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        source TEXT NOT NULL,
        stream TEXT,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_task_idx ON events(task_id, id);
      CREATE INDEX IF NOT EXISTS events_discussion_idx ON events(discussion_id, id);
      CREATE TABLE IF NOT EXISTS discussions (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        cwd TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'local_cli',
        origin_request_id TEXT,
        agents_json TEXT NOT NULL,
        rounds INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error_text TEXT
        ,event_cursor INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS discussion_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        discussion_id TEXT NOT NULL,
        task_id TEXT,
        agent TEXT NOT NULL,
        round_no INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS discussion_messages_idx ON discussion_messages(discussion_id, round_no, id);
      CREATE TABLE IF NOT EXISTS minutes (
        id TEXT PRIMARY KEY,
        discussion_id TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        markdown TEXT NOT NULL,
        json_payload TEXT NOT NULL
      );
    `);
    this.ensureTaskColumns();
    this.ensureDiscussionColumns();
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_idempotency_key_idx ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;");
    this.db.exec("UPDATE tasks SET event_cursor = COALESCE((SELECT MAX(id) FROM events WHERE events.task_id = tasks.id), 0) WHERE event_cursor IS NULL OR event_cursor = 0;");
    this.db.exec("UPDATE discussions SET event_cursor = COALESCE((SELECT MAX(e.id) FROM events e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.discussion_id = discussions.id OR t.discussion_id = discussions.id), 0) WHERE event_cursor IS NULL OR event_cursor = 0;");
  }

  ensureTaskColumns() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name));
    const additions = {
      attempt_no: "INTEGER NOT NULL DEFAULT 1",
      origin: "TEXT NOT NULL DEFAULT 'local_cli'",
      origin_request_id: "TEXT",
      idempotency_key: "TEXT",
      idempotency_fingerprint: "TEXT",
      permission_policy_json: "TEXT NOT NULL DEFAULT '{}'",
      capability_snapshot_json: "TEXT NOT NULL DEFAULT '{}'",
      event_cursor: "INTEGER NOT NULL DEFAULT 0",
    };
    for (const [column, definition] of Object.entries(additions)) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
    }
  }

  ensureDiscussionColumns() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(discussions)").all().map((row) => row.name));
    const additions = {
      origin: "TEXT NOT NULL DEFAULT 'local_cli'",
      origin_request_id: "TEXT",
      event_cursor: "INTEGER NOT NULL DEFAULT 0",
    };
    for (const [column, definition] of Object.entries(additions)) {
      if (!columns.has(column)) this.db.exec(`ALTER TABLE discussions ADD COLUMN ${column} ${definition}`);
    }
  }

  recoverActiveTasks() {
    const now = nowIso();
    this.db.prepare(
      "UPDATE tasks SET status = 'interrupted', finished_at = ?, error_text = ? WHERE status IN ('queued', 'running')",
    ).run(now, "Control service restarted while the task was active");
    this.db.prepare(
      "UPDATE discussions SET status = 'interrupted', finished_at = ?, error_text = ? WHERE status IN ('queued', 'running')",
    ).run(now, "Control service restarted while the discussion was active");
  }

  createTask(input) {
    const task = {
      id: input.id || makeId("task"),
      parentTaskId: input.parentTaskId || null,
      discussionId: input.discussionId || null,
      roundNo: input.roundNo ?? null,
      agent: input.agent,
      prompt: redactSecrets(input.prompt),
      cwd: input.cwd,
      status: input.status || "queued",
      createdAt: input.createdAt || nowIso(),
      timeoutMs: input.timeoutMs,
      attemptNo: input.attemptNo ?? 1,
      origin: input.origin || "local_cli",
      originRequestId: input.originRequestId || null,
      idempotencyKey: input.idempotencyKey || null,
      idempotencyFingerprint: input.idempotencyFingerprint || null,
      permissionPolicy: input.permissionPolicy || {},
      capabilities: input.capabilities || {},
      model: input.model || null,
      providerSessionId: input.providerSessionId || null,
      metadata: input.metadata || {},
    };
    this.db.prepare(`
      INSERT INTO tasks
        (id, parent_task_id, discussion_id, round_no, agent, prompt, cwd, status, created_at, timeout_ms, model, provider_session_id, attempt_no, origin, origin_request_id, idempotency_key, idempotency_fingerprint, permission_policy_json, capability_snapshot_json, event_cursor, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.parentTaskId,
      task.discussionId,
      task.roundNo,
      task.agent,
      task.prompt,
      task.cwd,
      task.status,
      task.createdAt,
      task.timeoutMs,
      task.model,
      task.providerSessionId,
      task.attemptNo,
      task.origin,
      task.originRequestId,
      task.idempotencyKey,
      task.idempotencyFingerprint,
      safeJson(task.permissionPolicy),
      safeJson(task.capabilities),
      0,
      safeJson(task.metadata),
    );
    return this.getTask(task.id);
  }

  updateTask(id, patch) {
    const fields = {
      status: "status",
      startedAt: "started_at",
      finishedAt: "finished_at",
      exitCode: "exit_code",
      signal: "signal",
      providerSessionId: "provider_session_id",
      providerJobId: "provider_job_id",
      resultText: "result_text",
      errorText: "error_text",
      prompt: "prompt",
      attemptNo: "attempt_no",
      metadata: "metadata_json",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(fields)) {
      if (!(key in patch)) continue;
      assignments.push(`${column} = ?`);
      if (patch[key] === null || patch[key] === undefined) values.push(null);
      else if (key === "metadata") values.push(safeJson(patch[key]));
      else if (typeof patch[key] === "string") values.push(redactSecrets(patch[key]));
      else values.push(patch[key]);
    }
    if (assignments.length) {
      values.push(id);
      this.db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.getTask(id);
  }

  getTask(id) {
    return mapTask(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id));
  }

  getTaskByIdempotencyKey(idempotencyKey) {
    if (!idempotencyKey) return null;
    return mapTask(this.db.prepare("SELECT * FROM tasks WHERE idempotency_key = ?").get(idempotencyKey));
  }

  listTasks(limit = 50) {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(Math.min(Math.max(Number(limit) || 50, 1), 200));
    return rows.map(mapTask);
  }

  addEvent(input) {
    const task = input.taskId ? this.getTask(input.taskId) : null;
    const event = {
      taskId: input.taskId || null,
      discussionId: input.discussionId || task?.discussionId || null,
      createdAt: input.createdAt || nowIso(),
      eventType: input.eventType || "message",
      source: input.source || "control-plane",
      stream: input.stream || null,
      payload: input.payload ?? {},
    };
    const payloadJson = safeJson(event.payload);
    const result = this.db.prepare(`
      INSERT INTO events (task_id, discussion_id, created_at, event_type, source, stream, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(event.taskId, event.discussionId, event.createdAt, event.eventType, event.source, event.stream, payloadJson);
    const id = Number(result.lastInsertRowid);
    if (event.taskId) {
      this.db.prepare("UPDATE tasks SET event_cursor = CASE WHEN event_cursor < ? THEN ? ELSE event_cursor END WHERE id = ?").run(id, id, event.taskId);
    }
    if (event.discussionId) {
      this.db.prepare("UPDATE discussions SET event_cursor = CASE WHEN event_cursor < ? THEN ? ELSE event_cursor END WHERE id = ?").run(id, id, event.discussionId);
    }
    const record = { id, ...event, payload: parseJson(payloadJson, {}) };
    appendFileSync(this.eventsPath, `${JSON.stringify(record)}\n`);
    return record;
  }

  listEvents({ taskId, discussionId, after = 0, limit = 500 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const safeAfter = Math.max(Number(after) || 0, 0);
    let rows;
    if (taskId) {
      rows = this.db.prepare("SELECT * FROM events WHERE task_id = ? AND id > ? ORDER BY id ASC LIMIT ?").all(taskId, safeAfter, safeLimit);
    } else if (discussionId) {
      rows = this.db.prepare("SELECT e.* FROM events e LEFT JOIN tasks t ON t.id = e.task_id WHERE (e.discussion_id = ? OR t.discussion_id = ?) AND e.id > ? ORDER BY e.id ASC LIMIT ?").all(discussionId, discussionId, safeAfter, safeLimit);
    } else {
      rows = this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?").all(safeAfter, safeLimit);
    }
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      discussionId: row.discussion_id,
      createdAt: row.created_at,
      eventType: row.event_type,
      source: row.source,
      stream: row.stream,
      payload: parseJson(row.payload_json, {}),
    }));
  }

  listEventsPage({ taskId, discussionId, after = 0, limit = 500 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const safeAfter = Math.max(Number(after) || 0, 0);
    const events = this.listEvents({ taskId, discussionId, after: safeAfter, limit: safeLimit });
    const nextCursor = events.length ? events[events.length - 1].id : safeAfter;
    let hasMore = false;
    if (taskId) {
      hasMore = Boolean(this.db.prepare("SELECT 1 FROM events WHERE task_id = ? AND id > ? LIMIT 1").get(taskId, nextCursor));
    } else if (discussionId) {
      hasMore = Boolean(this.db.prepare("SELECT 1 FROM events e LEFT JOIN tasks t ON t.id = e.task_id WHERE (e.discussion_id = ? OR t.discussion_id = ?) AND e.id > ? LIMIT 1").get(discussionId, discussionId, nextCursor));
    } else {
      hasMore = Boolean(this.db.prepare("SELECT 1 FROM events WHERE id > ? LIMIT 1").get(nextCursor));
    }
    return { events, afterCursor: safeAfter, nextCursor, hasMore };
  }

  createDiscussion(input) {
    const discussion = {
      id: input.id || makeId("discussion"),
      prompt: redactSecrets(input.prompt),
      cwd: input.cwd,
      origin: input.origin || "local_cli",
      originRequestId: input.originRequestId || null,
      agents: input.agents,
      rounds: input.rounds,
      status: input.status || "queued",
      createdAt: input.createdAt || nowIso(),
    };
    this.db.prepare(`
      INSERT INTO discussions (id, prompt, cwd, origin, origin_request_id, agents_json, rounds, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(discussion.id, discussion.prompt, discussion.cwd, discussion.origin, discussion.originRequestId, safeJson(discussion.agents), discussion.rounds, discussion.status, discussion.createdAt);
    return this.getDiscussion(discussion.id);
  }

  updateDiscussion(id, patch) {
    const fields = {
      status: "status",
      startedAt: "started_at",
      finishedAt: "finished_at",
      errorText: "error_text",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(fields)) {
      if (!(key in patch)) continue;
      assignments.push(`${column} = ?`);
      values.push(patch[key] === null || patch[key] === undefined ? null : redactSecrets(patch[key]));
    }
    if (assignments.length) {
      values.push(id);
      this.db.prepare(`UPDATE discussions SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.getDiscussion(id);
  }

  getDiscussion(id) {
    const discussion = mapDiscussion(this.db.prepare("SELECT * FROM discussions WHERE id = ?").get(id));
    if (!discussion) return null;
    discussion.tasks = this.db.prepare("SELECT * FROM tasks WHERE discussion_id = ? ORDER BY round_no ASC, created_at ASC").all(id).map(mapTask);
    discussion.messages = this.db.prepare("SELECT * FROM discussion_messages WHERE discussion_id = ? ORDER BY round_no ASC, id ASC").all(id).map((row) => ({
      id: row.id,
      discussionId: row.discussion_id,
      taskId: row.task_id,
      agent: row.agent,
      roundNo: row.round_no,
      role: row.role,
      text: row.text,
      createdAt: row.created_at,
    }));
    const latest = this.db.prepare("SELECT * FROM minutes WHERE discussion_id = ? ORDER BY generated_at DESC LIMIT 1").get(id);
    discussion.latestMinutes = latest ? { id: latest.id, generatedAt: latest.generated_at } : null;
    return discussion;
  }

  listDiscussions(limit = 50) {
    return this.db.prepare("SELECT * FROM discussions ORDER BY created_at DESC LIMIT ?").all(Math.min(Math.max(Number(limit) || 50, 1), 100)).map((row) => {
      const discussion = mapDiscussion(row);
      const latest = this.db.prepare("SELECT id, generated_at FROM minutes WHERE discussion_id = ? ORDER BY generated_at DESC LIMIT 1").get(row.id);
      discussion.latestMinutes = latest ? { id: latest.id, generatedAt: latest.generated_at } : null;
      return discussion;
    });
  }

  addDiscussionMessage(input) {
    const text = truncate(redactSecrets(input.text), 40000);
    const createdAt = input.createdAt || nowIso();
    const result = this.db.prepare(`
      INSERT INTO discussion_messages (discussion_id, task_id, agent, round_no, role, text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.discussionId, input.taskId || null, input.agent, input.roundNo, input.role || "response", text, createdAt);
    return {
      id: Number(result.lastInsertRowid),
      discussionId: input.discussionId,
      taskId: input.taskId || null,
      agent: input.agent,
      roundNo: input.roundNo,
      role: input.role || "response",
      text,
      createdAt,
    };
  }

  saveMinutes({ discussionId, markdown, payload }) {
    const id = makeId("minutes");
    const generatedAt = nowIso();
    const cleanMarkdown = redactSecrets(markdown);
    const filePath = join(this.minutesDir, `${id}.md`);
    writeFileSync(filePath, cleanMarkdown, "utf8");
    this.db.prepare("INSERT INTO minutes (id, discussion_id, generated_at, markdown, json_payload) VALUES (?, ?, ?, ?, ?)").run(id, discussionId, generatedAt, cleanMarkdown, safeJson(payload || {}));
    return { id, discussionId, generatedAt, markdown: cleanMarkdown, payload: payload || {}, filePath };
  }

  getMinutes(id) {
    const row = this.db.prepare("SELECT * FROM minutes WHERE id = ?").get(id);
    if (!row) return null;
    return {
      id: row.id,
      discussionId: row.discussion_id,
      generatedAt: row.generated_at,
      markdown: row.markdown,
      payload: parseJson(row.json_payload, {}),
      filePath: join(this.minutesDir, `${row.id}.md`),
    };
  }

  getLatestMinutesForDiscussion(discussionId) {
    const row = this.db.prepare("SELECT * FROM minutes WHERE discussion_id = ? ORDER BY generated_at DESC LIMIT 1").get(discussionId);
    return row ? this.getMinutes(row.id) : null;
  }

  close() {
    this.db.close();
  }
}
