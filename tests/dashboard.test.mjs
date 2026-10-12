import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const clone = (value) => JSON.parse(JSON.stringify(value));

class Surface {
  constructor() {
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.open = false;
    this.listeners = new Map();
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  async emit(type, event = {}) {
    await Promise.all((this.listeners.get(type) || []).map((callback) => callback({ currentTarget: this, ...event })));
  }
  showModal() { this.open = true; }
  close() { this.open = false; void this.emit("close"); }
  focus() {}
  scrollIntoView() {}
}

async function dashboard(count = 65) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new Surface());
    return elements.get(selector);
  };
  const doc = new Surface();
  doc.querySelector = element;
  doc.querySelectorAll = () => [];
  doc.hidden = false;
  const win = new Surface();
  const timers = new Map();
  const intervals = [];
  const streams = [];
  const calls = [];
  let timerId = 0;
  const tasks = Array.from({ length: count }, (_, i) => ({
    id: `task_fixture_${i}`, agent: "claude-code", prompt: `fixture task ${i}`, cwd: "/fixture/workspace",
    status: "running", createdAt: new Date(Date.UTC(2026, 0, 1) - i * 1000).toISOString(),
    timeoutMs: 3_600_000, metadata: {}, permissionPolicy: {}, resultPreview: "", resultPreviewKind: "none",
  }));
  const events = new Map(tasks.map((task) => [task.id, [{ id: 1, eventType: "task_started", payload: {}, createdAt: task.createdAt }]]));
  const controls = { blockNextPage: null };
  class Stream extends Surface {
    constructor(url) { super(); this.url = url; streams.push(this); }
  }
  const fetchImpl = async (path, options = {}) => {
    calls.push({ path, options });
    const url = new URL(path, "http://dashboard.fixture");
    let payload;
    if (url.pathname === "/api/agents") {
      payload = { agents: [{ agent: "claude-code", label: "Fixture Agent", available: true, kind: "cli", capabilities: { resume: "supported" }, recentExecution: { taskId: tasks[0].id, status: tasks[0].status } }], taskOptions: { defaultTimeoutMs: 3_600_000, maxTimeoutMs: 86_400_000 } };
    } else if (url.pathname === "/api/task-summaries") {
      let rows = tasks.filter((task) => (!url.searchParams.get("status") || task.status === url.searchParams.get("status")) && (!url.searchParams.get("query") || task.prompt.includes(url.searchParams.get("query"))));
      const total = rows.length;
      const anchor = tasks.find((task) => task.id === url.searchParams.get("cursor"));
      if (anchor) rows = rows.filter((task) => task.createdAt < anchor.createdAt);
      const limit = Number(url.searchParams.get("limit"));
      const page = rows.slice(0, limit);
      payload = clone({ tasks: page, total, hasMore: rows.length > limit, nextCursor: rows.length > limit ? page.at(-1).id : null, statusCounts: tasks.reduce((counts, task) => ({ ...counts, [task.status]: (counts[task.status] || 0) + 1 }), {}) });
      if (controls.blockNextPage) {
        const block = controls.blockNextPage;
        controls.blockNextPage = null;
        await block;
      }
    } else if (url.pathname === "/api/discussions") payload = { discussions: [] };
    else if (url.pathname === "/api/policy-preview") payload = { cwd: "/fixture/workspace", permissionPolicy: {} };
    else if (url.pathname === "/api/tasks" && options.method === "POST") payload = { task: { id: "task_created_fixture" } };
    else {
      const match = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(events|reply))?$/);
      if (!match) throw new Error(`unexpected fixture request: ${path}`);
      const task = tasks.find((item) => item.id === match[1]);
      if (match[2] === "events") {
        const after = Number(url.searchParams.get("afterCursor"));
        const tail = events.get(task.id).filter((event) => event.id > after);
        payload = { events: tail, nextCursor: tail.at(-1)?.id || after, eventCursor: events.get(task.id).at(-1).id, hasMore: false };
      } else if (match[2] === "reply") payload = { task };
      else payload = { task };
    }
    const snapshot = clone(payload);
    return { ok: true, json: async () => snapshot };
  };
  const context = createContext({
    document: doc, window: win, EventSource: Stream, fetch: fetchImpl, URLSearchParams,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) { intervals.push({ callback, delay }); },
  });
  runInContext(source, context);
  const evaluate = (code) => runInContext(code, context);
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const flushActivity = async () => {
    for (const [id, timer] of [...timers]) if (timer.delay === 150) { timers.delete(id); timer.callback(); }
    await settle();
    await evaluate("state.refreshPromise");
  };
  await settle();
  return { element, doc, win, streams, calls, tasks, events, controls, evaluate, settle, flushActivity, intervals };
}

test("Dashboard refresh replaces all loaded pages and drops tasks no longer matching the status filter", async () => {
  const ui = await dashboard(145);
  for (let i = 0; i < 4; i++) await ui.element("#task-load-more").emit("click");
  assert.equal(ui.evaluate("state.tasks.length"), 145);
  ui.tasks[120].status = "succeeded";
  ui.tasks[120].resultPreview = "fresh completed result";
  await ui.evaluate("refresh()");
  assert.equal(ui.evaluate("state.tasks.find(task => task.id === 'task_fixture_120').status"), "succeeded");
  assert.match(ui.element("#task-list").innerHTML, /fresh completed result/);
  ui.element("#task-status-filter").value = "running";
  await ui.element("#task-status-filter").emit("change");
  await ui.evaluate("state.refreshPromise");
  ui.tasks[0].status = "succeeded";
  await ui.evaluate("refresh()");
  assert.equal(ui.evaluate("state.tasks.some(task => task.id === 'task_fixture_0')"), false);
  assert.equal(ui.element("#task-count").textContent, "30 / 143 条匹配");
});

test("completion activity refreshes the open detail, provider card, counts and incremental timeline", async () => {
  const ui = await dashboard(1);
  assert.equal(ui.streams[0].url, "/api/activity/stream");
  await ui.evaluate("showTaskDetails('task_fixture_0')");
  assert.match(ui.element("#detail-content").innerHTML, /进行中/);
  ui.tasks[0].status = "succeeded";
  ui.tasks[0].metadata = { providerFinalAnswer: { eventType: "result", text: "fresh final answer" }, mechanicalOutcome: { outcome: "succeeded" } };
  ui.events.get(ui.tasks[0].id).push({ id: 2, eventType: "task_finished", createdAt: ui.tasks[0].createdAt, payload: { status: "succeeded" } });
  await ui.streams[0].emit("activity");
  await ui.flushActivity();
  assert.match(ui.element("#detail-content").innerHTML, /fresh final answer/);
  assert.match(ui.element("#detail-content").innerHTML, /task_finished/);
  assert.match(ui.element("#provider-grid").innerHTML, /最近任务：已完成/);
  assert.equal(ui.element("#running-count").textContent, "0");
  assert.ok(ui.calls.some((call) => call.path.includes("events?afterCursor=1")), "live details fetch only the new event tail");
  ui.element("#detail-dialog").close();
  await ui.evaluate("refresh()");
  assert.equal(ui.element("#detail-dialog").open, false, "refresh must not reopen a dismissed dialog");
});

test("activity arriving during an in-flight refresh queues a fresh snapshot instead of losing the update", async () => {
  const ui = await dashboard(1);
  let release;
  ui.controls.blockNextPage = new Promise((resolve) => { release = resolve; });
  const first = ui.evaluate("refresh()");
  ui.tasks[0].status = "succeeded";
  const invalidated = ui.evaluate("refresh({invalidate:true})");
  assert.equal(ui.evaluate("state.refreshAgain"), true);
  release();
  await Promise.all([first, invalidated]);
  assert.equal(ui.evaluate("state.tasks[0].status"), "succeeded");
});

test("reconnect, visibility, online and polling reconcile snapshots and task forms send explicit budgets", async () => {
  const ui = await dashboard(1);
  await ui.streams[0].emit("error");
  await ui.flushActivity();
  assert.match(ui.element("#service-state").textContent, /轮询更新/);
  ui.tasks[0].status = "succeeded";
  await ui.streams[0].emit("open");
  await ui.flushActivity();
  assert.match(ui.element("#service-state").textContent, /实时更新/);
  assert.equal(ui.evaluate("state.tasks[0].status"), "succeeded");
  const before = ui.calls.length;
  await ui.doc.emit("visibilitychange");
  await ui.win.emit("online");
  await ui.flushActivity();
  assert.ok(ui.calls.length > before);
  assert.ok(ui.intervals.some((interval) => interval.delay === 4000));
  ui.element("#task-timeout").value = "120";
  ui.element("#task-prompt").value = "bounded fixture task";
  await ui.element("#task-form").emit("submit", { preventDefault() {}, submitter: new Surface() });
  const created = ui.calls.find((call) => call.path === "/api/tasks" && call.options.method === "POST");
  assert.equal(JSON.parse(created.options.body).timeoutMs, 7_200_000);
  assert.equal(ui.element("#task-timeout").value, "120", "background updates must preserve a chosen budget");
  await ui.evaluate("openReply('task_fixture_0')");
  ui.element("#reply-timeout").value = "240";
  ui.element("#reply-prompt").value = "next attempt fixture";
  await ui.element("#reply-form").emit("submit", { preventDefault() {}, submitter: new Surface() });
  const reply = ui.calls.find((call) => call.path.endsWith("/reply"));
  assert.equal(JSON.parse(reply.options.body).timeoutMs, 14_400_000);
});
