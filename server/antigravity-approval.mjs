import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ANTIGRAVITY_READ_ONLY_COMMANDS = Object.freeze([
  "git rev-parse", "git status", "git diff", "git log", "git show", "git ls-files",
  "ls", "rg", "grep", "cat", "head", "tail", "wc", "shasum", "sha256sum",
]);
const MUTATING_GIT_COMMANDS = ["init", "add", "commit", "push", "fetch", "pull", "reset", "checkout", "switch", "restore", "clean", "merge", "rebase", "cherry-pick", "am", "apply", "stash", "update-ref", "config", "branch", "tag"];
export const ANTIGRAVITY_READ_ONLY_DENY_RULES = Object.freeze([
  "write_file(*)", "read_url(*)", "execute_url(*)", "mcp(*)",
  ...MUTATING_GIT_COMMANDS.map((command) => `command(git ${command})`),
  ...MUTATING_GIT_COMMANDS.map((command) => `command(git --no-optional-locks ${command})`),
]);

export function antigravityProjectsRoot() {
  return join(homedir(), ".gemini", "config", "projects");
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function createTaskScopedAntigravityApproval({ taskId, cwd, projectsRoot = antigravityProjectsRoot(), beforeCreate = () => {} }) {
  mkdirSync(projectsRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(projectsRoot);
  const id = randomUUID();
  const path = join(root, `${id}.json`);
  const canonicalCwd = realpathSync(cwd);
  const name = `ACC task approval ${taskId}`;
  const grants = [
    ...ANTIGRAVITY_READ_ONLY_COMMANDS.map((command) => `command(${command})`),
    ...ANTIGRAVITY_READ_ONLY_COMMANDS.filter((command) => command.startsWith("git "))
      .map((command) => `command(git --no-optional-locks ${command.slice(4)})`),
  ];
  // A fresh project adds only these explicit approvals. Existing global/shared
  // deny/ask rules still take precedence; never edit or bypass them. The outer
  // ACC sandbox remains authoritative even for inherited command grants.
  const project = {
    id, name,
    projectResources: { resources: [{ folderUri: pathToFileURL(canonicalCwd).href }] },
    permissionGrants: { permissionGrants: { allow: grants, deny: [...ANTIGRAVITY_READ_ONLY_DENY_RULES], ask: [] } },
    settings: {
      fileAccessPolicy: "AGENT_SETTING_POLICY_ASK",
      internetPolicy: "AGENT_SETTING_POLICY_ASK",
      autoExecutionPolicy: "CASCADE_COMMANDS_AUTO_EXECUTION_OFF",
      artifactReviewMode: "ARTIFACT_REVIEW_MODE_ALWAYS",
    },
    isWorkspaceOnly: true,
  };
  const bytes = JSON.stringify(project) + "\n";
  const record = { id, path, projectsRoot: root, name, taskId, sha256: digest(bytes), approvedCommands: [...ANTIGRAVITY_READ_ONLY_COMMANDS] };
  // Persist the owner marker first so a crash between the two writes cannot
  // orphan an approval project without a recoverable cleanup identity.
  beforeCreate(record);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return record;
}

export function cleanupTaskScopedAntigravityApproval(record, { projectsRoot = antigravityProjectsRoot() } = {}) {
  if (!record) return;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const root = existsSync(projectsRoot) ? realpathSync(projectsRoot) : resolve(projectsRoot);
  if (!uuid.test(record.id) || dirname(record.path) !== root || basename(record.path) !== `${record.id}.json`
    || record.projectsRoot !== root || record.name !== `ACC task approval ${record.taskId}`) {
    throw new Error("invalid task-scoped Antigravity approval cleanup target");
  }
  let stat;
  try { stat = lstatSync(record.path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (!stat.isFile()) throw new Error("task-scoped Antigravity approval is no longer a regular file");
  const bytes = readFileSync(record.path);
  const project = JSON.parse(bytes.toString("utf8"));
  if (project.id !== record.id || project.name !== record.name || digest(bytes) !== record.sha256) {
    throw new Error("task-scoped Antigravity approval changed; preserving it for manual review");
  }
  unlinkSync(record.path);
}

export function argsForTaskScopedAntigravityApproval(providerArgs, record) {
  const valueFlags = new Set(["-p", "--print", "--prompt", "-i", "--prompt-interactive", "--model", "--effort", "--agent", "--conversation", "--add-dir", "--mode", "--input-format", "--output-format", "--json-schema", "--log-file", "--print-timeout"]);
  const args = [];
  for (let index = 0; index < providerArgs.length; index += 1) {
    const arg = providerArgs[index];
    if (valueFlags.has(arg)) {
      args.push(arg);
      if (index + 1 < providerArgs.length) args.push(providerArgs[++index]);
      continue;
    }
    if (/^--dangerously-skip-permissions(?:=|$)/.test(arg)) {
      throw new Error("read-only Antigravity cannot bypass tool permissions");
    }
    if (arg === "--project") { index += 1; continue; }
    if (/^--project=/.test(arg) || /^--sandbox(?:=|$)/.test(arg)) continue;
    if (arg === "--new-project" || /^--new-project=/.test(arg)) continue;
    args.push(arg);
  }
  // macOS will not apply agy's second Seatbelt sandbox inside ACC's sandbox.
  // Keep the outer kernel boundary; disable only the redundant inner layer.
  return [...args, "--sandbox=false", "--project", record.id];
}
