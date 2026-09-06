const $ = (selector) => document.querySelector(selector);
const state = { agents: [], replyTaskId: null, toastTimer: null };

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

function providerState(agent) {
  const error = String(agent.error || "");
  if (agent.available) return { label: "已连接", tone: "ok", detail: agent.version || "Provider 已通过健康检查" };
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
  const previousDiscussionAgents = new Set([...document.querySelectorAll('input[name="agents"]:checked')].map((input) => input.value));
  const hasPreviousDiscussionState = document.querySelectorAll('input[name="agents"]').length > 0;
  state.agents = agents;
  $("#provider-grid").innerHTML = agents.length ? agents.map((agent) => {
    const provider = providerState(agent);
    const endpoint = agent.command || agent.endpoint || "未配置";
    return `<article class="provider-card"><div class="provider-top"><div><h3>${escapeHtml(labelFor(agent))}</h3><p class="provider-kind">${escapeHtml(providerKind(agent))}</p></div><span class="badge ${provider.tone}">${provider.label}</span></div><p class="provider-meta">${escapeHtml(provider.detail)}</p><p class="provider-command">${escapeHtml(endpoint)}</p></article>`;
  }).join("") : '<div class="empty-state"><strong>暂时没有 Provider</strong><span>请检查服务配置后刷新。</span></div>';

  const preferred = agents.find((agent) => agent.available)?.agent || agents[0]?.agent || "";
  $("#task-agent").innerHTML = agents.map((agent) => `<option value="${escapeHtml(agent.agent)}">${escapeHtml(labelFor(agent))}</option>`).join("");
  $("#task-agent").value = agents.some((agent) => agent.agent === previousTaskAgent) ? previousTaskAgent : preferred;

  const availableDefaults = agents.filter((agent) => agent.available).map((agent) => agent.agent);
  const defaults = new Set(availableDefaults.length ? availableDefaults : agents.slice(0, 1).map((agent) => agent.agent));
  const selected = hasPreviousDiscussionState ? previousDiscussionAgents : defaults;
  $("#discussion-agents").innerHTML = agents.map((agent) => `<label class="check"><input type="checkbox" name="agents" value="${escapeHtml(agent.agent)}" ${selected.has(agent.agent) ? "checked" : ""} />${escapeHtml(labelFor(agent))}${agent.available ? "" : '<span class="check-note">不可用</span>'}</label>`).join("");
}

function emptyState(title, description) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div>`;
}

function taskItem(task) {
  const output = task.resultText || task.errorText || task.prompt || "等待结果";
  const action = task.status === "running" || task.status === "queued" ? `<button aria-label="停止任务 ${escapeHtml(task.id)}" data-stop-task="${escapeHtml(task.id)}">停止</button>` : "";
  const agent = state.agents.find((item) => item.agent === task.agent);
  return `<article class="item"><div class="item-main"><div class="item-kicker"><span class="agent-chip">${escapeHtml(labelFor(agent || { agent: task.agent }))}</span><code>${escapeHtml(task.id)}</code></div><div class="item-title">${escapeHtml((task.prompt || "未命名任务").slice(0, 160))}</div><div class="item-meta">${escapeHtml(task.cwd)} · ${escapeHtml(output.slice(0, 150))}</div></div><span class="status status-${escapeHtml(task.status)}">${escapeHtml(statusLabel(task.status))}</span><div class="item-actions"><button aria-label="跟进任务 ${escapeHtml(task.id)}" data-reply-task="${escapeHtml(task.id)}">跟进</button>${action}<button aria-label="查看任务详情 ${escapeHtml(task.id)}" data-view-task="${escapeHtml(task.id)}">详情</button></div></article>`;
}

function discussionItem(discussion) {
  const minutes = discussion.latestMinutes ? `<button aria-label="查看讨论纪要 ${escapeHtml(discussion.id)}" data-view-minutes="${escapeHtml(discussion.id)}">纪要</button>` : "";
  const stop = ["running", "queued"].includes(discussion.status) ? `<button aria-label="停止讨论 ${escapeHtml(discussion.id)}" data-stop-discussion="${escapeHtml(discussion.id)}">停止</button>` : "";
  return `<article class="item"><div class="item-main"><div class="item-kicker"><span class="agent-chip">${escapeHtml(discussion.agents.length)} 个 Agent</span><code>${escapeHtml(discussion.id)}</code></div><div class="item-title">${escapeHtml(discussion.prompt.slice(0, 160))}</div><div class="item-meta">${escapeHtml(`${discussion.rounds} 轮讨论 · ${discussion.cwd}`)}</div></div><span class="status status-${escapeHtml(discussion.status)}">${escapeHtml(statusLabel(discussion.status))}</span><div class="item-actions"><button aria-label="查看讨论 ${escapeHtml(discussion.id)}" data-view-discussion="${escapeHtml(discussion.id)}">查看</button>${minutes}${stop}</div></article>`;
}

function renderSummary(tasks, discussions) {
  const active = tasks.filter((task) => ["queued", "running"].includes(task.status)).length;
  const finished = tasks.length - active;
  $("#running-count").textContent = String(active);
  $("#finished-count").textContent = String(Math.max(finished, 0));
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

async function showTaskDetails(id) {
  const [taskPayload, eventsPayload] = await Promise.all([
    api(`/api/tasks/${encodeURIComponent(id)}`),
    api(`/api/tasks/${encodeURIComponent(id)}/events?after=0`),
  ]);
  $("#detail-title").textContent = `任务详情 · ${id}`;
  $("#detail-content").textContent = JSON.stringify({ task: taskPayload.task, events: eventsPayload.events }, null, 2);
  $("#detail-dialog").showModal();
}

async function showDiscussionDetails(id) {
  const payload = await api(`/api/discussions/${encodeURIComponent(id)}`);
  $("#detail-title").textContent = `讨论详情 · ${id}`;
  $("#detail-content").textContent = JSON.stringify(payload.discussion, null, 2);
  $("#detail-dialog").showModal();
}

async function showMinutes(id) {
  const payload = await api(`/api/discussions/${encodeURIComponent(id)}/minutes`);
  $("#minutes-title").textContent = `纪要 · ${id}`;
  $("#minutes-content").textContent = payload.minutes?.markdown || "暂无纪要";
  $("#minutes-viewer").showModal();
}

function openReply(id) {
  state.replyTaskId = id;
  $("#reply-prompt").value = "";
  setMessage("#reply-message", "");
  $("#reply-dialog").showModal();
  $("#reply-prompt").focus();
}

async function refresh() {
  try {
    const [health, tasks, discussions] = await Promise.all([api("/api/agents"), api("/api/tasks?limit=30"), api("/api/discussions?limit=30")]);
    $("#service-state").textContent = "本机服务已连接";
    $("#service-state").className = "service-state ok";
    renderAgents(health.agents);
    renderSummary(tasks.tasks, discussions.discussions);
    $("#task-count").textContent = `${tasks.tasks.length} 条`;
    $("#task-list").innerHTML = tasks.tasks.length ? tasks.tasks.map(taskItem).join("") : emptyState("还没有任务", "从上方派发一个明确的检查或实现任务。");
    $("#discussion-count").textContent = `${discussions.discussions.length} 条`;
    $("#discussion-list").innerHTML = discussions.discussions.length ? discussions.discussions.map(discussionItem).join("") : emptyState("还没有讨论", "选择两个或更多可用 Agent，开始一轮架构讨论。");
  } catch (error) {
    $("#service-state").textContent = "服务暂时不可用";
    $("#service-state").className = "service-state error";
    showToast(error.message, true);
  }
}

$("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter || event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage("#task-message", "正在创建…");
  try {
    const task = await api("/api/tasks", { method: "POST", body: { agent: $("#task-agent").value, cwd: $("#task-cwd").value || undefined, prompt: $("#task-prompt").value } });
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
    await api(`/api/tasks/${encodeURIComponent(state.replyTaskId)}/reply`, { method: "POST", body: { prompt: $("#reply-prompt").value } });
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

$("#refresh-button").addEventListener("click", refresh);
refresh();
setInterval(refresh, 4000);
