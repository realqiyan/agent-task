import test from "node:test";
import assert from "node:assert/strict";
import { realpath, mkdtemp, writeFile, rm } from "node:fs/promises";
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
import { createExecution } from "../dist/node-execution.js";
const openExecution = createExecution({ PATH: "/usr/bin:/bin" });
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
  const dir = await mkdtemp(join(await realpath(tmpdir()), "agent-task-http-")), config = join(dir, "config.json");
  const token = randomBytes(32).toString("hex");
  await writeFile(config, JSON.stringify({ dataDir: join(dir, "state"), port: 0,
    coordinator: { provider: "openai", model: "not-a-real-model" },
    executors: [{ id: "local", type: "codex", cwd: dir, unattendedApproved: true }] }), { mode: 0o600 });
  // Persist a real waiting run before starting the HTTP owner; no model or ACP output is fabricated.
  const state = join(dir, "state"), store = new TaskStore(state);
  const executor = executorSchema.parse({ id: "local", type: "codex", cwd: dir, unattendedApproved: true });
  const service = new Tasks(store, [executor], new Results(state), openExecution,
    createCoordinator(state, { provider: "openai", model: "not-a-real-model" }), error => { throw error; });
  const waitingTask = service.create(taskSchema.parse({ requestKey: "waiting", name: "waiting", prompt: "Inspect",
    nodes: [{ id: "inspect", prompt: "Inspect", executorId: "local" }], schedule: { type: "now" } }));
  service.trigger();
  const waitingRun = service.runs(waitingTask.id).items[0];
  const question = service.actions(waitingRun.id).ask({ question: "Which source?", completedWork: "None" });
  await service.close(); store.close();
  const environmentPath = join(dir, "environment.json");
  await writeFile(environmentPath, JSON.stringify({ AGENT_TASK_TOKEN: token }), { mode: 0o600 });
  const child = spawn(process.execPath, [resolve("dist/main.js"), "--config", config, "--environment", environmentPath], {
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
  const tools = (await client.listTools()).tools;
  const names = tools.map(tool => tool.name);
  assert.deepEqual(tools.find(tool => tool.name === "task_update").inputSchema.properties.action.enum, ["pause", "resume", "cancel"]);
  for (const old of ["task_pause", "task_resume", "task_cancel"]) {
    assert(!names.includes(old));
    assert.equal((await client.callTool({ name: old, arguments: { id: waitingTask.id } })).isError, true);
  }
  assert.equal((await client.callTool({ name: "task_update", arguments: { id: waitingTask.id, action: "edit" } })).isError, true);
  const nodes = [
    { id: "inspect", prompt: "Inspect project", executorId: "local", dependsOn: [], maxRunSeconds: 60 },
    { id: "review", prompt: "Review the inspection", executorId: "local", dependsOn: ["inspect"], maxRunSeconds: 60 },
  ];
  const future = await call(client, "task_create", { requestKey: "future", name: "future", prompt: "Inspect",
    workspace: dir, nodes: [nodes[0]], schedule: { type: "once", at: new Date(Date.now() + 60000).toISOString() } });
  assert.deepEqual((await call(client, "task_get", { id: future.id })).input.nodes, [nodes[0]]);
  const invalid = await client.callTool({ name: "task_create", arguments: {
    requestKey: "invalid", name: "invalid", prompt: "Inspect", schedule: { type: "now" }, nodes: [nodes[1]],
  } });
  assert.equal(invalid.isError, true);
  assert.equal(future.workspace, dir);
  for (const [action, status] of [["pause", "paused"], ["resume", "active"], ["cancel", "cancelled"]]) {
    assert.equal((await call(client, "task_update", { id: future.id, action })).status, status);
  }
  assert.equal((await call(client, "task_run_get", { id: waitingRun.id })).status, "waiting_input");
  // Admit a complete DAG through MCP. Read scope is validated even before model work.
  const task = await call(client, "task_create", { requestKey: "one", name: "one", prompt: "Inspect project",
    nodes, schedule: { type: "once", at: new Date(Date.now() + 1000).toISOString() } });
  assert.deepEqual(task.input.nodes, nodes);
  await client.close();
  const reader = await connect();
  const run = await until(async () => (await call(reader, "task_run_list", { taskId: task.id })).items.find(run => run.status === "failed"));
  assert.match(run.error, /no_model/);
  assert.deepEqual(run.nodes.map(node => node.definition), nodes);
  assert.ok(run.nodes.every(node => node.status === "blocked" && node.sessionId === null && node.turns.length === 0));
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
