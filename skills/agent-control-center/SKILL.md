---
name: agent-control-center
description: Use the local Agent Control Center to dispatch, inspect, discuss, stop, resume, and document Antigravity, Claude Code, Codex CLI, and Tencent WorkBuddy tasks.
---

# Agent Control Center

Use the Agent Control Center MCP tools when the user asks to run or compare the configured local coding agents.

Keep the control service as the source of truth for task IDs, provider session IDs, status, and events. Start with `acc_health` or `acc_agents` when provider availability is unknown. Use `acc_task_create` for one agent and `acc_discussion_create` for a structured multi-agent review.

Treat `taskId` as the durable execution identity. Pass `origin` and a stable `idempotencyKey` for client requests; a retry with the same key must reuse the existing task. Use `acc_task_wait` for bounded waits and `acc_task_events` with `afterCursor`/`nextCursor` after reconnect. A follow-up keeps the same task ID and increments its attempt number; provider session IDs are adapter metadata.

Separate mechanical execution, required delivery, and semantic acceptance. Anti defaults to a required nonempty final answer; use an explicit `deliveryContract` (`final_answer`, `files`, or `execution_only`) instead of guessing from prompt keywords. Older callers may put it in `metadata.deliveryContract`. A clean exit with missing delivery is `completed_without_delivery`, not a completed report. Unsupported permissions return `blocked_preflight` with `providerStarted: false`; never widen them to make the task run. Anti continuation remains unqualified: an unsupported reply must not secretly start a new attempt. Inspect durable public evidence and authorized artifacts before deliberately creating a bounded recovery task. Actual model identity may remain unknown; task metadata is not an enforced boundary.

For a discussion, state the original problem precisely, provide the repository path when relevant, and request two rounds when critique is useful. Each agent receives the prior round's bounded output. Use `acc_discussion_get` to inspect all messages and `acc_minutes_generate` to persist a traceable Markdown record.

Do not describe an unavailable provider as having run. If a task is still running, report that it is running and use `acc_task_get` or the stream endpoint to follow it. Treat generated minutes as an assembled record; distinguish provider statements, decisions, unresolved risks, and proposed actions.

The local dashboard is useful for visual monitoring, but all actions must remain possible through the MCP tools so they work from Codex Remote on a phone. DevSpace remains an existing caller path; do not add a new gateway or an unsolicited push channel. Report provider capability and permission limitations explicitly, especially when an executor cannot natively enforce a requested boundary.
