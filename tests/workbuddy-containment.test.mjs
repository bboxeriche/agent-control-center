import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareWorkBuddyContainment } from "../server/workbuddy-containment.mjs";

test("WorkBuddy uses task-local temporary files without granting global trace or private-key access", async t => {
  if (process.platform !== "darwin") return t.skip("sandbox-exec regression is macOS-specific");
  const root = mkdtempSync(join(tmpdir(), "acc-workbuddy-runtime-"));
  const scope = join(root, "scope"); mkdirSync(scope);
  const privateKey = join(scope, "synthetic-private.key"); writeFileSync(privateKey, "synthetic test data");
  const home = join(root, "fake-home"); mkdirSync(home);
  const containment = await prepareWorkBuddyContainment({
    cwd: scope, command: "/bin/zsh",
    permissionPolicy: { effective: { writeAllowed: false, networkAllowed: false, filesystemScope: [scope] } },
    config: { taskRoot: join(root, "tasks"), homeDir: home },
  });
  const run = (command, args) => spawnSync(containment.sandboxExecutable, ["-f", containment.profilePath, command, ...args], {
    env: { ...process.env, ...containment.env }, encoding: "utf8", timeout: 10000,
  });
  try {
    assert.equal(containment.env.CODEBUDDY_DISABLE_TRACE_COLLECTOR, "1");
    assert.equal(containment.permissionReceipt.providerTraceCollection, "disabled-task-env");
    const text = "t".repeat(20000);
    const heredoc = run("/bin/zsh", ["-dfc", `/bin/cat <<'ACC_EOF'\n${text}\nACC_EOF\n`]);
    assert.equal(heredoc.status, 0, heredoc.stderr);
    assert.equal(heredoc.stdout, text + "\n");
    assert.equal(run("/usr/bin/stat", ["-f", "%z", "/etc/ssl/cert.pem"]).status, 0);
    assert.notEqual(run("/bin/cat", [privateKey]).status, 0);
    const tracePath = join(home, ".codebuddy", "traces");
    assert.notEqual(run("/bin/mkdir", ["-p", tracePath]).status, 0);
    assert.equal(existsSync(tracePath), false);
    const output = join(scope, "forbidden-write");
    assert.notEqual(run("/bin/zsh", ["-dfc", `print no > ${JSON.stringify(output)}`]).status, 0);
    assert.equal(existsSync(output), false);
  } finally {
    await containment.cleanup("test"); rmSync(root, { recursive: true, force: true });
  }
});
