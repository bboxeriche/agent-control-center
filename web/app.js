const $ = (selector) => document.querySelector(selector);
const state = { agents: [], tasks: [], taskNextCursor: null, taskHasMore: false, taskFilters: "", taskRequestId: 0, previewRequest: 0, replyTaskId: null, toastTimer: null };
Object.assign(state, { refreshPromise: null, refreshAgain: false, loadingMore: false, activityConnected: false, detail: null, detailRequestId: 0, detailHistory: null });

const STATUS_LABELS = {
  queued: "排队中",
  running: "进行中",
  succeeded: "已完成",
  failed: "失败",
  stopped: "已停止",
  timed_out: "已超时",
  interrupted: "已中断",
  completed_with_errors: "部分失败",
};

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function labelFor(agent) {
  return agent.label || agent.agent;
}

function statusLabel(status) {
  return STATUS_LABELS[status] || status || "未知";
}

function formatTime(value) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function providerState(agent) {
  const error = String(agent.error || "");
  if (agent.available && agent.providerVersionValidation && agent.providerVersionValidation.status !== "version_match") {
    const observedVersion = agent.providerVersionValidation.observedProviderVersion;
    const validatedVersion = agent.providerVersionValidation.validatedProviderVersion;
    return {
      label: "版本待复验",
      tone: "configured",
      detail: observedVersion
        ? `已安装 ${observedVersion}，权限档案依据 ${validatedVersion}；尚未按此版本复验。`
        : `无法识别安装版本，权限档案依据 ${validatedVersion}；尚未按当前版本复验。`,
    };
  }
  if (agent.kind === "http" && [401, 403].includes(Number(agent.statusCode))) return { label: "API 认证失败", tone: "off", detail: `健康端点返回 HTTP ${agent.statusCode}` };
  if (agent.kind === "http" && agent.available) return { label: "API 健康", tone: "ok", detail: `健康端点返回 HTTP ${agent.statusCode}` };
  if (agent.kind === "http" && agent.reachable) return { label: "API 可达", tone: "configured", detail: `端点返回 HTTP ${agent.statusCode}，健康检查未通过` };
  if (agent.kind === "cli" && agent.available) return { label: "CLI 可启动", tone: "ok", detail: `${agent.version || "版本探测成功"}；登录状态未单独验证` };
  if (agent.agent === "tencent-workbuddy" && /ENOENT|not found|不存在/i.test(error)) {
    return { label: "未安装", tone: "off", detail: "未检测到 codebuddy CLI，可改用 HTTP API" };
  }
  if (agent.configured) return { label: "连接失败", tone: "configured", detail: error || "已配置但暂时无法连接" };
  return { label: "未配置", tone: "off", detail: error || "尚未配置此 Provider" };
}

function providerKind(agent) {
  if (agent.kind === "http") return "HTTP API";
  if (agent.kind === "cli") return "本地 CLI";
  return "CLI / HTTP";
}

function renderAgents(agents) {
  const previousTaskAgent = $("#task-agent")?.value;
  const previousFilterAgent = $("#task-agent-filter")?.value;
  const previousDiscussionAgents = new Set([...document.querySelectorAll('input[name="agents"]:checked')].map((input) => input.value));
  const hasPreviousDiscussionState = document.querySelectorAll('input[name="agents"]').length > 0;
  state.agents = agents;
  $("#provider-grid").innerHTML = agents.length ? agents.map((agent) => {
    const provider = providerState(agent);
    const endpoint = agent.command || agent.endpoint || "未配置";
    const authentication = agent.authentication === "rejected" ? "认证：健康端点拒绝了当前凭据" : agent.authentication === "not_rejected_by_health_endpoint" ? "认证：健康端点未拒绝（可能不要求认证；此状态不代表其他 API 权限）" : "认证：未验证";
    const recent = agent.recentExecution ? `最近任务：${statusLabel(agent.recentExecution.status)}${agent.recentExecution.mechanicalOutcome ? ` · 机械结果 ${agent.recentExecution.mechanicalOutcome}` : ""} · ${formatTime(agent.recentExecution.finishedAt || agent.recentExecution.createdAt)}${agent.recentExecution.providerModel ? `\n模型：${agent.recentExecution.providerModel}` : ""}${agent.recentExecution.permissionCleanup ? ` · 清理：${agent.recentExecution.permissionCleanup}` : ""}${agent.recentExecution.exitCode == null ? "" : ` · exit ${agent.recentExecution.exitCode}`}${agent.recentExecution.errorText ? `\n错误：${agent.recentExecution.errorText}` : ""}` : "最近任务：暂无执行记录";
    const probe = agent.healthCheckedAt ? `探测：${formatTime(agent.healthCheckedAt)}` : "探测时间未知";
    return `<article class="provider-card"><div class="provider-top"><div><h3>${escapeHtml(labelFor(agent))}</h3><p class="provider-kind">${escapeHtml(providerKind(agent))}</p></div><span class="badge ${provider.tone}">${escapeHtml(provider.label)}</span></div><p class="provider-meta">${escapeHtml(`${provider.detail}\n${authentication}\n${probe}\n${recent}`)}</p><p class="provider-command">${escapeHtml(endpoint)}</p></article>`;
  }).join("") : '<div class="empty-state"><strong>暂时没有 Provider</strong><span>请检查服务配置后刷新。</span></div>';

  const preferred = agents.find((agent) => agent.available)?.agent || agents[0]?.agent || "";
  $("#task-agent").innerHTML = agents.map((agent) => `<option value="${escapeHtml(agent.agent)}">${escapeHtml(labelFor(agent))}</option>`).join("");
  $("#task-agent").value = agents.some((agent) => agent.agent === previousTaskAgent) ? previousTaskAgent : preferred;
  $("#task-agent-filter").innerHTML = `<option value="">全部 Agent</option>${agents.map((agent) => `<option value="${escapeHtml(agent.agent)}">${escapeHtml(labelFor(agent))}</option>`).join("")}`;
  $("#task-agent-filter").value = agents.some((agent) => agent.agent === previousFilterAgent) ? previousFilterAgent : "";

  const availableDefaults = agents.filter((agent) => agent.available).map((agent) => agent.agent);
  const defaults = new Set(availableDefaults.length ? availableDefaults : agents.slice(0, 1).map((agent) => agent.agent));
  const selected = hasPreviousDiscussionState ? previousDiscussionAgents : defaults;
  $("#discussion-agents").innerHTML = agents.map((agent) => `<label class="check"><input type="checkbox" name="agents" value="${escapeHtml(agent.agent)}" ${selected.has(agent.agent) ? "checked" : ""} />${escapeHtml(labelFor(agent))}${agent.available ? "" : '<span class="check-note">不可用</span>'}</label>`).join("");
}

function renderAgentPayload(payload) {
  renderAgents(payload.agents);
  if (payload.taskOptions) {
    state.taskOptions = payload.taskOptions;
    for (const selector of ["#task-timeout", "#reply-timeout"]) $(selector).max = String(payload.taskOptions.maxTimeoutMs / 60000);
    if (!state.timeoutInitialized) {
      $("#task-timeout").value = String(Math.max(1, Math.ceil(payload.taskOptions.defaultTimeoutMs / 60000)));
      state.timeoutInitialized = true;
    }
  }
}

function emptyState(title, description) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div>`;
}

function taskItem(task) {
  const output = task.resultPreviewKind === "error" ? `错误：${task.resultPreview}` : task.resultPreview || task.prompt || "等待结果";
  const action = task.status === "running" || task.status === "queued" ? `<button aria-label="停止任务 ${escapeHtml(task.id)}" data-stop-task="${escapeHtml(task.id)}">停止</button>` : "";
  const agent = state.agents.find((item) => item.agent === task.agent);
  const followUpLabel = task.status === "running"
    ? agent?.capabilities?.follow_up === "supported" ? "实时回复" : ""
    : task.status === "queued" ? "" : agent?.capabilities?.resume === "supported" && task.hasProviderSessionId ? "继续会话" : "新一轮";
  const followUp = followUpLabel ? `<button aria-label="${escapeHtml(followUpLabel)}任务 ${escapeHtml(task.id)}" data-reply-task="${escapeHtml(task.id)}">${escapeHtml(followUpLabel)}</button>` : "";
  return `<article class="item"><div class="item-main"><div class="item-kicker"><span class="agent-chip">${escapeHtml(labelFor(agent || { agent: task.agent }))}</span><code>${escapeHtml(task.id)}</code><span>${escapeHtml(formatTime(task.createdAt))}</span></div><div class="item-title">${escapeHtml((task.prompt || "未命名任务").slice(0, 160))}</div><div class="item-meta">${escapeHtml(task.cwd || "工作目录未知")} · ${escapeHtml(output.slice(0, 150))}</div></div><span class="status status-${escapeHtml(task.status)}">${escapeHtml(statusLabel(task.status))}</span><div class="item-actions">${followUp}${action}<button aria-label="查看任务详情 ${escapeHtml(task.id)}" data-view-task="${escapeHtml(task.id)}">详情</button></div></article>`;
}

function discussionItem(discussion) {
  const minutes = discussion.latestMinutes ? `<button aria-label="查看讨论纪要 ${escapeHtml(discussion.id)}" data-view-minutes="${escapeHtml(discussion.id)}">纪要</button>` : "";
  const stop = ["running", "queued"].includes(discussion.status) ? `<button aria-label="停止讨论 ${escapeHtml(discussion.id)}" data-stop-discussion="${escapeHtml(discussion.id)}">停止</button>` : "";
  return `<article class="item"><div class="item-main"><div class="item-kicker"><span class="agent-chip">${escapeHtml(discussion.agents.length)} 个 Agent</span><code>${escapeHtml(discussion.id)}</code></div><div class="item-title">${escapeHtml(discussion.prompt.slice(0, 160))}</div><div class="item-meta">${escapeHtml(`${discussion.rounds} 轮讨论 · ${discussion.cwd}`)}</div></div><span class="status status-${escapeHtml(discussion.status)}">${escapeHtml(statusLabel(discussion.status))}</span><div class="item-actions"><button aria-label="查看讨论 ${escapeHtml(discussion.id)}" data-view-discussion="${escapeHtml(discussion.id)}">查看</button>${minutes}${stop}</div></article>`;
}

function renderSummary(statusCounts, discussions) {
  const counts = statusCounts || {};
  const active = Number(counts.queued || 0) + Number(counts.running || 0);
  const failed = ["failed", "stopped", "timed_out", "interrupted", "completed_with_errors"].reduce((sum, status) => sum + Number(counts[status] || 0), 0);
  const total = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
  $("#running-count").textContent = String(active);
  $("#failed-count").textContent = String(failed);
  $("#total-count").textContent = String(total);
  $("#discussion-count-summary").textContent = String(discussions.length);
  $("#minutes-count").textContent = String(discussions.filter((discussion) => discussion.latestMinutes).length);
}

function setMessage(id, message, error = false) {
  const element = $(id);
  element.textContent = message;
  element.className = `form-note${error ? " error" : ""}`;
}

function showToast(message, error = false) {
  const toast = $("#toast");
  clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.className = `toast${error ? " error" : ""}`;
  toast.hidden = false;
  state.toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function closeDialog(id) {
  const dialog = $(id);
  if (dialog?.open) dialog.close();
}

async function loadTaskEventHistory(id, previous = null) {
  const cached = previous?.id === id && !previous.incomplete ? previous : null;
  const events = cached ? [...cached.events] : [];
  const maxPages = 20;
  let afterCursor = cached?.lastCursor || 0;
  let eventCursor = null;
  let hasMore = false;
  let stalled = false;
  let pages = 0;
  while (pages < maxPages) {
    const previousCursor = afterCursor;
    const page = await api(`/api/tasks/${encodeURIComponent(id)}/events?afterCursor=${afterCursor}&limit=1000`);
    pages += 1;
    events.push(...(Array.isArray(page.events) ? page.events : []));
    eventCursor = page.eventCursor ?? eventCursor;
    hasMore = page.hasMore === true;
    const nextCursor = Number(page.nextCursor);
    if (Number.isSafeInteger(nextCursor) && nextCursor >= afterCursor) afterCursor = nextCursor;
    if (!hasMore) break;
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= previousCursor || !page.events?.length) {
      stalled = true;
      break;
    }
  }
  return { id, events, eventCursor, lastCursor: afterCursor, incomplete: hasMore || stalled, nextCursor: hasMore || stalled ? afterCursor : null };
}

async function showTaskDetails(id, { live = false } = {}) {
  if (!live) { state.detail = { kind: "task", id }; state.detailHistory = null; }
  const requestId = ++state.detailRequestId;
  const [taskPayload, eventHistory] = await Promise.all([
    api(`/api/tasks/${encodeURIComponent(id)}`),
    loadTaskEventHistory(id, state.detailHistory),
  ]);
  if (requestId !== state.detailRequestId || state.detail?.id !== id || state.detail?.kind !== "task" || (live && !$("#detail-dialog").open)) return;
  state.detailHistory = eventHistory;
  const task = taskPayload.task;
  const metadata = task.metadata || {};
  const outcome = metadata.mechanicalOutcome || {};
  const policy = task.permissionPolicy || {};
  const effective = policy.effective || {};
  const profile = policy.executionProfile || {};
  const versionValidation = profile.providerVersionValidation || policy.capabilityReport?.providerVersionValidation;
  const finalAnswer = metadata.providerFinalAnswer;
  const structuredErrors = metadata.providerFacts?.structuredToolErrors || [];
  const events = eventHistory.events.map((event) => {
    const payload = event.payload || {};
    const json = payload.json || {};
    const detail = payload.error || json.message || json.result?.response || json.result || json.text || payload.text || payload.line || "";
    return `<div class="event-row"><strong>${escapeHtml(formatTime(event.createdAt))} · ${escapeHtml(event.eventType)} · ${escapeHtml(event.source || "control-plane")}</strong><span>${escapeHtml(String(detail).slice(0, 500))}</span></div>`;
  }).join("");
  const errors = [task.errorText, ...structuredErrors.map((item) => `${item.tool || "Provider"}: ${item.message || item.code || "结构化错误"}`)].filter(Boolean);
  const permissionRows = [
    ["工作区", effective.workspace || task.cwd],
    ["文件范围", Array.isArray(effective.filesystemScope) ? effective.filesystemScope.join("、") : "未记录"],
    ["写入", effective.writeAllowed === true ? "允许" : effective.writeAllowed === false ? "不允许" : "未知"],
    ["网络", effective.networkAllowed === true ? "允许" : effective.networkAllowed === false ? "不允许" : "未知"],
    ["审批策略", effective.approvalPolicy || "未记录"],
    ["执行约束", profile.status || policy.status || "未知"],
    ["清理回执", metadata.permissionCleanup?.state || "无清理回执"],
  ].map(([label, value]) => `<p><strong>${escapeHtml(label)}：</strong>${escapeHtml(value)}</p>`).join("");
  const providerModel = metadata.providerModel?.actualModel || metadata.providerModel?.resolvedModel || task.model || "未记录";
  const output = task.resultText ? `<pre>${escapeHtml(task.resultText)}</pre>` : "暂无完整 Provider 输出。";
  $("#detail-title").textContent = `任务详情 · ${id}`;
  $("#detail-content").innerHTML = `<div class="detail-grid">
    <section class="detail-section"><h4>执行结果</h4><p><strong>${escapeHtml(statusLabel(task.status))}</strong> · mechanical outcome: ${escapeHtml(outcome.outcome || "未记录")}</p><p>退出码：${escapeHtml(task.exitCode ?? "未知")} · 尝试次数：${escapeHtml(task.attemptNo ?? 1)} · 本轮时限：${escapeHtml(task.timeoutMs / 60000)} 分钟</p><p>创建：${escapeHtml(formatTime(task.createdAt))} · 开始：${escapeHtml(formatTime(task.startedAt))} · 结束：${escapeHtml(formatTime(task.finishedAt))}</p>${outcome.reason ? `<p>机械判定说明：${escapeHtml(outcome.reason)}</p>` : ""}</section>
    <section class="detail-section"><h4>模型与权限</h4><p>Provider 模型：${escapeHtml(providerModel)}</p>${versionValidation ? `<p>WorkBuddy 版本验证：${escapeHtml(versionValidation.status)} · 已验证 ${escapeHtml(versionValidation.validatedProviderVersion || "未知")} · 当前探测 ${escapeHtml(versionValidation.observedProviderVersion || "未探测")}</p>` : ""}${permissionRows}${profile.reason ? `<p>限制：${escapeHtml(profile.reason)}</p>` : ""}</section>
  </div>
  <section class="detail-section"><h4>Provider 最终答复</h4>${finalAnswer?.text ? `<p>来源：Provider 终结事件（${escapeHtml(finalAnswer.eventType)}）。此字段只表示协议标记，不代表内容已被语义验证。</p><pre>${escapeHtml(finalAnswer.text)}</pre>` : `<p>未收到可识别的 Provider 最终答复标记；下面的完整输出可能包含过程信息。</p>`}</section>
  <section class="detail-section"><h4>完整 Provider 输出（可能包含过程日志）</h4>${output}</section>
  <section class="detail-section"><h4>错误与限制</h4>${errors.length ? errors.map((error) => `<p>${escapeHtml(error)}</p>`).join("") : "<p>没有记录到错误。</p>"}</section>
  <details class="detail-section"><summary>执行时间线（${eventHistory.events.length} 条${eventHistory.incomplete ? "，当前页未完整" : ""}）</summary><div class="event-timeline">${events || "<p>没有事件。</p>"}</div></details>`;
  if (!$("#detail-dialog").open) $("#detail-dialog").showModal();
}

async function showDiscussionDetails(id, { live = false } = {}) {
  if (!live) { state.detail = { kind: "discussion", id }; state.detailHistory = null; }
  const requestId = ++state.detailRequestId;
  const payload = await api(`/api/discussions/${encodeURIComponent(id)}`);
  if (requestId !== state.detailRequestId || state.detail?.id !== id || state.detail?.kind !== "discussion" || (live && !$("#detail-dialog").open)) return;
  const discussion = payload.discussion;
  const messages = (discussion.messages || []).map((message) => `<div class="event-row"><strong>${escapeHtml(`第 ${message.roundNo || "?"} 轮 · ${labelFor(state.agents.find((agent) => agent.agent === message.agent) || { agent: message.agent })} · ${formatTime(message.createdAt)}`)}</strong><span>${escapeHtml(message.text || message.errorText || "无文本")}</span></div>`).join("");
  $("#detail-title").textContent = `讨论详情 · ${id}`;
  $("#detail-content").innerHTML = `<section class="detail-section"><h4>讨论状态</h4><p>${escapeHtml(statusLabel(discussion.status))} · ${escapeHtml(discussion.rounds)} 轮 · ${escapeHtml((discussion.agents || []).join("、"))}</p><p>工作目录：${escapeHtml(discussion.cwd)}</p><p>问题：${escapeHtml(discussion.prompt)}</p>${discussion.errorText ? `<p>错误：${escapeHtml(discussion.errorText)}</p>` : ""}</section><section class="detail-section"><h4>讨论消息</h4><div class="event-timeline">${messages || "<p>暂无消息。</p>"}</div></section>`;
  if (!$("#detail-dialog").open) $("#detail-dialog").showModal();
}

async function refreshOpenDetails() {
  if (!$("#detail-dialog").open || !state.detail) return;
  const { kind, id } = state.detail;
  if (kind === "task") await showTaskDetails(id, { live: true });
  else await showDiscussionDetails(id, { live: true });
}

$("#detail-dialog").addEventListener("close", () => {
  state.detail = null;
  state.detailHistory = null;
  state.detailRequestId += 1;
});

async function showMinutes(id) {
  const payload = await api(`/api/discussions/${encodeURIComponent(id)}/minutes`);
  $("#minutes-title").textContent = `纪要 · ${id}`;
  $("#minutes-content").textContent = payload.minutes?.markdown || "暂无纪要";
  $("#minutes-viewer").showModal();
}

function openReply(id) {
  state.replyTaskId = id;
  const task = state.tasks.find((item) => item.id === id);
  const agent = state.agents.find((item) => item.agent === task?.agent);
  const isRunning = task?.status === "running";
  const canReplyLive = agent?.capabilities?.follow_up === "supported";
  const canResume = agent?.capabilities?.resume === "supported" && Boolean(task?.hasProviderSessionId);
  $("#reply-title").textContent = isRunning ? "实时回复任务" : canResume ? "继续 Provider 会话" : "启动新一轮";
  $("#reply-description").textContent = isRunning && canReplyLive
    ? "任务仍在运行；这条指令会发送到当前 Provider 会话。"
    : canResume
      ? "将尝试使用已有 Provider session，继续同一任务记录。"
      : "将以同一任务记录启动新一轮执行；此 Provider 不会自动带入上一轮上下文。";
  $("#reply-prompt").value = "";
  $("#reply-timeout").value = String(Math.max(1, Math.ceil((task?.timeoutMs || state.taskOptions?.defaultTimeoutMs || 3600000) / 60000)));
  $("#reply-timeout").disabled = isRunning;
  setMessage("#reply-message", "");
  $("#reply-dialog").showModal();
  $("#reply-prompt").focus();
}

function activeTaskFilters() {
  return {
    query: $("#task-search").value.trim(),
    agent: $("#task-agent-filter").value,
    status: $("#task-status-filter").value,
  };
}

function taskFilterKey(filters) {
  return JSON.stringify(filters);
}

function renderTaskList(total) {
  const countText = `${state.tasks.length} / ${total} 条匹配`;
  if ($("#task-count").textContent !== countText) $("#task-count").textContent = countText;
  $("#task-list").innerHTML = state.tasks.length ? state.tasks.map(taskItem).join("") : emptyState("没有匹配任务", "调整筛选条件，或派发一个新任务。");
  $("#task-load-more").hidden = !state.taskHasMore;
}

async function fetchTaskPage({ reset = false, preserveExisting = false } = {}) {
  const filters = activeTaskFilters();
  const filterKey = taskFilterKey(filters);
  const sameFilters = filterKey === state.taskFilters;
  const existingTasks = state.tasks;
  const targetCount = reset && preserveExisting && sameFilters ? Math.max(30, existingTasks.length) : 30;
  const params = new URLSearchParams({ limit: String(Math.min(100, targetCount)) });
  if (!reset && state.taskNextCursor) params.set("cursor", state.taskNextCursor);
  if (filters.query) params.set("query", filters.query);
  if (filters.agent) params.set("agent", filters.agent);
  if (filters.status) params.set("status", filters.status);
  const requestId = ++state.taskRequestId;
  const freshTasks = [];
  let page;
  do {
    page = await api(`/api/task-summaries?${params.toString()}`);
    if (requestId !== state.taskRequestId || filterKey !== taskFilterKey(activeTaskFilters())) return null;
    freshTasks.push(...page.tasks);
    if (!reset || !page.hasMore || freshTasks.length >= targetCount) break;
    if (!page.nextCursor || page.nextCursor === params.get("cursor")) throw new Error("任务分页游标未前进");
    params.set("cursor", page.nextCursor);
    params.set("limit", String(Math.min(100, targetCount - freshTasks.length)));
  } while (true);
  // Replace every loaded page with current server snapshots. Keeping the old
  // tail forever leaves completed tasks stale and violates active filters.
  const merged = new Map((reset ? [] : state.tasks).map((task) => [task.id, task]));
  for (const task of freshTasks) merged.set(task.id, task);
  state.tasks = [...merged.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)));
  state.taskFilters = filterKey;
  state.taskNextCursor = page.nextCursor;
  state.taskHasMore = page.hasMore === true;
  state.taskStatusCounts = page.statusCounts || {};
  renderTaskList(page.total);
  return page;
}

async function refreshAgentHealth({ showErrors = false } = {}) {
  try {
    const health = await api("/api/agents");
    renderAgentPayload(health);
    if (!state.previewInitialized) {
      state.previewInitialized = true;
      void refreshPolicyPreview();
    }
  } catch (error) {
    if (showErrors) showToast(error.message, true);
  }
}

async function refreshSnapshot() {
  try {
    const [tasks, discussions, agents] = await Promise.all([
      fetchTaskPage({ reset: true, preserveExisting: true }),
      api("/api/discussions?limit=200"),
      api("/api/agents?cached=1"),
    ]);
    if (!tasks) return null;
    renderAgentPayload(agents);
    $("#service-state").textContent = `本机服务已连接 · ${state.activityConnected ? "实时更新" : "轮询更新"}`;
    $("#service-state").className = "service-state ok";
    state.refreshErrorShown = false;
    renderSummary(state.taskStatusCounts, discussions.discussions);
    $("#discussion-count").textContent = `${discussions.discussions.length} 条`;
    $("#discussion-list").innerHTML = discussions.discussions.length ? discussions.discussions.map(discussionItem).join("") : emptyState("还没有讨论", "选择两个或更多可用 Agent，开始一轮架构讨论。");
    await refreshOpenDetails();
    return tasks;
  } catch (error) {
    $("#service-state").textContent = "服务暂时不可用";
    $("#service-state").className = "service-state error";
    if (!state.refreshErrorShown) {
      showToast(error.message, true);
      state.refreshErrorShown = true;
    }
  }
}

function refresh({ invalidate = false } = {}) {
  if (state.loadingMore) { state.refreshAgain = true; return Promise.resolve(null); }
  if (state.refreshPromise) {
    if (invalidate) state.refreshAgain = true;
    return state.refreshPromise;
  }
  state.refreshPromise = (async () => {
    do {
      state.refreshAgain = false;
      await refreshSnapshot();
    } while (state.refreshAgain && !state.loadingMore);
  })().finally(() => { state.refreshPromise = null; });
  return state.refreshPromise;
}

let activityRefreshTimer = null;
function scheduleActivityRefresh() {
  clearTimeout(activityRefreshTimer);
  activityRefreshTimer = setTimeout(() => { void refresh({ invalidate: true }); }, 150);
}

function startActivityUpdates() {
  if (typeof EventSource === "undefined") return;
  const stream = new EventSource("/api/activity/stream");
  stream.addEventListener("open", () => {
    state.activityConnected = true;
    scheduleActivityRefresh();
  });
  stream.addEventListener("activity", scheduleActivityRefresh);
  stream.addEventListener("error", () => {
    state.activityConnected = false;
    scheduleActivityRefresh();
  });
}

let taskSearchTimer = null;
let policyPreviewTimer = null;
function applyTaskFilters() {
  state.tasks = [];
  state.taskNextCursor = null;
  state.taskHasMore = false;
  state.taskRequestId += 1;
  void refresh({ invalidate: true });
}

$("#task-search").addEventListener("input", () => {
  clearTimeout(taskSearchTimer);
  taskSearchTimer = setTimeout(applyTaskFilters, 300);
});
$("#task-agent-filter").addEventListener("change", applyTaskFilters);
$("#task-status-filter").addEventListener("change", applyTaskFilters);
$("#task-load-more").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  state.loadingMore = true;
  if (state.refreshPromise) await state.refreshPromise;
  try { await fetchTaskPage(); } catch (error) { showToast(error.message, true); }
  finally {
    state.loadingMore = false;
    event.currentTarget.disabled = false;
    if (state.refreshAgain) void refresh({ invalidate: true });
  }
});
$("#task-agent").addEventListener("change", () => {
  clearTimeout(policyPreviewTimer);
  policyPreviewTimer = setTimeout(() => void refreshPolicyPreview(), 150);
});
$("#task-cwd").addEventListener("input", () => {
  clearTimeout(policyPreviewTimer);
  policyPreviewTimer = setTimeout(() => void refreshPolicyPreview(), 350);
});
$("#open-dispatch").addEventListener("click", () => {
  $("#dispatch-panel").open = true;
  $("#dispatch-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => $("#task-agent").focus(), 100);
});
$("#dispatch-panel").addEventListener("toggle", (event) => {
  $("#dispatch-toggle-label").textContent = event.currentTarget.open ? "收起表单" : "展开表单";
});
$("#refresh-button").addEventListener("click", () => {
  void refresh();
  void refreshAgentHealth({ showErrors: true });
});

async function refreshPolicyPreview() {
  const requestId = ++state.previewRequest;
  const output = $("#permission-preview");
  output.classList.remove("error");
  output.textContent = "正在计算 Dashboard 来源的权限边界…";
  const params = new URLSearchParams({ agent: $("#task-agent").value });
  if ($("#task-cwd").value.trim()) params.set("cwd", $("#task-cwd").value.trim());
  try {
    const preview = await api(`/api/policy-preview?${params.toString()}`);
    if (requestId !== state.previewRequest) return;
    const policy = preview.permissionPolicy || {};
    const effective = policy.effective || {};
    const profile = policy.executionProfile || {};
    const limitations = [...(policy.limitations || []), ...(profile.reason ? [profile.reason] : [])];
    output.textContent = [
      `工作区：${preview.cwd}`,
      `文件范围：${Array.isArray(effective.filesystemScope) ? effective.filesystemScope.join("、") : "未知"}`,
      `有效写入：${effective.writeAllowed === true ? "允许" : "不允许"} · 网络：${effective.networkAllowed === true ? "允许" : "不允许"}`,
      `审批策略：${effective.approvalPolicy || "未知"} · 执行约束：${profile.status || policy.status || "未知"}`,
      limitations.length ? `限制：${limitations.join("；")}` : "限制：暂无额外限制说明",
    ].join("\n");
  } catch (error) {
    if (requestId !== state.previewRequest) return;
    output.classList.add("error");
    output.textContent = `无法生成权限预览：${error.message}`;
  }
}

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage("#task-message", "正在创建…");
  try {
    const task = await api("/api/tasks", { method: "POST", body: { agent: $("#task-agent").value, cwd: $("#task-cwd").value || undefined, prompt: $("#task-prompt").value, timeoutMs: Number($("#task-timeout").value) * 60000 } });
    setMessage("#task-message", `已创建 ${task.task.id}`);
    $("#task-prompt").value = "";
    await refresh();
  } catch (error) {
    setMessage("#task-message", error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#discussion-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  const agents = [...document.querySelectorAll('input[name="agents"]:checked')].map((input) => input.value);
  if (!agents.length) {
    setMessage("#discussion-message", "至少选择一个 Agent", true);
    return;
  }
  button.disabled = true;
  setMessage("#discussion-message", "正在启动讨论…");
  try {
    const discussion = await api("/api/discussions", { method: "POST", body: { agents, cwd: $("#discussion-cwd").value || undefined, prompt: $("#discussion-prompt").value, rounds: Number($("#discussion-rounds").value) } });
    setMessage("#discussion-message", `已创建 ${discussion.discussion.id}`);
    $("#discussion-prompt").value = "";
    await refresh();
  } catch (error) {
    setMessage("#discussion-message", error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#reply-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage("#reply-message", "正在发送…");
  try {
    await api(`/api/tasks/${encodeURIComponent(state.replyTaskId)}/reply`, { method: "POST", body: { prompt: $("#reply-prompt").value, ...(!$("#reply-timeout").disabled ? { timeoutMs: Number($("#reply-timeout").value) * 60000 } : {}) } });
    closeDialog("#reply-dialog");
    showToast("跟进已发送");
    await refresh();
  } catch (error) {
    setMessage("#reply-message", error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  try {
    if (target.id === "close-detail") return closeDialog("#detail-dialog");
    if (target.id === "close-minutes") return closeDialog("#minutes-viewer");
    if (target.id === "cancel-reply") return closeDialog("#reply-dialog");
    if (target.dataset.replyTask) return openReply(target.dataset.replyTask);
    if (target.dataset.stopTask) await api(`/api/tasks/${encodeURIComponent(target.dataset.stopTask)}/stop`, { method: "POST", body: {} });
    if (target.dataset.viewTask) await showTaskDetails(target.dataset.viewTask);
    if (target.dataset.stopDiscussion) await api(`/api/discussions/${encodeURIComponent(target.dataset.stopDiscussion)}/stop`, { method: "POST", body: {} });
    if (target.dataset.viewDiscussion) await showDiscussionDetails(target.dataset.viewDiscussion);
    if (target.dataset.viewMinutes) await showMinutes(target.dataset.viewMinutes);
    if (target.dataset.stopTask || target.dataset.stopDiscussion) showToast("操作已提交");
    if (target.dataset.stopTask || target.dataset.stopDiscussion) await refresh();
  } catch (error) {
    showToast(error.message, true);
  }
});

void refreshAgentHealth().finally(() => refresh());
startActivityUpdates();
document.addEventListener("visibilitychange", () => { if (!document.hidden) scheduleActivityRefresh(); });
window.addEventListener("online", scheduleActivityRefresh);
setInterval(() => void refresh(), 4000);
setInterval(() => void refreshAgentHealth(), 30000);
