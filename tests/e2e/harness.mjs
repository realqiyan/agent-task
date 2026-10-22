import assert from "node:assert/strict";
import { realpath, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig, executorEnv } from "../../dist/config.js";

/** Real local service and remote agents only. No retry, alternate provider or synthetic delivery. */
export async function startE2e(t, { dependencies = false } = {}) {
  assert.ok(process.env.DEEPSEEK_API_KEY, "Load DEEPSEEK_API_KEY in this shell before running E2E; never print it");
  assert.ok(process.env.AGENT_TASK_E2E_EXECUTOR, "Set AGENT_TASK_E2E_EXECUTOR to a reviewed ACP profile. For Pi install pi-acp@0.0.34; pi --mode rpc is not ACP.");
  const executor = JSON.parse(await readFile(process.env.AGENT_TASK_E2E_EXECUTOR, "utf8"));
  assert.equal(executor.unattendedApproved, true, "Review native executor permissions before approving unattended use");
  if (dependencies) assert.equal(process.env.AGENT_TASK_E2E_ALLOW_RESULT_READ, "1",
    "This case requires explicit approval: AGENT_TASK_E2E_ALLOW_RESULT_READ=1 and native read-only tools for the generated result directory");
  const dir = await mkdtemp(join(await realpath(tmpdir()), "agent-task-real-e2e-"));
  t.diagnostic(`Private E2E evidence retained at ${dir}`);
  const log = (event, data = {}) => appendFileSync(join(dir, "events.jsonl"),
    JSON.stringify({ at: new Date().toISOString(), event, ...data }) + "\n", { mode: 0o600 });
  const save = (name, value) => writeFile(join(dir, name), JSON.stringify(value, null, 2), { mode: 0o600 });
  log("test_started", { dependencies });
  const workspace = join(dir, "workspace"), dataDir = join(dir, "state");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(join(dataDir, "results"), { recursive: true, mode: 0o700 });
  const configPath = join(dir, "config.json"), token = randomBytes(32).toString("hex");
  const tokenEnv = "AGENT_TASK_E2E_TOKEN";
  assert.ok(!(executor.envKeys ?? []).includes(tokenEnv), "Executor must not receive the service token");
  await save("config.json", { dataDir, port: 0, tokenEnv,
    coordinator: { provider: "deepseek", model: process.env.AGENT_TASK_E2E_MODEL || "deepseek-flash" },
    executors: [{ ...executor, cwd: workspace, resultReadRoots: dependencies ? [join(dataDir, "results")] : [] }],
  });
  const config = loadConfig(configPath);
  const child = spawn(process.execPath, [resolve("dist/main.js"), "--config", configPath], {
    env: { ...executorEnv(config.executors[0].envKeys), DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, [tokenEnv]: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let readyUrl, spawnError, client, taskId;
  const closed = new Promise(resolve => child.once("close", resolve));
  child.once("error", error => { spawnError = error; });
  let pending = "";
  child.stdout.on("data", chunk => {
    pending += chunk.toString();
    const lines = pending.split("\n"); pending = lines.pop().slice(-8192);
    for (const line of lines) {
      try { const event = JSON.parse(line); if (event.event === "ready") { readyUrl = event.url; log("service_ready"); } } catch {}
    }
  });
  // Raw errors may contain secrets. Business errors remain in the private run snapshot.
  child.stderr.resume();
  t.after(async () => {
    if (client && taskId && child.exitCode === null) {
      try { await save("last-runs.json", await call("task_run_list", { taskId })); } catch {}
    }
    await client?.close().catch(() => {});
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 6000);
    await closed; clearTimeout(timer);
    log("service_closed", { exitCode: child.exitCode, signal: child.signalCode });
  });
  async function until(fn, milliseconds = 200000) {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      assert.ok(!spawnError && child.exitCode === null && child.signalCode === null, "Service exited; inspect private evidence");
      const value = await fn(); if (value) return value;
      await delay(250);
    }
    throw new Error("E2E deadline exceeded; inspect retained private evidence");
  }
  async function connect() {
    client = new Client({ name: "agent-task-real-e2e", version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(readyUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
  }
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, `${name} failed; inspect retained private evidence`);
    return result.structuredContent.data;
  }
  async function create(input) {
    const task = await call("task_create", { requestKey: "real-e2e", name: "Real ACP E2E",
      schedule: { type: "now" }, maxRunSeconds: 300, maxSteps: 35, maxNodeTurns: 3, ...input });
    taskId = task.id;
    log("task_created", { taskId });
    await save("task.json", task);
    await client.close();
    log("submitting_client_disconnected");
    await connect();
    return task;
  }
  let lastState;
  async function getRun() {
    const { items } = await call("task_run_list", { taskId });
    if (!items[0]) return;
    const run = await call("task_run_get", { id: items[0].id });
    await save("latest-run.json", run);
    const state = { runId: run.id, status: run.status, steps: run.steps, questions: run.questions.length,
      nodes: run.nodes.map(node => ({ id: node.id, name: node.definition.id, status: node.status, sessionId: node.sessionId, turns: node.turns.length })) };
    if (JSON.stringify(state) !== lastState) { log("run_progress", state); lastState = JSON.stringify(state); }
    return run;
  }
  async function waitFor(status, milliseconds) {
    return until(async () => {
      const run = await getRun();
      if (!run) return;
      if (run.status === status) return run;
      assert.equal(run.status, "running", `Unexpected ${run.status}; inspect latest-run.json`);
    }, milliseconds);
  }
  await until(() => readyUrl, 15000);
  await connect();
  return { dir, executor, log, save, until, call, create, getRun, waitFor };
}

export async function verifyDelivery(node) {
  assert.equal(node.status, "succeeded");
  assert.ok(node.sessionId && node.acceptance && node.resultFile);
  const turn = node.turns.at(-1);
  assert.equal(turn.stopReason, "end_turn");
  assert.ok(turn.output.includes(node.result));
  assert.equal(await readFile(node.resultFile, "utf8"), node.result);
}
