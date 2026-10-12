import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { argsForTaskScopedAntigravityApproval, cleanupTaskScopedAntigravityApproval, createTaskScopedAntigravityApproval } from "../server/antigravity-approval.mjs";
import { cleanupOrphanedAntigravityContainments, prepareAntigravityContainment } from "../server/antigravity-containment.mjs";
import { CliAdapter } from "../server/adapters.mjs";

test("isolates native command approvals without changing global or existing project settings", () => {
  const root = mkdtempSync(join(tmpdir(), "acc-approval-fixture-"));
  const projectsRoot = join(root, "projects");
  mkdirSync(projectsRoot);
  const existing = join(projectsRoot, "existing.json");
  const global = join(root, "settings.json");
  writeFileSync(existing, '{"permissions":"user-owned"}\n');
  writeFileSync(global, '{"toolPermission":"request-review"}\n');
  const originals = [readFileSync(existing), readFileSync(global)];
  try {
    let recorded;
    const first = createTaskScopedAntigravityApproval({ taskId: "task-a", cwd: root, projectsRoot, beforeCreate: (record) => {
      assert.equal(existsSync(record.path), false, "owner identity is persisted before the project file exists");
      recorded = record;
    } });
    const second = createTaskScopedAntigravityApproval({ taskId: "task-b", cwd: root, projectsRoot });
    assert.equal(recorded.id, first.id);
    assert.notEqual(first.id, second.id);
    assert.equal(statSync(first.path).mode & 0o777, 0o600);
    const project = JSON.parse(readFileSync(first.path, "utf8"));
    const grants = project.permissionGrants.permissionGrants;
    assert.equal(project.id, first.id);
    assert.deepEqual(project.projectResources.resources, [{ folderUri: pathToFileURL(realpathSync(root)).href }]);
    for (const command of ["git rev-parse", "git status", "git diff", "shasum", "rg"]) assert.ok(grants.allow.includes(`command(${command})`));
    assert.equal(grants.allow.includes("command(*)"), false);
    assert.equal(grants.allow.some((rule) => /command\((bash|sh|python|node)(?:\s|\))/.test(rule)), false);
    for (const rule of ["write_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)", "command(git push)", "command(git add)"]) assert.ok(grants.deny.includes(rule));
    cleanupTaskScopedAntigravityApproval(first, { projectsRoot });
    assert.equal(existsSync(first.path), false);
    assert.equal(existsSync(second.path), true);
    cleanupTaskScopedAntigravityApproval(first, { projectsRoot });
    cleanupTaskScopedAntigravityApproval(second, { projectsRoot });
    assert.deepEqual(readFileSync(existing), originals[0]);
    assert.deepEqual(readFileSync(global), originals[1]);
    assert.deepEqual(readdirSync(projectsRoot), ["existing.json"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("overrides only task project/sandbox arguments and rejects blanket permission bypass", () => {
  const record = { id: "task-native-project" };
  const args = argsForTaskScopedAntigravityApproval(["-p", "probe", "--project", "old", "--sandbox", "--model", "literal-model", "--new-project"], record);
  assert.deepEqual(args, ["-p", "probe", "--model", "literal-model", "--sandbox=false", "--project", record.id]);
  assert.deepEqual(argsForTaskScopedAntigravityApproval(["--project=old", "--sandbox=true", "--print", "probe"], record), ["--print", "probe", "--sandbox=false", "--project", record.id]);
  for (const literal of ["--project", "--sandbox", "--new-project", "--dangerously-skip-permissions"]) {
    assert.deepEqual(argsForTaskScopedAntigravityApproval(["--print", literal], record), ["--print", literal, "--sandbox=false", "--project", record.id]);
  }
  for (const arg of ["--dangerously-skip-permissions", "--dangerously-skip-permissions=true"]) {
    assert.throws(() => argsForTaskScopedAntigravityApproval(["-p", "probe", arg], record), /cannot bypass/);
  }
});

test("never deletes changed approval files, symlinks, or arbitrary cleanup targets", () => {
  const root = mkdtempSync(join(tmpdir(), "acc-approval-cleanup-"));
  const projectsRoot = join(root, "projects");
  try {
    const record = createTaskScopedAntigravityApproval({ taskId: "task-a", cwd: root, projectsRoot });
    const original = readFileSync(record.path);
    writeFileSync(record.path, '{"id":"user-edited"}');
    assert.throws(() => cleanupTaskScopedAntigravityApproval(record, { projectsRoot }), /changed/);
    assert.equal(existsSync(record.path), true);
    writeFileSync(record.path, original);
    assert.throws(() => cleanupTaskScopedAntigravityApproval({ ...record, path: join(root, "arbitrary.json") }, { projectsRoot }), /invalid/);
    rmSync(record.path);
    const outside = join(root, "user-owned.json");
    writeFileSync(outside, original);
    symlinkSync(outside, record.path);
    assert.throws(() => cleanupTaskScopedAntigravityApproval(record, { projectsRoot }), /regular file/);
    assert.deepEqual(readFileSync(outside), original);
    rmSync(record.path);
    symlinkSync(join(root, "missing.json"), record.path);
    assert.throws(() => cleanupTaskScopedAntigravityApproval(record, { projectsRoot }), /regular file/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reclaims approvals after an orphaned task but not a live owner's project", () => {
  const root = mkdtempSync(join(tmpdir(), "acc-approval-orphan-"));
  const projectsRoot = join(root, "projects");
  const taskRoot = join(root, "tasks");
  mkdirSync(taskRoot);
  try {
    const dead = createTaskScopedAntigravityApproval({ taskId: "dead", cwd: root, projectsRoot });
    const live = createTaskScopedAntigravityApproval({ taskId: "live", cwd: root, projectsRoot });
    for (const [record, pid] of [[dead, 0], [live, process.pid]]) {
      const task = join(taskRoot, record.taskId);
      mkdirSync(task);
      writeFileSync(join(task, "owner.json"), JSON.stringify({ pid, createdAt: 1, approvalProject: record }));
    }
    assert.equal(cleanupOrphanedAntigravityContainments({ root: taskRoot, projectsRoot, maxAgeMs: 0 }), 1);
    assert.equal(existsSync(dead.path), false);
    assert.equal(existsSync(live.path), true);
    cleanupTaskScopedAntigravityApproval(live, { projectsRoot });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("keeps an explicit require_approval request fail-closed in headless mode", async () => {
  const adapter = new CliAdapter("antigravity", { command: process.execPath, args: ["-e", "process.exit(99)"], permissionMapping: { strategy: "sandbox-exec-proxy" } });
  await assert.rejects(() => adapter.start({ taskId: "strict", cwd: process.cwd(), timeoutMs: 10000, prompt: "probe", permissionPolicy: { effective: { writeAllowed: false, networkAllowed: false, approvalPolicy: "require_approval", filesystemScope: [process.cwd()] } } }, () => {}), (error) => error.preflight?.code === "antigravity_headless_approval_required");
});

test("approved read-only Git executes inside ACC while writes, sensitive reads and network remain denied", async (t) => {
  if (process.platform !== "darwin") { t.skip("macOS containment fixture"); return; }
  const root = mkdtempSync(join(tmpdir(), "acc-readonly-git-"));
  const cwd = join(root, "repository");
  mkdirSync(cwd);
  const fixtureEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  assert.equal(spawnSync("git", ["init", "-q"], { cwd, env: fixtureEnv }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture"], { cwd, env: fixtureEnv }).status, 0);
  writeFileSync(join(cwd, ".env"), "disposable-secret");
  const projectsRoot = join(root, "projects");
  let containment;
  try {
    containment = await prepareAntigravityContainment({ taskId: "git-read", cwd, command: "/bin/sh", permissionPolicy: { effective: { writeAllowed: false, networkAllowed: false, filesystemScope: [cwd] } }, config: { taskRoot: join(root, "tasks"), projectsRoot } });
    const run = (command) => spawnSync("/usr/bin/sandbox-exec", ["-f", containment.profilePath, "/bin/sh", "-c", command], { cwd, env: { ...fixtureEnv, ...containment.env }, encoding: "utf8", timeout: 10000 });
    const read = run("git rev-parse HEAD && git status --short && git diff --cached --stat");
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, /^[0-9a-f]{40}/);
    assert.notEqual(run("printf denied > blocked.txt").status, 0);
    assert.equal(existsSync(join(cwd, "blocked.txt")), false);
    assert.notEqual(run("cat .env").status, 0);
    assert.notEqual(run("curl --max-time 2 -s http://example.com").status, 0);
    assert.equal(existsSync(join(projectsRoot, `${containment.permissionReceipt.headlessApproval.projectId}.json`)), true);
    const receipt = await containment.cleanup("test");
    assert.equal(receipt.approvalProjectState, "removed");
    assert.deepEqual(readdirSync(projectsRoot), []);
  } finally { await containment?.cleanup("test"); rmSync(root, { recursive: true, force: true }); }
});

test("cleans approval projects on spawn error without mutating the workspace", async (t) => {
  if (process.platform !== "darwin") { t.skip("macOS containment fixture"); return; }
  const root = mkdtempSync(join(tmpdir(), "acc-approval-spawn-"));
  const projectsRoot = join(root, "projects");
  const adapter = new CliAdapter("antigravity", { command: "/bin/sh", args: ["--dangerously-skip-permissions"], permissionMapping: { strategy: "sandbox-exec-proxy", taskRoot: join(root, "tasks"), projectsRoot } });
  try {
    await assert.rejects(() => adapter.start({ taskId: "spawn-error", cwd: root, timeoutMs: 10000, prompt: "probe", permissionPolicy: { effective: { writeAllowed: false, networkAllowed: false, filesystemScope: [root] } } }, () => {}), /cannot bypass/);
    assert.deepEqual(readdirSync(projectsRoot), []);
    assert.deepEqual(readdirSync(join(root, "tasks")), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
