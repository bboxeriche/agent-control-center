# Agent Control Center

[![CI](https://github.com/bboxeriche/agent-control-center/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bboxeriche/agent-control-center/actions/workflows/ci.yml) [![License](https://img.shields.io/github/license/bboxeriche/agent-control-center)](https://github.com/bboxeriche/agent-control-center/blob/main/LICENSE) [![Release](https://img.shields.io/github/v/release/bboxeriche/agent-control-center?display_name=tag)](https://github.com/bboxeriche/agent-control-center/releases)

ACC is a local durable control plane that gives Codex one controlled interface for supervising multiple coding agents with persistent task identity, observable events, bounded permissions, recovery, and provider-specific capability reporting.

## What it is

Agent Control Center (ACC) is a local service, Codex MCP plugin, and small dashboard for coordinating coding-agent processes on one host. It owns task lifecycle, process supervision, provider events, follow-up attempts, discussions, and durable local records.

The service binds to `127.0.0.1:47770` by default. It does not create a public gateway or send unsolicited results to another service.

## Why it exists

Coding agents expose different commands, session identifiers, permission models, and failure signals. ACC gives them a common, observable control surface without pretending that provider capabilities are interchangeable. A task keeps one durable control-plane identity while provider-specific session IDs remain adapter metadata.

## Core capabilities

- Durable task identity, idempotent creation, bounded waiting, event history, and follow-up/resume attempts.
- Provider adapters for Codex CLI, Claude Code, Antigravity, and Tencent WorkBuddy/CodeBuddy.
- Task-scoped permission policy, capability snapshots, execution-profile preflight, and mechanical execution-outcome classification.
- Structured discussions with bounded critique rounds and traceable Markdown minutes.
- An authenticated loopback API, MCP tools, and a local dashboard.
- An authenticated DevSpace MCP client for an existing ChatGPT-to-local execution path.

## Architecture

```text
Codex
  |
 MCP
  v
Agent Control Center
  ├─ Codex CLI
  ├─ Claude Code
  ├─ Antigravity
  └─ WorkBuddy
```

ACC stores the task, provider events, discussions, and generated minutes locally. The control service accepts registered provider commands from configuration; an API request cannot provide an arbitrary command.

Final-answer evidence is stored separately from accumulated provider output. Antigravity's successful nested `result.response` is recognized as a final answer; progress updates and interrupted partial responses are not promoted to that field. Mechanical outcome and semantic verification remain separate.

## Supported providers

| Provider | Integration | Capability notes |
| --- | --- | --- |
| Codex CLI | Structured CLI execution and follow-up | Uses the local Codex installation and its configured authentication. |
| Claude Code | Configured local CLI | Uses the configured local endpoint and credentials when available. |
| Antigravity | Headless CLI adapter | macOS external containment is available for the supported profiles described below. |
| Tencent WorkBuddy/CodeBuddy | CLI or configured HTTP jobs API | The adapter reports unavailable or unhealthy paths explicitly. |

Provider health is independent: an unavailable provider does not prevent the other adapters or the local Codex MCP surface from working.

On macOS, Codex CLI discovery checks the current `ChatGPT.app` / `Codex.app` bundled `codex-cli` layouts and the legacy `Contents/Resources/codex` layout before falling back to `codex` on the service's PATH. Explicit command overrides remain authoritative. This avoids treating a desktop app layout update as a missing CLI or authentication failure.

## Quick start

Prerequisites: Node.js `>=22.5` and the provider CLIs or local endpoints you intend to use.

```bash
git clone https://github.com/bboxeriche/agent-control-center.git
cd agent-control-center
npm install
npm run check
npm test
npm start
```

The dashboard is available at `http://127.0.0.1:47770/`. Runtime data is stored under `~/.codex/agent-control-center` unless `AGENT_CONTROL_DATA_DIR` is set. Use `AGENT_CONTROL_CONFIG` for a JSON configuration file, `AGENT_CONTROL_DEFAULT_CWD` for a repository-wide default working directory, and `AGENT_CONTROL_ALLOWED_ROOTS` to constrain filesystem scopes. Working directories must be absolute and already exist.

The repository includes `.codex-plugin/plugin.json` and `.mcp.json`. To use the MCP surface from a local checkout, register `server/mcp-server.mjs` with `node` and set its working directory to the checkout, for example `/path/to/agent-control-center`.

## Security model

- The API is loopback-only by default and requires the generated bearer token. The token is stored with mode `0600`; it is not part of the MCP tool schema or prompt.
- Provider commands and argument templates come from configuration. Task requests select only a registered provider and cannot submit an arbitrary command.
- Remote-origin defaults are least privilege at the control-policy layer. Write and network access require an explicit request, an enabled origin ceiling, and a filesystem scope within `allowedRoots`.
- Capability receipts distinguish native provider enforcement, ACC mapping, external containment, and the effective boundary actually claimed for a task. Unknown executor boundaries are reported as `limited` rather than simulated as native support.
- Provider output is recorded with common credential patterns redacted. ACC receipts describe requested policy and mechanically observed facts; they do not prove that a model answer is correct or that a product-level acceptance gate has passed.

Antigravity headless permission mapping is fail-closed and task-scoped. On macOS, ACC uses a `sandbox-exec` profile plus a local network proxy for the supported external-containment profiles. The profile permits writes only under the effective task scope, routes network requests through the task proxy, denies common credential-shaped paths by default, and is removed after provider exit, stop, error, or timeout. Persistent Antigravity settings are not edited.

For Antigravity read-only headless tasks, workspace reads alone do not prove command approval: `request-review` soft-denies shell commands it cannot ask the user to approve. ACC now creates an isolated, temporary native project with explicit grants for common read-only Git, text-inspection and hashing commands. Native file writes, web/browser operations, MCP tools and common mutating Git operations receive deny rules. Existing global/shared deny and ask rules still apply; no `command(*)` or `--dangerously-skip-permissions` is added. The project is selected only for this attempt and removed with the containment cleanup receipt, including stop, timeout and spawn error; orphan reclamation also covers its approval file. A changed approval file is preserved and reported as a cleanup failure. User/global/existing-project settings are not changed.

The ACC outer macOS sandbox stays active. Read-only runs pass `--sandbox=false` only to avoid an unsupported second Seatbelt sandbox inside the outer one; this is not a full-privilege process. Runtime temporary files stay under the task directory, and `GIT_OPTIONAL_LOCKS=0` prevents read-only Git inspection from refreshing the index. Explicit `require_approval` remains fail-closed because print mode has no interactive approval channel. The project approval format is qualified with `agy 1.2.17` and `1.3.3`; unlisted commands may still require approval in the default project-grants mode, and the existing broad-read limitation of ACC's external sandbox remains unchanged. This does not qualify arbitrary native or remote tools as safely contained.

An operator can explicitly set `agents.antigravity.permissionMapping.headlessApprovalMode` to `"skip-permissions"` in the local ACC config to add `--dangerously-skip-permissions` to read-only attempts too. When supplying a new `permissionMapping` override, retain `"strategy": "sandbox-exec-proxy"`; the config loader replaces that nested mapping rather than deep-merging it. ACC still selects the isolated native project, retains its write/web/MCP/mutating-Git deny rules, and keeps the outer filesystem/network sandbox. With `agy 1.3.3`, real runs confirmed `permission_mode: always-proceed`, `pwd` succeeded both unlisted and under an explicit native Ask rule, and native file-write and web-read attempts still failed on explicit deny rules. Skip mode bypasses native Ask prompts, not just default prompts; receipts report this distinction. This is not an unrestricted process or a guarantee that every command will succeed. Explicit ACC `require_approval` and `deny_unapproved` requests fail preflight rather than being silently bypassed. The repository default remains `"project-grants"`; only an explicit local opt-in selects skip mode. Other execution-profile limitations are unchanged.

Tencent WorkBuddy/CodeBuddy CLI tasks use the same task-scoped containment primitives. For the validated WorkBuddy `2.106.4` CLI, ACC pins the default model to `hy4-preview`, passes an explicit per-run `--permission-mode bypassPermissions`, and restricts contained runs to `Read,Write,Edit,Bash,Glob,Grep`. The provider bypass is only a headless approval setting; the ACC boundary remains the canonical filesystem scope, sensitive-path deny rules, task proxy, and cleanup receipt. The provider transport allowlist includes the exact hosts `copilot.tencent.com`, `galileotelemetry.tencent.com`, and `www.workbuddy.cn`; current WorkBuddy CLIs use the last host even when task network access is disabled. WorkBuddy's remote `WebFetch` and `WebSearch` tools are disabled in contained runs because they execute outside the local ACC network boundary. Persistent WorkBuddy settings are not edited. Provider-managed `.codebuddy/projects` session files are left under the provider's ownership and are not mistaken for the task cleanup directory.

## Known limitations

- Antigravity task-scoped external containment is macOS-specific.
- Antigravity currently needs broad provider startup reads; a narrower read boundary causes the provider to abort during startup, so the adapter does not claim one.
- The bounded-write/no-network Antigravity capability quadrant is unsupported and fails closed during preflight because the headless network tool can escape the child-process path.
- Sensitive credential-shaped paths (`.env*`, `*.pem`, `*.key`, `credentials*`, and `auth*`) are denied by default inside the external profile. A task-scoped override is available only for a disposable, reviewable scope.
- Provider availability, authentication, model identifiers, and network behavior remain provider-specific. ACC does not make a provider cross-platform or guarantee semantic correctness, prompt-injection resistance, or product acceptance.
- WorkBuddy external containment is macOS-specific. The HTTP jobs adapter is reported as `http-endpoint-unqualified` because a remote endpoint is outside this local process boundary; it is not reported as locally contained.
- WorkBuddy's supported network profile uses local `Bash` traffic through the task proxy. Remote provider-side network tools are intentionally excluded rather than represented as task-scoped network capability.
- WorkBuddy normalizes its proxy URL to `127.0.0.1`, so its macOS seatbelt profile needs a loopback wildcard for the proxy connection. A direct `Bash` connection to another local-loopback port can therefore bypass the task proxy; the task proxy still denies local targets and non-allowlisted hosts when traffic uses the proxy. ACC does not claim complete local-service isolation for WorkBuddy on this host.

## Tested environments

- GitHub Actions runs the check and test suite on `macos-latest` with Node.js 22 and no provider credentials.
- Local validation targets macOS with Node.js `>=22.5`; the test suite uses fixtures and does not require live provider credentials, private repositories, or an auth token.
- The current Antigravity and WorkBuddy containment behavior is version- and host-specific. WorkBuddy health reports `providerVersion`, `defaultModel`, `validatedModels`, `requestedModel`, and `actualModel` separately; provider versions and model catalogs can change independently.

## Integration details

### Task and event contract

The durable task contract is:

- `taskId` is the ACC execution identity and survives client disconnects and follow-up attempts.
- `providerSessionId` and provider job/conversation IDs are adapter metadata only.
- `idempotencyKey` retries return the existing task and do not spawn another executor.
- `GET /api/tasks/:taskId/events?afterCursor=N` returns a durable page with `nextCursor` and `hasMore`.
- `GET /api/tasks/:taskId/wait?timeoutMs=N&afterCursor=N` is bounded by `maxWaitMs` (60 seconds by default). A timeout is a normal snapshot, not a task failure.

The same operations are available through the `acc_task_*` MCP tools, including `acc_task_wait`. The `after` query/tool field remains a compatibility alias for `afterCursor`.

Task execution defaults to **60 minutes**, configurable with `defaultTimeoutMs`. The per-attempt ceiling is **24 hours**; an explicit shorter `timeoutMs` remains authoritative. Dashboard task creation and completed-task follow-ups expose a minutes field. A follow-up can set a new `timeoutMs` for its next attempt, while an active attempt's timer cannot be extended by a live reply. Stop and cleanup still apply. The separate 60-second client wait ceiling is not the task execution ceiling.

ACC maps Antigravity's `--print-timeout` below the outer task watchdog, reserving 5% of the budget (at least five seconds and at most one minute for normal tasks) for startup, output collection and cleanup. Short tasks reserve at most half their budget. Increasing the budget gives a long task more execution time; it does not guarantee completion or semantic correctness.

The Dashboard uses the authenticated, same-origin `/api/activity/stream` for compact lifecycle invalidations. It reloads task snapshots, all already-loaded pages, provider execution records and an open detail view after changes; it also reconciles after reconnect, returning to a visible tab or going online. Four-second polling remains as a fallback. This does not add an external gateway or push to ChatGPT/DevSpace. `/api/agents?cached=1` refreshes execution records without pretending a cached version/auth probe is fresh; provider probes continue separately.

### DevSpace authenticated client

The existing control chain is `Founder → ChatGPT → DevSpace → Agent Control Center → executor`. DevSpace is an existing ChatGPT-to-local execution bridge; ACC does not maintain a ChatGPT session, push to ChatGPT, or start a second gateway. A DevSpace caller identifies itself with `origin: "devspace"` when using the local API contract. ChatGPT can create, inspect, wait, follow up, stop, and recover tasks through that path; results are returned when the client asks.

Register `server/devspace-mcp-server.mjs` as a local stdio MCP server in DevSpace with command `node`, argument `server/devspace-mcp-server.mjs`, and working directory set to the checkout. The adapter starts the local ACC service when needed, reads `auth.token` itself, and sends authenticated requests with `x-agent-control-origin: devspace`. The token is never part of the tool schema, prompt, or result.

The DevSpace surface exposes only the semantic `acc_*` operations needed by a GPT leader: health, agents, task create/list/get/wait/events/reply/stop, discussion create/get/events, and minutes generation. It forces `origin=devspace`; caller-supplied origin values are ignored. Keep `AGENT_CONTROL_DATA_DIR`, `AGENT_CONTROL_CONFIG`, `AGENT_CONTROL_ALLOWED_ROOTS`, and `AGENT_CONTROL_DEFAULT_CWD` in the local DevSpace process environment rather than in DevSpace configuration or GPT context.

### Provider-specific notes

The Tencent HTTP adapter follows the CodeBuddy jobs contract: it submits `POST /api/v1/jobs`, follows the job SSE stream, and uses the documented `X-CodeBuddy-Request: 1` header. Configure it with `WORKBUDDY_HTTP_URL` and, when required by the local gateway, `WORKBUDDY_HTTP_TOKEN`. The installed CLI name is `codebuddy`; if auto-detection is not applicable, set `AGENT_CONTROL_WORKBUDDY_COMMAND` to an explicit executable path.

For CLI tasks, the optional MCP `model` field is passed literally to the provider as `--model`; it is a provider-specific identifier, not a universal alias. Codex CLI defaults to `gpt-5.6-luna` with `model_reasoning_effort="max"`. WorkBuddy `2.106.4` defaults to the validated `hy4-preview` identifier, while an explicit caller model remains a literal provider-specific override.

WorkBuddy adapter receipts mechanically classify structured provider `tool_result` permission denials, including the provider's sandbox-shaped `Error: Write error: EPERM` form, even when the CLI exits zero. This is mechanical evidence only; semantic acceptance remains outside ACC.

### Data and follow-up behavior

Tasks, provider events, discussions, and minutes are stored in SQLite. The append-only `events.jsonl` and `minutes/*.md` files provide human-readable local records. A discussion runs up to three sequential critique rounds, with agents in each round receiving only bounded prior-round output. Stopping, provider failure, timeout, or service restart is represented in the record and is not reported as success.

Follow-up on a completed task reuses the same `taskId`, increments `attemptNo`, preserves the provider session reference when the adapter supports resume, and appends new observable events. This keeps cross-client lookup stable while provider-specific resume limitations remain visible.
