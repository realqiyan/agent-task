import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../dist/config.js";
import { TaskStore } from "../dist/task-storage.js";
import { Tasks } from "../dist/tasks.js";
import { Results } from "../dist/results.js";
import { openExecution } from "../dist/node-execution.js";
import { createCoordinator } from "../dist/coordinator.js";
import { taskSchema } from "../dist/task-contract.js";

async function start(t, configPath, environmentPath) {
  const child = spawn(process.execPath, [resolve("dist/main.js"), "--config", configPath, "--environment", environmentPath],
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
test("console enforces its HTTP boundary, restricts task writes and applies private settings only after restart", { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-web-"));
  const configPath = join(root, "config.json"), environmentPath = join(root, "environment.json");
  const secrets = Array.from({ length: 4 }, () => randomBytes(32).toString("hex"));
  const [mcpToken, adminToken, oldKey, newKey] = secrets;
  const environment = { AGENT_TASK_TOKEN: mcpToken, AGENT_TASK_ADMIN_TOKEN: adminToken, OPENAI_API_KEY: oldKey };
  writeFileSync(environmentPath, JSON.stringify(environment), { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ dataDir: join(root, "data"), port: 0,
    coordinator: { provider: "openai", model: "not-a-real-model" },
    executors: [{ id: "local", command: "/usr/bin/false", cwd: root, unattendedApproved: true }] }), { mode: 0o600 });
  const config = loadConfig(configPath), store = new TaskStore(config.dataDir);
  const service = new Tasks(store, config.executors, new Results(config.dataDir), openExecution,
    createCoordinator(config.dataDir, config.coordinator), error => { throw error; });
  const now = Date.now(), name = '<img src="https://untrusted.invalid" onerror="alert(1)">';
  const task = service.create(taskSchema.parse({ requestKey: "web-boundary", name, prompt: "Inspect",
    nodes: [{ id: "inspect", prompt: "Inspect", executorId: "local" }],
    schedule: { type: "interval", startAt: new Date(now - 1000).toISOString(), seconds: 600 } }), now - 2000);
  service.trigger(now);
  const run = service.runs(task.id).items[0];
  service.actions(run.id).ask({ question: "Which source?", completedWork: "None" });
  await service.close(); store.close();
  const children = [];
  t.after(async () => {
    for (const child of children) {
      await child.stop();
      for (const secret of secrets) assert(!child.logs().includes(secret), "credentials must not appear in service logs");
    }
    rmSync(root, { recursive: true, force: true });
  });
  let child = await start(t, configPath, environmentPath); children.push(child);
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
  for (const [action, status] of [["pause", "paused"], ["resume", "active"], ["cancel", "cancelled"]]) {
    assert.equal((await call("/task-update", { id: task.id, action })).status, status);
    assert.deepEqual(await call("/runs/" + run.id), currentRun);
  }
  for (const path of ["/api/tasks", "/api/task-create", "/api/task-run-reply", "/api/runs/" + run.id + "/cancel"]) {
    assert.equal((await raw(path, { method: "POST", headers: { Origin: child.origin, "Content-Type": "application/json" }, body: "{}" })).status, 404);
  }
  let settings = await call("/settings");
  const before = readFileSync(configPath, "utf8");
  const invalid = await raw("/api/settings/config", { method: "POST", headers: { Origin: child.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ editToken: settings.editToken, config: { executors: [{ id: "bad", command: "/absent", cwd: root }] } }) });
  assert.equal(invalid.status, 400); assert.equal(readFileSync(configPath, "utf8"), before);
  const malformed = await raw("/api/settings/credential", { method: "POST", headers: { Origin: child.origin, "Content-Type": "application/json" }, body: '{"value":"' + newKey + '"' });
  assert.equal(malformed.status, 400); assert(!(await malformed.text()).includes(newKey));
  settings = await call("/settings/credential", { editToken: settings.editToken, key: "OPENAI_API_KEY", action: "replace", value: newKey });
  for (const secret of secrets) assert(!JSON.stringify(settings).includes(secret));
  assert.equal(settings.credentials.find(item => item.key === "OPENAI_API_KEY").pendingRestart, true);
  const changed = { executors: structuredClone(settings.saved.executors), coordinator: settings.saved.coordinator };
  changed.executors[0].permissionAllowlist = ["read"];
  const input = { editToken: settings.editToken, config: changed };
  assert.deepEqual((await call("/settings/validate", input)).affectedTasks.map(item => item.id), [task.id]);
  settings = await call("/settings/config", input);
  assert.deepEqual(settings.running.executors[0].permissionAllowlist, []);
  assert.equal((await call("/status")).settings.pendingRestart, true);
  assert.deepEqual((await call("/tasks/" + task.id)).executors.local.permissionAllowlist, []);
  await child.stop();
  child = await start(t, configPath, environmentPath); children.push(child);
  settings = await call("/settings");
  assert.deepEqual(settings.running.executors[0].permissionAllowlist, ["read"]);
  assert.equal(settings.pendingRestart, false);
  assert.equal(settings.credentials.find(item => item.key === "OPENAI_API_KEY").pendingRestart, false);
  assert.equal((await call("/runs/" + run.id)).status, "waiting_input");
  await child.stop();
  delete environment.AGENT_TASK_ADMIN_TOKEN;
  writeFileSync(environmentPath, JSON.stringify(environment));
  child = await start(t, configPath, environmentPath); children.push(child);
  assert.equal((await raw("/api/tasks")).status, 404);
});
