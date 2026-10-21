import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TaskStore } from "../dist/task-storage.js";
import { Tasks } from "../dist/tasks.js";
import { Results } from "../dist/results.js";
import { executorSchema } from "../dist/model.js";
import { taskSchema } from "../dist/task-contract.js";
import { openExecution } from "../dist/node-execution.js";
import { createCoordinator } from "../dist/coordinator.js";

async function until(fn) {
  for (let i = 0; i < 100; i++) { const result = await fn(); if (result) return result; await delay(100); }
  throw new Error("Timed out");
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent.data;
}
test("MCP admission survives client disconnect; an unconfigured model fails without ACP dispatch or false success", { timeout: 20000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "agent-task-http-")), config = join(dir, "config.json");
  const token = randomBytes(32).toString("hex");
  await writeFile(config, JSON.stringify({ dataDir: join(dir, "state"), port: 0,
    coordinator: { provider: "openai", model: "not-a-real-model" },
    executors: [{ id: "local", command: "/usr/bin/false", cwd: dir, unattendedApproved: true }] }));
  // Persist a real waiting run before starting the HTTP owner; no model or ACP output is fabricated.
  const state = join(dir, "state"), store = new TaskStore(state);
  const executor = executorSchema.parse({ id: "local", command: "/usr/bin/false", cwd: dir, unattendedApproved: true });
  const service = new Tasks(store, [executor], new Results(state), openExecution,
    createCoordinator(state, { provider: "openai", model: "not-a-real-model" }), error => { throw error; });
  const waitingTask = service.create(taskSchema.parse({ requestKey: "waiting", name: "waiting", prompt: "Inspect",
    executorIds: ["local"], schedule: { type: "now" } }));
  service.trigger();
  const waitingRun = service.runs(waitingTask.id).items[0];
  const question = service.actions(waitingRun.id).ask({ question: "Which source?", completedWork: "None" });
  await service.close(); store.close();
  const child = spawn(process.execPath, [resolve("dist/main.js"), "--config", config], {
    env: { PATH: process.env.PATH, AGENT_TASK_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
  const closed = new Promise(resolve => child.once("close", resolve));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 6000);
    await closed; clearTimeout(timeout);
    await rm(dir, { recursive: true, force: true });
  });
  const url = await until(() => {
    if (child.exitCode !== null) throw new Error(stderr);
    const line = stdout.split("\n").find(line => line.includes('"event":"ready"'));
    return line && JSON.parse(line).url;
  });
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  assert.equal((await fetch(url, { method: "POST", headers: { Authorization: "Bearer " + token, Origin: "https://untrusted.invalid" } })).status, 403);
  const connect = async () => {
    const client = new Client({ name: "research-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
    return client;
  };
  const client = await connect();
  const task = await call(client, "task_create", { requestKey: "one", name: "one", prompt: "Inspect project",
    executorIds: ["local"], schedule: { type: "once", at: new Date(Date.now() + 1000).toISOString() } });
  await client.close();
  const reader = await connect();
  const run = await until(async () => (await call(reader, "task_run_list", { taskId: task.id })).items.find(run => run.status === "failed"));
  assert.match(run.error, /no_model/);
  assert.deepEqual(run.nodes, []);
  assert.equal((await call(reader, "service_status")).running, true);
  assert.equal((await call(reader, "task_run_get", { id: waitingRun.id })).status, "waiting_input");
  const answer = { runId: waitingRun.id, questionId: question.id, requestKey: "answer", answer: "Source X" };
  const replied = await call(reader, "task_run_reply", answer);
  assert.equal(replied.id, waitingRun.id);
  assert.equal(replied.questions[0].reply.answer, "Source X");
  await until(async () => (await call(reader, "task_run_get", { id: waitingRun.id })).status === "failed");
  const duplicate = await call(reader, "task_run_reply", answer);
  assert.equal(duplicate.status, "failed");
  assert.equal(duplicate.questions.length, 1);
  const conflict = await reader.callTool({ name: "task_run_reply", arguments: { ...answer, answer: "different" } });
  assert.equal(conflict.isError, true);
});
