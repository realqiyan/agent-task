import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { TaskStore } from "../dist/tasks/storage/store.js";
import { createTaskRuntime } from "../dist/application/task-runtime.js";
import { createExecution } from "../dist/integrations/acp/execution.js";
import { createCoordinator } from "../dist/integrations/coordinator/coordinator.js";
import { executorRecord } from "../dist/executors/validation.js";
import { taskSchema } from "../dist/protocol/task-contract.js";

const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
test("foreground CLI and Web restart on the same port verify a new process; failed startup stays unavailable and uncertain work never replays", { timeout: 30000 }, async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "task-conductor-restart-")), home = join(root, "private"), workspace = join(root, "workspace");
  const nativeBin = join(root, "bin"), userHome = join(root, "user");
  for (const directory of [workspace, nativeBin, userHome]) mkdirSync(directory, { mode: 0o700 });
  symlinkSync("/usr/bin/false", join(nativeBin, "opencode"));
  const cli = resolve("bin/task-conductor.mjs"), env = { PATH: nativeBin, HOME: userHome };
  const invoke = (...args) => execFileSync(process.execPath, [cli, ...args, "--home", home], { env, encoding: "utf8", stdio: "pipe" });
  const reservation = createServer(), port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  invoke("setup", "--data-dir", join(home, "data"), "--port", String(port), "--generate-tokens", "--yes");
  const dataDir = join(home, "data"), configPath = join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")), secrets = JSON.parse(readFileSync(join(dataDir, "environment.json"), "utf8"));
  config.disabledExecutors = ["pi", "codex", "claude"];
  config.coordinator = { provider: "openai", model: "not-a-real-model" };
  secrets.OPENAI_API_KEY = "test-only-unused-model-credential";
  writeFileSync(join(dataDir, "environment.json"), JSON.stringify(secrets), { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  const executable = realpathSync("/usr/bin/false");
  const executor = executorRecord.parse({ id: "opencode", type: "opencode", nativePath: executable,
    command: executable, args: ["acp"], adapterVersion: null });
  const store = new TaskStore(dataDir), tasks = createTaskRuntime(dataDir, [executor], createExecution({ PATH: "/missing" }),
    createCoordinator(dataDir, { provider: "openai", model: "not-a-real-model" }), error => { throw error; });
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const task = tasks.definitions.create(taskSchema.parse({ requestKey: "uncertain", name: "uncertain", prompt: "Inspect", workspace,
    nodes: [{ id: "inspect", executorId: "opencode", prompt: "Inspect" }],
    schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" } }), now - 1);
  tasks.runs.trigger(now);
  const run = tasks.runs.list(task.id).items[0];
  // Persist a dispatch intent with unknown external outcome, not a fabricated executor delivery.
  run.nodes[0].status = "running"; run.nodes[0].startedAt = new Date(now).toISOString();
  run.nodes[0].workspace = workspace;
  run.nodes[0].turns = [{ prompt: "Inspect", output: "", stopReason: null, sessionId: null, inputDeliveries: [], messageIds: [], contextMessageIds: [] }];
  store.commitRun( run); await tasks.close(); store.close();
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
      headers: { Authorization: "Bearer " + secrets.TASK_CONDUCTOR_ADMIN_TOKEN, ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}) },
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
  assert.equal((await admin("/tasks/" + task.id)).data.scheduleStatus, "paused");
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
