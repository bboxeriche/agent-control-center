# Agent Control Center

Agent Control Center gives Codex one controlled entry point for local Antigravity, Claude Code, Codex CLI, and Tencent WorkBuddy/CodeBuddy tasks.

The control service runs on `127.0.0.1:47770` by default. It owns task lifecycle, process supervision, provider events, discussion rounds, and durable storage. The Codex plugin exposes the control service through MCP. A small local dashboard is available at `http://127.0.0.1:47770/`.

## Start it directly

```bash
npm start
```

The service stores its SQLite database, append-only event log, and generated minutes under `~/.codex/agent-control-center` unless `AGENT_CONTROL_DATA_DIR` is set. Set `AGENT_CONTROL_CONFIG` to a JSON configuration file to override executable paths or configure Tencent WorkBuddy's HTTP API.

For a repository-wide default working directory, set `AGENT_CONTROL_DEFAULT_CWD` to an absolute path. Every task can also provide its own absolute `cwd`. The service refuses relative or nonexistent working directories.

The local API is authenticated. The service creates `auth.token` under the data directory with mode `0600`; the MCP server reads it automatically, and the loopback dashboard receives an HttpOnly cookie. Keep the default host `127.0.0.1` unless you have separately designed network access controls. Do not expose port `47770` directly to the internet.

## Frozen DevSpace boundary

The current control chain is `Founder → ChatGPT → DevSpace → Agent Control Center → executor`. DevSpace is the existing ChatGPT-to-local execution bridge; the control center does not maintain a ChatGPT session, push to ChatGPT, or start a second gateway. A DevSpace caller should identify itself with `origin: "devspace"` when using the existing local API contract. ChatGPT can create, inspect, wait, follow up, stop, and recover tasks through that path; results are returned when the client asks.

The durable task contract is:

- `taskId` is the control-center execution identity and survives client disconnects and follow-up attempts.
- `providerSessionId` and provider job/conversation IDs are adapter metadata only.
- `idempotencyKey` retries return the existing task and do not spawn another executor.
- `GET /api/tasks/:taskId/events?afterCursor=N` returns a durable page with `nextCursor` and `hasMore`.
- `GET /api/tasks/:taskId/wait?timeoutMs=N&afterCursor=N` is bounded by `maxWaitMs` (60 seconds by default) and returns the current task plus observable events. A timeout is a normal snapshot, not a task failure.

The same operations are available to Codex through `acc_task_*` MCP tools, including `acc_task_wait`. The existing `after` query/tool field remains a compatibility alias for `afterCursor`.

## Install the local plugin

The repository includes a local marketplace at `.agents/plugins/marketplace.json`. After the implementation is validated, add that marketplace to Codex and install `agent-control-center` from it. A new Codex task is required for the newly installed MCP tools to be discovered.

```bash
codex plugin marketplace add /Users/eriche/Documents/Codex/2026-09-05/ke-y
codex plugin add agent-control-center@agent-control-local
```

After installation, the Codex session can call the MCP tools directly. Codex Remote on a phone can use those same tools through the connected Mac/Windows host; the host must be awake, online, and signed into the same Codex account/workspace. The dashboard itself remains a local visual monitor.

## Provider states

Provider health is reported independently. An unavailable CLI never prevents the other providers or the Codex App from working. Tencent WorkBuddy can use the documented HTTP API when `httpUrl` and its token environment variable are configured; otherwise the adapter probes the `codebuddy` executable. On macOS, it also auto-detects the bundled CLI inside `/Applications/WorkBuddy.app` (or `~/Applications/WorkBuddy.app`) when the app has not added `codebuddy` to `PATH`.

The Tencent HTTP adapter follows the CodeBuddy beta jobs contract: it submits `POST /api/v1/jobs`, follows the job SSE stream, and uses the documented `X-CodeBuddy-Request: 1` header. Configure it with `WORKBUDDY_HTTP_URL` and, if required by the local gateway, `WORKBUDDY_HTTP_TOKEN`. The installed CLI name is `codebuddy`; if auto-detection is not applicable, set `AGENT_CONTROL_WORKBUDDY_COMMAND` to an explicit executable path. A missing or unhealthy CLI is reported explicitly rather than silently treated as a successful run.

For CLI tasks, the optional MCP `model` field is passed literally to the provider as `--model`; it is a provider-specific model identifier, not a universal alias. Codex CLI defaults to `gpt-5.6-luna` with `model_reasoning_effort="max"`; the task is run through `codex exec --json` with a `workspace-write` sandbox rooted at the requested `cwd`. On this Mac, the observed valid identifiers are WorkBuddy `hy4-preview` (the literal `HY4` is rejected) and Antigravity `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, or `gemini-3.8-flash-low` (the literal `3.8flash` is rejected). CLI defaults use each provider's structured streaming output so provider messages and session IDs can be persisted; Codex CLI and WorkBuddy follow-ups use their resume options when a session ID is available.

A real read-only check through the installed plugin succeeded for WorkBuddy with `hy4-preview` and, after the network node was corrected, for Antigravity with `gemini-3.8-flash-high`. Both returned `ACC_E2E_OK`; Provider session IDs and event streams were persisted. An earlier Antigravity attempt failed with `FAILED_PRECONDITION (400): User location is not supported for the API use`, which was an environmental network-node issue rather than a control-plane failure.

## Data and permissions

The server never accepts an arbitrary command from an API request. The command and fixed argument template come from configuration; task requests can choose only a registered provider. Raw provider output is recorded with common credential patterns redacted, while the generated minutes retain task and event references for traceability.

When Claude Code is configured with a compatible local `ANTHROPIC_BASE_URL`, the plugin MCP manifest forwards `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_API_KEY` when those variables are available to the Codex host; their values are not stored in the plugin. If the variables are only present in an interactive shell, restart or reload Codex from an environment that can provide them.

Codex CLI uses the same local Codex installation and authentication/configuration available to the MCP host. `CODEX_HOME`, `OPENAI_API_KEY`, and `OPENAI_BASE_URL` are allowlisted when present, but their values are not stored in the plugin. The Codex CLI session itself is not treated as the Codex App conversation; the control plane stores its `thread_id` as the provider session reference and keeps the task/event/minutes record separately.

Tasks, provider events, discussions, and minutes are stored in SQLite. The append-only `events.jsonl` and `minutes/*.md` files provide a human-readable local record. A discussion runs up to three sequential critique rounds, with agents in each round receiving only bounded prior-round output. Stopping, provider failure, timeout, or service restart is represented in the record and does not get reported as success.

Every task records `origin` (`codex`, `devspace`, `dashboard`, or `local_cli`), optional `originRequestId`, attempt number, permission policy, capability snapshot, and its last durable event cursor. Remote-origin defaults are least privilege at the control-policy layer: write and network access are not granted by the transport. Only capabilities explicitly declared by an adapter are treated as native enforcement; unknown executor boundaries are reported as `limited` rather than simulated.

Follow-up on a completed task reuses the same `taskId`, increments `attemptNo`, preserves the provider session reference when the adapter supports resume, and appends new observable events. This keeps cross-client lookup stable while allowing provider-specific resume limitations to remain visible.
