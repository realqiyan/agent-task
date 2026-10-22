import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { TaskStore } from "../dist/task-storage.js";
import { Tasks } from "../dist/tasks.js";
import { Results } from "../dist/results.js";
import { createExecution } from "../dist/node-execution.js";
import { createCoordinator } from "../dist/coordinator.js";
import { executorSchema } from "../dist/model.js";
import { taskSchema } from "../dist/task-contract.js";

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
test("foreground CLI and Web restart on the same port verify a new process; failed startup stays unavailable and uncertain work never replays", { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-restart-")), home = join(root, "private"), workspace = join(root, "workspace");
  mkdirSync(workspace);
  const cli = resolve("bin/agent-task.mjs"), env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const invoke = (...args) => execFileSync(process.execPath, [cli, ...args, "--home", home], { env, encoding: "utf8", stdio: "pipe" });
  const reservation = createServer(), port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  invoke("setup", "--executors", "none", "--cwd", workspace, "--port", String(port), "--prepare-only");
  const dataDir = join(home, "data"), configPath = join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")), secrets = JSON.parse(readFileSync(join(dataDir, "environment.json"), "utf8"));
  const executor = executorSchema.parse({ id: "local", type: "codex", cwd: workspace, unattendedApproved: true });
  const store = new TaskStore(dataDir), tasks = new Tasks(store, [executor], new Results(dataDir), createExecution({ PATH: "/missing" }),
    createCoordinator(dataDir, { provider: "openai", model: "not-a-real-model" }), error => { throw error; });
  const now = Date.now();
  const task = tasks.create(taskSchema.parse({ requestKey: "uncertain", name: "uncertain", prompt: "Inspect",
    nodes: [{ id: "inspect", executorId: "local", prompt: "Inspect" }],
    schedule: { type: "interval", startAt: new Date(now).toISOString(), seconds: 60 } }), now);
  tasks.trigger(now);
  const run = tasks.runs(task.id).items[0];
  // Persist a dispatch intent with unknown external outcome, not a fabricated executor delivery.
  run.nodes[0].status = "running"; run.nodes[0].startedAt = new Date(now).toISOString();
  run.nodes[0].turns = [{ prompt: "Inspect", output: "", stopReason: null }];
  store.commit(undefined, run); await tasks.close(); store.close();
  const child = spawn(process.execPath, [cli, "start", "--home", home], { env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", value => { logs += value; }); child.stderr.on("data", value => { logs += value; });
  const closed = new Promise(resolve => child.once("close", resolve));
  const occupied = createServer();
  t.after(async () => {
    occupied.close(); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
    await closed; clearTimeout(timer);
    for (const secret of Object.values(secrets)) assert(!logs.includes(secret));
    rmSync(root, { recursive: true, force: true });
  });
  let origin = "http://127.0.0.1:" + port;
  const admin = async (path, body) => {
    const response = await fetch(origin + "/admin/api" + path, { method: body ? "POST" : "GET",
      headers: { Authorization: "Bearer " + secrets.AGENT_TASK_ADMIN_TOKEN, ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, ...(await response.json()) };
  };
  let ready;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = JSON.parse(invoke("status")); break; } catch { await delay(50); }
  }
  assert(ready);
  const web = await admin("/restart", {});
  assert.equal(web.status, 200); assert.notEqual(web.data.pid, ready.pid); assert.equal(web.data.url, ready.url);
  const restarted = JSON.parse(invoke("restart"));
  assert.notEqual(restarted.pid, web.data.pid); assert.equal(restarted.url, ready.url);
  const savedRun = (await admin("/runs/" + run.id)).data;
  assert.equal(savedRun.status, "interrupted");
  assert.equal(savedRun.nodes[0].turns.length, 1);
  assert.equal((await admin("/tasks/" + task.id)).data.status, "paused");
  const blockedPort = await listen(occupied), settings = (await admin("/settings")).data;
  assert.equal((await admin("/settings/config", { editToken: settings.editToken, config: { ...settings.saved, port: blockedPort } })).status, 200);
  assert.equal((await admin("/restart", {})).status, 503, "must not report success after a bind failure");
  assert.notEqual(spawnSync(process.execPath, [cli, "status", "--home", home], { env, stdio: "ignore" }).status, 0);
  // No runtime owns the data after failure. Correct the saved inputs; explicit restart is required.
  writeFileSync(configPath, JSON.stringify({ ...config, port }), { mode: 0o600 });
  const recovered = JSON.parse(invoke("restart")); origin = new URL(recovered.url).origin;
  assert.deepEqual((await admin("/runs/" + run.id)).data, savedRun);
  assert.equal((await admin("/runs")).data.items.length, 1);
});
