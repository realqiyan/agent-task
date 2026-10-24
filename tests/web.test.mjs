import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, realpathSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../dist/configuration/files.js";
import { TaskStore } from "../dist/tasks/storage/store.js";
import { createTaskRuntime } from "../dist/application/task-runtime.js";
import { createExecution } from "../dist/integrations/acp/execution.js";
const openExecution = createExecution({ PATH: "/usr/bin:/bin" });
const executorTypes = ["pi", "codex", "claude", "opencode"];
import { createCoordinator } from "../dist/integrations/coordinator/coordinator.js";
import { taskSchema } from "../dist/protocol/task-contract.js";

async function start(t, home) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", 'import {launch} from "./dist/application/launcher.js"; await launch(process.argv[1], process.env);', home],
    { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
  const closed = new Promise(resolve => child.once("close", resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
    try { await closed; } finally { clearTimeout(timer); }
  };
  t.after(stop);
  for (let i = 0; i < 100; i++) {
    const line = stdout.split("\n").find(line => line.includes('"event":"ready"'));
    if (line) return { origin: new URL(JSON.parse(line).url).origin, stop, logs: () => stdout + stderr };
    if (child.exitCode !== null) throw new Error("Service exited before ready: " + stderr);
    await delay(100);
  }
  throw new Error("Service startup timed out");
}
test("Web and CLI share task/configuration rules, preserve HTTP boundaries and apply settings only after restart", { timeout: 60000 }, async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-web-"));
  const dataDir = join(root, "data"); mkdirSync(dataDir, { mode: 0o700 });
  writeFileSync(join(root, "launch.json"), JSON.stringify({ dataDir }), { mode: 0o600 });
  const configPath = join(dataDir, "config.json"), environmentPath = join(dataDir, "environment.json");
  const secrets = Array.from({ length: 4 }, () => randomBytes(32).toString("hex"));
  const [mcpToken, adminToken, oldKey, newKey] = secrets;
  const environment = { AGENT_TASK_TOKEN: mcpToken, AGENT_TASK_ADMIN_TOKEN: adminToken, OPENAI_API_KEY: oldKey };
  writeFileSync(environmentPath, JSON.stringify(environment), { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ dataDir: join(root, "data"), port: 0,
    coordinator: { provider: "openai", model: "not-a-real-model" },
    disabledExecutors: executorTypes }), { mode: 0o600 });
  const config = loadConfig(configPath), store = new TaskStore(config.dataDir);
  const executor = { id: "local", type: "codex", nativePath: "/usr/bin/false", command: "/usr/bin/false", args: [], adapterVersion: null };
  const service = createTaskRuntime(config.dataDir, [executor], openExecution,
    createCoordinator(config.dataDir, config.coordinator), error => { throw error; });
  const now = Math.floor(Date.now() / 60_000) * 60_000, name = '<img src="https://untrusted.invalid" onerror="alert(1)">';
  const task = service.definitions.create(taskSchema.parse({ requestKey: "web-boundary", name, prompt: "Inspect", workspace: root,
    nodes: [{ id: "inspect", prompt: "Inspect", executorId: "local" }],
    schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" } }), now - 1);
  service.runs.trigger(now);
  const run = service.runs.list(task.id).items[0];
  service.supervisor.actions(run.id).ask({ question: "Which source?", completedWork: "None" });
  await service.close(); store.close();
  const children = [];
  t.after(async () => {
    for (const child of children) {
      await child.stop();
      for (const secret of secrets) assert(!child.logs().includes(secret), "credentials must not appear in service logs");
    }
    rmSync(root, { recursive: true, force: true });
  });
  let child = await start(t, root); children.push(child);
  const raw = (path, options = {}) => fetch(child.origin + "/admin" + path, {
    ...options, headers: { Authorization: "Bearer " + adminToken, ...options.headers },
  });
  const call = async (path, body) => {
    const response = await raw("/api" + path, body === undefined ? {} : {
      method: "POST", headers: { Origin: child.origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result.data;
  };
  const invoke = (args, input) => {
    const result = spawnSync(process.execPath, [resolve("bin/agent-task.mjs"), ...args, "--home", root, "--json"],
      { input, encoding: "utf8", timeout: 15000 });
    for (const secret of secrets) assert(!(result.stdout + result.stderr).includes(secret), "CLI must not print credentials");
    return result;
  };
  const cliCall = (...args) => {
    const result = invoke(args);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const shell = await fetch(child.origin + "/admin/");
  assert.equal(shell.status, 200);
  assert.match(shell.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(shell.headers.get("cache-control"), "no-store");
  assert.equal(shell.headers.get("set-cookie"), null);
  const script = await fetch(child.origin + "/admin/app.js");
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type"), /javascript/);
  const html = await shell.text();
  for (const secret of secrets) assert(!html.includes(secret));
  assert(!html.includes(name), "business data must not be embedded in the public shell");
  assert.equal((await fetch(child.origin + "/admin/api/tasks")).status, 401);
  assert.equal((await raw("/API/tasks", { headers: { Authorization: "Bearer " + mcpToken } })).status, 401);
  // Node fetch normalizes Host; use the actual HTTP client for a hostile authority header.
  assert.equal(await new Promise((resolve, reject) => {
    const request = httpRequest(child.origin + "/admin/api/tasks", { headers: { Host: "untrusted.invalid", Authorization: "Bearer " + adminToken } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on("error", reject); request.end();
  }), 403);
  assert.equal((await raw("/api/tasks", { headers: { Origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal((await raw("/api/tasks", { headers: { "Sec-Fetch-Site": "same-site" } })).status, 403);
  for (const origin of [undefined, "null", "https://untrusted.invalid"]) {
    assert.equal((await raw("/api/task-update", { method: "POST", headers: {
      "Content-Type": "application/json", ...(origin === undefined ? {} : { Origin: origin }),
    }, body: JSON.stringify({ id: task.id, action: "cancel" }) })).status, 403);
  }
  assert.equal((await raw("/api/task-update", { method: "POST", headers: { Origin: child.origin, "Content-Type": "application/x-www-form-urlencoded" }, body: "action=cancel" })).status, 415);
  assert.equal((await raw("/api/task-update", { method: "OPTIONS", headers: { Origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal((await fetch(child.origin + "/mcp", { method: "POST", headers: { Authorization: "Bearer " + mcpToken, Origin: child.origin } })).status, 403);
  assert.equal((await fetch(child.origin + "/mcp", { method: "POST", headers: { Authorization: "Bearer " + adminToken } })).status, 401);
  assert.equal((await call("/tasks")).items[0].name, name);
  const currentRun = await call("/runs/" + run.id);
  assert.deepEqual(cliCall("task", "show", task.id), await call("/tasks/" + task.id));
  assert.deepEqual(cliCall("run", "show", run.id), currentRun);
  assert.deepEqual(cliCall("task", "list", "--after", "0", "--limit", "1"), await call("/tasks?after=0&limit=1"));
  assert.deepEqual(cliCall("run", "list", "--task", task.id), await call("/runs?taskId=" + task.id));
  assert.notEqual(invoke(["task", "pause", task.id]).status, 0, "noninteractive changes require explicit confirmation");
  for (const [action, status] of [["pause", "paused"], ["resume", "active"], ["cancel", "cancelled"]]) {
    const updated = action === "pause" ? await call("/task-update", { id: task.id, action }) : cliCall("task", action, task.id, "--yes");
    assert.equal(updated.status, status);
    assert.equal((await call("/tasks/" + task.id)).status, status);
    assert.deepEqual(await call("/runs/" + run.id), currentRun);
  }
  for (const path of ["/api/tasks", "/api/task-create", "/api/task-run-reply", "/api/runs/" + run.id + "/cancel"]) {
    assert.equal((await raw(path, { method: "POST", headers: { Origin: child.origin, "Content-Type": "application/json" }, body: "{}" })).status, 404);
  }
  let settings = await call("/settings");
  const before = readFileSync(configPath, "utf8");
  const invalid = await raw("/api/settings/config", { method: "POST", headers: { Origin: child.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ editToken: settings.editToken, config: { ...settings.saved, disabledExecutors: ["arbitrary-command"] } }) });
  assert.equal(invalid.status, 400); assert.equal(readFileSync(configPath, "utf8"), before);
  const malformed = await raw("/api/settings/credential", { method: "POST", headers: { Origin: child.origin, "Content-Type": "application/json" }, body: '{"value":"' + newKey + '"' });
  assert.equal(malformed.status, 400); assert(!(await malformed.text()).includes(newKey));
  settings = await call("/settings/credential", { editToken: settings.editToken, key: "OPENAI_API_KEY", action: "replace", value: newKey });
  for (const secret of secrets) assert(!JSON.stringify(settings).includes(secret));
  assert.equal(settings.credentials.find(item => item.key === "OPENAI_API_KEY").pendingRestart, true);
  assert.deepEqual(cliCall("config", "show", "--running"), settings.running);
  assert.deepEqual(cliCall("credential", "list"), settings.credentials);
  const draftPath = join(root, "draft.json");
  cliCall("config", "export", "--output", draftPath);
  assert.equal(statSync(draftPath).mode & 0o777, 0o600);
  assert.notEqual(invoke(["config", "export", "--output", draftPath]).status, 0, "export never overwrites user files");
  const draft = JSON.parse(readFileSync(draftPath, "utf8"));
  draft.config.disabledExecutors = executorTypes.filter(type => type !== "codex");
  writeFileSync(draftPath, JSON.stringify(draft));
  const preview = cliCall("config", "validate", "--file", draftPath);
  assert.deepEqual(preview, await call("/settings/validate", draft));
  assert.equal(preview.changes[0].field, "disabledExecutors");
  assert.equal(cliCall("config", "apply", "--file", draftPath, "--yes").pendingRestart, true);
  assert.deepEqual(cliCall("config", "show"), (await call("/settings")).saved);
  assert.notEqual(invoke(["config", "apply", "--file", draftPath, "--yes"]).status, 0, "stale drafts cannot overwrite changes");
  const discovered = await call("/executors");
  assert.deepEqual(cliCall("executor", "list"), discovered);
  assert(discovered.executors.every(executor => executor.state === "disabled"));
  assert.deepEqual(cliCall("executor", "show", "codex"), discovered.executors.find(executor => executor.id === "codex"));
  assert.deepEqual(cliCall("executor", "refresh"), await call("/executors/refresh", {}));
  assert.notEqual(invoke(["executor", "upgrade", "codex", "--yes"]).status, 0, "disabled executors cannot install or upgrade adapters");
  cliCall("executor", "enable", "pi", "--yes");
  assert(!(await call("/settings")).saved.disabledExecutors.includes("pi"));
  assert.equal(cliCall("executor", "show", "pi").state, "disabled", "saved enablement must not change live discovery");
  cliCall("executor", "disable", "pi", "--yes");
  assert((await call("/settings")).saved.disabledExecutors.includes("pi"));
  const savedCredential = invoke(["credential", "set", "EXTRA_API_KEY", "--stdin", "--yes"], newKey + "\n");
  assert.equal(savedCredential.status, 0, savedCredential.stderr);
  const rejectedCredential = invoke(["credential", "set", "AGENT_TASK_ADMIN_TOKEN", "--stdin", "--yes"], newKey);
  assert.notEqual(rejectedCredential.status, 0);
  cliCall("coordinator", "set", "--provider", "openai-compatible", "--model", "example", "--base-url", "https://untrusted.invalid/v1",
    "--api-key-env", "EXTRA_API_KEY", "--context-window", "4096", "--max-tokens", "1024", "--reasoning", "false", "--yes");
  assert.deepEqual(cliCall("coordinator", "show"), (await call("/settings")).saved.coordinator);
  assert.notEqual(invoke(["credential", "delete", "EXTRA_API_KEY", "--yes"]).status, 0, "referenced credentials cannot be deleted");
  cliCall("coordinator", "clear", "--yes");
  assert.equal(cliCall("coordinator", "show"), null);
  cliCall("credential", "delete", "EXTRA_API_KEY", "--yes");
  cliCall("coordinator", "set", "--provider", "openai", "--model", "not-a-real-model", "--yes");
  assert.equal(cliCall("status").settings.pendingRestart, true);
  assert(cliCall("config", "diff").changes.some(change => change.field === "disabledExecutors"));
  settings = await call("/settings");
  const changed = structuredClone(settings.saved);
  changed.disabledExecutors = executorTypes;
  const input = { editToken: settings.editToken, config: changed };
  assert.deepEqual((await call("/settings/validate", input)).affectedTasks.map(item => item.id), [task.id]);
  settings = await call("/settings/config", input);
  assert.deepEqual(settings.running.disabledExecutors, executorTypes);
  assert.equal((await call("/status")).settings.pendingRestart, true);
  assert.deepEqual((await call("/tasks/" + task.id)).executors.local, executor);
  const previous = (await call("/status")).instanceId;
  const restarted = await call("/restart", {});
  assert.notEqual(restarted.instanceId, previous);
  child.origin = new URL(restarted.url).origin;
  settings = await call("/settings");
  assert.deepEqual(settings.running.disabledExecutors, executorTypes);
  assert((await call("/executors")).executors.every(executor => executor.state === "disabled"));
  assert.equal(settings.pendingRestart, false);
  assert.equal(settings.credentials.find(item => item.key === "OPENAI_API_KEY").pendingRestart, false);
  assert.equal((await call("/runs/" + run.id)).status, "waiting_input");
  // CLI restarts the same foreground launcher, including token name and dataDir changes.
  const next = join(root, "next");
  settings = await call("/settings/config", { editToken: settings.editToken,
    config: { ...settings.saved, dataDir: next, port: 0, tokenEnv: "RENAMED_SERVICE_TOKEN" } });
  const cli = JSON.parse(execFileSync(process.execPath, [resolve("bin/agent-task.mjs"), "restart", "--home", root], { encoding: "utf8" }));
  assert.notEqual(cli.instanceId, restarted.instanceId);
  child.origin = new URL(cli.url).origin;
  settings = await call("/settings");
  assert.equal(settings.running.dataDir, next);
  assert.equal(settings.running.tokenEnv, "RENAMED_SERVICE_TOKEN");
  assert.equal(settings.pendingRestart, false);
  assert.equal((await call("/tasks")).items.length, 0, "history is not copied to the selected directory");
  for (const file of ["config.json", "environment.json", "tasks.sqlite", "service.log"]) assert(existsSync(join(next, file)));
  assert(existsSync(join(dataDir, "tasks.sqlite")), "old history must remain");
  assert.equal(JSON.parse(readFileSync(join(next, "environment.json"), "utf8")).RENAMED_SERVICE_TOKEN, mcpToken);
  await child.stop();
  const stoppedConfig = readFileSync(join(next, "config.json"), "utf8");
  assert.notEqual(invoke(["executor", "enable", "codex", "--yes"]).status, 0);
  assert.equal(readFileSync(join(next, "config.json"), "utf8"), stoppedConfig, "offline fallback must not write configuration");
  // Return the locator offline only for the admin-disabled boundary check.
  writeFileSync(join(root, "launch.json"), JSON.stringify({ dataDir }));
  writeFileSync(configPath, JSON.stringify({ ...changed, dataDir }));
  delete environment.AGENT_TASK_ADMIN_TOKEN;
  writeFileSync(environmentPath, JSON.stringify(environment));
  child = await start(t, root); children.push(child);
  assert.equal((await raw("/api/tasks")).status, 404);
});
