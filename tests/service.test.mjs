import test from "node:test";
import assert from "node:assert/strict";
import { realpath, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { TaskStore } from "../dist/tasks/storage/store.js";
import { createTaskRuntime } from "../dist/application/task-runtime.js";
import { executorRecord } from "../dist/executors/validation.js";
import { taskSchema } from "../dist/protocol/task-contract.js";
import { createExecution } from "../dist/integrations/acp/execution.js";
const openExecution = createExecution({ PATH: "/usr/bin:/bin" });
import { createCoordinator } from "../dist/integrations/coordinator/coordinator.js";

async function until(fn, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await delay(100); }
  throw new Error("Timed out");
}
const contracts = new WeakMap();
const successfulTools = new Set();
function assertConstrained(schema, path) {
  if (schema === false) return;
  assert(schema && typeof schema === "object", path + " must constrain values");
  assert.equal(Array.isArray(schema.type), false, path + " must use single-type branches");
  assert(["type", "enum", "const", "$ref", "anyOf", "oneOf", "allOf", "not"].some(key => key in schema), path + " has no validation constraints");
  for (const [name, property] of Object.entries(schema.properties ?? {})) assertConstrained(property, path + ".properties." + name);
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    for (const [index, branch] of (schema[keyword] ?? []).entries()) assertConstrained(branch, path + "." + keyword + "[" + index + "]");
  }
  if (schema.items) assertConstrained(schema.items, path + ".items");
  if (schema.additionalProperties) assertConstrained(schema.additionalProperties, path + ".additionalProperties");
  for (const [name, definition] of Object.entries(schema.$defs ?? {})) assertConstrained(definition, path + ".$defs." + name);
}
async function checkedCall(client, name, args = {}) {
  if (!contracts.has(client)) {
    const validator = new AjvJsonSchemaValidator();
    const tools = (await client.listTools()).tools;
    contracts.set(client, new Map(tools.map(tool => {
      assertConstrained(tool.inputSchema, tool.name + ".inputSchema");
      assertConstrained(tool.outputSchema, tool.name + ".outputSchema");
      const validate = validator.getValidator(tool.outputSchema);
      // Both envelope branches are exclusive, and every successful data object has required fields.
      for (const invalid of [{ ok: true }, { ok: false }, { ok: false, error: "failure" },
        { ok: false, code: "unknown", error: "failure" }, { ok: false, code: "validation", error: 1 },
        { ok: false, data: {}, code: "validation", error: "failure" },
        { ok: true, data: null }, { ok: true, data: {} }, { ok: true, data: [] }]) {
        assert.equal(validate(invalid).valid, false, tool.name + " accepted " + JSON.stringify(invalid));
      }
      return [tool.name, validate];
    })));
  }
  const result = await client.callTool({ name, arguments: args });
  const validate = contracts.get(client).get(name);
  if (validate) {
    const validation = validate(result.structuredContent);
    assert.equal(validation.valid, true, name + ": " + validation.errorMessage);
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(result.isError, !result.structuredContent.ok);
    if (!result.isError) {
      successfulTools.add(name);
      assert.equal(validate({ ...result.structuredContent, error: "contradiction" }).valid, false);
    }
  }
  return result;
}
async function call(client, name, args = {}) {
  const result = await checkedCall(client, name, args);
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent.data;
}
test("MCP checks native CLIs on connection, keeps management available and preserves tasks after disconnect", { timeout: 45_000 }, async t => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "agent-task-http-")), config = join(dir, "config.json");
  const token = randomBytes(32).toString("hex"), adminToken = randomBytes(32).toString("hex");
  await writeFile(config, JSON.stringify({ dataDir: join(dir, "state"), port: 0,
    coordinator: { provider: "openai", model: "not-a-real-model" },
    disabledExecutors: [] }), { mode: 0o600 });
  // Persist a real waiting run before starting the HTTP owner; no model or ACP output is fabricated.
  const state = join(dir, "state"), store = new TaskStore(state);
  const executor = executorRecord.parse({ id: "opencode", type: "opencode", nativePath: await realpath("/usr/bin/false"), command: await realpath("/usr/bin/false"), args: ["acp"], adapterVersion: null });
  const service = createTaskRuntime(state, [executor], openExecution,
    createCoordinator(state, { provider: "openai", model: "not-a-real-model" }), error => { throw error; });
  const waitingTask = service.definitions.create(taskSchema.parse({ workspace: dir, requestKey: "waiting", name: "waiting", prompt: "Inspect",
    nodes: [{ id: "inspect", prompt: "Inspect", executorId: "opencode" }], schedule: { type: "now" } }));
  service.runs.trigger();
  const waitingRun = service.runs.list(waitingTask.id).items[0];
  const question = service.supervisor.actions(waitingRun.id).ask({ question: "Which source?", completedWork: "None" });
  await service.close(); store.close();
  const environmentPath = join(dir, "environment.json");
  await writeFile(environmentPath, JSON.stringify({ AGENT_TASK_TOKEN: token, AGENT_TASK_ADMIN_TOKEN: adminToken }), { mode: 0o600 });
  const child = spawn(process.execPath, [resolve("dist/application/main.js"), "--config", config, "--environment", environmentPath], {
    env: { PATH: dir, AGENT_TASK_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
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
    assert.match(client.getInstructions() ?? "", /task_run_list/);
    return client;
  };
  await assert.rejects(connect(), /No local executor found.*pi, codex, claude or opencode/);
  const adminHeaders = { Authorization: "Bearer " + adminToken };
  const adminUrl = new URL(url).origin + "/admin/api";
  assert.equal((await fetch(adminUrl + "/settings", { headers: adminHeaders })).status, 200);
  const missing = await (await fetch(adminUrl + "/executors", { headers: adminHeaders })).json();
  assert(missing.data.executors.every(executor => executor.state === "missing" && executor.nativePath === null));
  // Registration alone allows MCP connection with no built-in CLI and no service restart.
  const registerResponse = await fetch(adminUrl + "/executors/register", { method: "POST", headers: {
    ...adminHeaders, Origin: new URL(url).origin, "Content-Type": "application/json",
  }, body: JSON.stringify({ id: "custom-acp", command: await realpath("/usr/bin/false"), args: ["literal argument"] }) });
  assert.equal(registerResponse.status, 200);
  const customClient = await connect();
  const customList = (await call(customClient, "executor_list")).executors;
  assert.equal(customList.find(entry => entry.id === "custom-acp").state, "ready");
  assert(customList.filter(entry => entry.id !== "custom-acp").every(entry => entry.nativePath === null));
  assert(!(await customClient.listTools()).tools.some(tool => tool.name === "executor_register"));
  assert.equal((await checkedCall(customClient, "executor_register", {})).isError, true);
  await customClient.close();
  // A later connection discovers a newly installed binary without restarting the service.
  await symlink("/usr/bin/false", join(dir, "opencode"));
  const client = await connect();
  const tools = (await client.listTools()).tools;
  const names = tools.map(tool => tool.name);
  assert.equal(names.length, 10);
  // The SDK normally skips output validation on errors: explicitly validate every tool's error envelope.
  for (const name of names) {
    const result = await checkedCall(client, name, { unexpected: true });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "validation");
  }
  const executorStatus = (await call(client, "executor_list")).executors.find(item => item.id === "opencode");
  assert.equal(executorStatus.state, "ready");
  assert(!("type" in executorStatus));
  const validateExecutors = contracts.get(client).get("executor_list");
  for (const field of ["adapterVersion", "error"]) {
    for (const value of [null, "example", 1, undefined]) {
      const record = { ...executorStatus, [field]: value };
      if (value === undefined) delete record[field];
      assert.equal(validateExecutors({ ok: true, data: { executors: [record] } }).valid,
        value === null || typeof value === "string", field + " must be a required nullable string");
    }
  }
  const status = await call(client, "service_status");
  assert.equal(status.coordinatorConfigured, true);
  assert.deepEqual(status.limits, { maxActiveRuns: 4, maxTasks: 1000, maxNodeSessions: 8 });
  const missingId = randomUUID();
  for (const name of ["task_get", "task_update", "task_run_get", "task_run_cancel"]) {
    const result = await checkedCall(client, name, { id: missingId, ...(name === "task_update" ? { action: "cancel" } : {}) });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.code, "not_found", name);
  }
  assert.deepEqual(await call(client, "task_run_list", { taskId: missingId }), { items: [], next: null });
  const updateTool = tools.find(tool => tool.name === "task_update");
  assert.deepEqual(updateTool.inputSchema.properties.action.enum, ["pause", "resume", "cancel"]);
  // Resuming future triggers can launch external model/ACP work.
  assert.equal(updateTool.annotations.openWorldHint, true);
  for (const old of ["task_pause", "task_resume", "task_cancel"]) {
    assert(!names.includes(old));
    assert.equal((await checkedCall(client, old, { id: waitingTask.id })).isError, true);
  }
  assert.equal((await checkedCall(client, "task_update", { id: waitingTask.id, action: "edit" })).isError, true);
  const nodes = [
    { id: "inspect", prompt: "Inspect project", executorId: "opencode", dependsOn: [], maxRunSeconds: 60 },
    { id: "review", prompt: "Review the inspection", executorId: "opencode", dependsOn: ["inspect"], maxRunSeconds: 60 },
  ];
  const future = await call(client, "task_create", { requestKey: "future", name: "future", prompt: "Inspect",
    workspace: dir, nodes: [nodes[0]], schedule: { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" } });
  assert.deepEqual(future.input.schedule, { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" });
  assert.equal(typeof future.nextAt, "string");
  assert(!("command" in future.executors.opencode) && !("args" in future.executors.opencode));
  assert.deepEqual((await call(client, "task_get", { id: future.id })).input.nodes, [nodes[0]]);
  const invalid = await checkedCall(client, "task_create", {
    requestKey: "invalid", name: "invalid", prompt: "Inspect", schedule: { type: "now" }, nodes: [nodes[0]],
  });
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid), /workspace is required/);
  assert.equal(future.workspace, dir);
  const page = await call(client, "task_list", { limit: 1 });
  assert.equal(page.next, 1);
  assert.deepEqual(page.items[0].nodeIds, ["inspect"]);
  assert(!("input" in page.items[0]));
  assert.equal((await call(client, "task_list", { after: page.next, limit: 1 })).items[0].id, future.id);
  const validateTask = contracts.get(client).get("task_get");
  assert.equal(validateTask({ ok: true, data: { ...future, status: "invalid" } }).valid, false);
  assert.equal(validateTask({ ok: true, data: { ...future, input: { ...future.input, nodes: [{}] } } }).valid, false);
  for (const [action, status] of [["pause", "paused"], ["resume", "active"], ["cancel", "cancelled"]]) {
    assert.equal((await call(client, "task_update", { id: future.id, action })).status, status);
  }
  assert.equal((await call(client, "task_run_get", { id: waitingRun.id })).status, "waiting_input");
  // Admit a complete DAG through MCP. Read scope is validated even before model work.
  const task = await call(client, "task_create", { requestKey: "one", name: "one", prompt: "Inspect project",
    workspace: dir, nodes, schedule: { type: "once", at: new Date(Date.now() + 1000).toISOString() } });
  assert.deepEqual(task.input.nodes, nodes);
  await client.close();
  const reader = await connect();
  const summary = await until(async () => (await call(reader, "task_run_list", { taskId: task.id, status: "failed" })).items[0], 20_000);
  assert.equal(summary.nodes[0].turnCount, 0);
  assert(!("turns" in summary.nodes[0]));
  const run = await call(reader, "task_run_get", { id: summary.id });
  assert.match(run.error, /no_model/);
  assert.deepEqual(run.nodes.map(node => node.definition), nodes);
  assert.ok(run.nodes.every(node => node.status === "blocked" && node.sessionId === null && node.turns.length === 0));
  assert.equal((await call(reader, "service_status")).running, true);
  assert.equal((await call(reader, "task_run_get", { id: waitingRun.id })).status, "waiting_input");
  const answer = { runId: waitingRun.id, questionId: question.id, requestKey: "answer", answer: "Source X" };
  const replied = await call(reader, "task_run_reply", answer);
  assert.equal(replied.id, waitingRun.id);
  assert.equal(replied.questions[0].reply.answer, "Source X");
  await until(async () => (await call(reader, "task_run_get", { id: waitingRun.id })).status === "failed", 20_000);
  const duplicate = await call(reader, "task_run_reply", answer);
  assert.equal(duplicate.status, "failed");
  assert.equal(duplicate.questions.length, 1);
  const conflict = await checkedCall(reader, "task_run_reply", { ...answer, answer: "different" });
  assert.equal(conflict.isError, true);
  assert.equal((await call(reader, "task_run_cancel", { id: run.id })).status, "failed");
  const validateRun = contracts.get(reader).get("task_run_get");
  assert.equal(validateRun({ ok: true, data: { ...replied, questions: [{}] } }).valid, false);
  assert.equal(validateRun({ ok: true, data: { ...run, nodes: [{ ...run.nodes[0], turns: [{ output: 1 }] }] } }).valid, false);
  const customTask = await call(reader, "task_create", { requestKey: "custom", name: "custom", prompt: "Inspect",
    workspace: dir, nodes: [{ id: "inspect", prompt: "Inspect", executorId: "custom-acp" }],
    schedule: { type: "once", at: new Date(Date.now() + 3_600_000).toISOString() } });
  assert.deepEqual((await call(reader, "task_get", { id: customTask.id })).executors, customTask.executors);
  assert.equal(customTask.executors["custom-acp"].nativePath, await realpath("/usr/bin/false"));
  assert(!("args" in customTask.executors["custom-acp"]));
  await call(reader, "task_update", { id: customTask.id, action: "cancel" });
  assert.deepEqual([...successfulTools].sort(), names.sort());
});
