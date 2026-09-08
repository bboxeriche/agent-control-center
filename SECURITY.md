# Security policy

## Scope and trust model

Agent Control Center (ACC) is a local control plane. Its intended trust
boundary is one user account on one host: the local API binds to loopback,
requires the generated bearer token, and accepts only registered provider
commands from configuration. DevSpace is an existing caller path; ACC does
not add a public gateway or a push channel.

Tasks are the durable execution identity. ACC records the requested policy,
the control-plane ceiling, provider capability snapshot, execution-profile
preflight, provider facts, and cleanup receipt. These records are evidence of
what ACC requested and what the adapter mechanically observed; they are not a
claim that a model's answer is correct or that a product-level acceptance gate
has passed.

## Antigravity boundary

Antigravity 1.1.27 does not expose a safe per-process native permission
override. ACC therefore reports native permission mapping as unavailable and,
when configured on macOS, uses a task-scoped `sandbox-exec` profile and local
network proxy. The fallback is finite and fail-closed: read-only,
network-only, and bounded-write-plus-network profiles are preflighted; a
bounded-write/no-network request is rejected before provider spawn because
Antigravity's headless network tool can escape the child-process path.

The fallback never edits persistent Antigravity settings. Writes are scoped to
the canonical task scope, network requests are routed through the task proxy,
common credential-shaped paths are denied by default, and the profile/proxy
are removed after completion, stop, error, or timeout. File reads remain broad
because the provider aborts during startup when narrow read subpaths are used;
this limitation is included in capability receipts.

## Tencent WorkBuddy boundary

WorkBuddy/CodeBuddy `2.106.4` is invoked with the per-run
`--permission-mode bypassPermissions` option only inside the ACC task-scoped
external containment path. The provider option bypasses headless approval UX;
it is not treated as a security boundary and ACC does not modify WorkBuddy
global settings or persistent project permissions. Contained CLI runs restrict
the provider tool surface to `Read`, `Write`, `Edit`, `Bash`, `Glob`, and `Grep`.
Remote `WebFetch` and `WebSearch` are excluded because their execution is not
inside the local ACC network boundary. Network-enabled probes therefore use
local `Bash` traffic through the task proxy. The provider transport hosts are
allowlisted separately so the model session can remain alive while task
network access is denied. WorkBuddy normalizes the proxy URL to `127.0.0.1`,
so its seatbelt profile uses a loopback wildcard for the proxy connection; the
task proxy still rejects local targets and non-allowlisted hosts when traffic
uses the proxy, but the compatibility wildcard also permits a direct provider
`Bash` connection to another local-loopback port. This is a provider-specific
local-service isolation limitation compared with Antigravity's exact-port rule;
ACC does not claim complete local-loopback isolation for WorkBuddy.

The default WorkBuddy model is the explicit `hy4-preview` identifier. Health
and task receipts distinguish the default, validated, requested, resolved, and
provider-reported actual model values. WorkBuddy HTTP jobs are reported as
`http-endpoint-unqualified`; a remote HTTP endpoint is not represented as
locally contained. WorkBuddy provider-managed runtime files are not deleted by
ACC cleanup; only the ACC-owned task directory and proxy are cleaned.

## Reporting a vulnerability

Private vulnerability reporting is enabled for this repository. Use the
[private vulnerability report form](https://github.com/bboxeriche/agent-control-center/security/advisories/new).
Do not include real credentials, private keys, tokens, customer data, or
production repositories in a report or disposable fixture. Include:

- a concise description and impact;
- the ACC commit, operating system, Node.js version, and provider version;
- reproducible steps using a disposable directory;
- relevant task IDs and redacted event/receipt output; and
- a proposed mitigation, if available.

If the private report form is unavailable, open a minimal public issue that
contains no exploit details or sensitive data and asks the maintainer for a
private channel.

## Operational guidance

- Keep ACC on `127.0.0.1`; do not expose port `47770` directly to a network.
- Protect the data directory and `auth.token` with the local account's normal
  filesystem permissions.
- Treat `UNSUPPORTED`, `limited`, provider-denied actions, non-zero exits, and
  cleanup failures as failures requiring review.
- Use only disposable fixtures for sensitive-path and containment tests.
- Do not use `--dangerously-skip-permissions` outside ACC's verified external
  containment path.
- Treat any WorkBuddy profile that reports `UNSUPPORTED`, any HTTP endpoint
  path, and any attempt to re-enable `WebFetch`/`WebSearch` in contained runs
  as fail-closed conditions requiring review.
