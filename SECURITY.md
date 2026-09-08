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
