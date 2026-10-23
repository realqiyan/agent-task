import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { controlService } from "../dist/integrations/local-service/control.js";

const cli = resolve("bin/agent-task.mjs");
async function until(read, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error("Timed out waiting for the local service");
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, false, JSON.stringify(result));
  return result.structuredContent.data;
}
function connection(home, cwd, env) {
  const child = spawn(process.execPath, [cli, "mcp", "--home", home], {
    cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once("close", resolve));
  const client = new Client({ name: "agent-task-process-test", version: "1.0.0" });
  // The official line-framing transport accepts streams. Owning spawn here gives this real client a separate process group.
  const transport = new StdioServerTransport(child.stdout, child.stdin);
  return { child, client, closed, connect: () => client.connect(transport, { timeout: 15_000 }),
    get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function waitClosed(peer) {
  let timer;
  try {
    await Promise.race([peer.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("MCP process did not close: " + peer.stderr)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

test("MCP startup requires explicit initialization and creates no installation", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-uninitialized-")), home = join(root, "private");
  try {
    const result = spawnSync(process.execPath, [cli, "mcp", "--home", home], {
      cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /setup first/);
    assert.equal(existsSync(home), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concurrent stdio projects share one backend whose future tasks survive EOF and process-group SIGHUP", { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-stdio-")), home = join(root, "private");
  const dataDir = join(home, "data"), nativeBin = join(root, "bin"), userHome = join(root, "user");
  const projectA = join(root, "project-a"), projectB = join(root, "project-b"), override = join(root, "selected workspace");
  for (const directory of [nativeBin, userHome, projectA, projectB, override]) mkdirSync(directory, { mode: 0o700 });
  // A real failing program supplies only a discoverable executable. This does not simulate ACP or prove successful execution.
  symlinkSync("/usr/bin/false", join(nativeBin, "opencode"));
  const env = { PATH: nativeBin, HOME: userHome };
  const invoke = (...args) => execFileSync(process.execPath, [cli, ...args, "--home", home], {
    env, encoding: "utf8", stdio: "pipe", timeout: 10_000,
  });
  const peers = [];
  let ready, connected = false;
  t.after(async () => {
    for (const peer of peers) {
      await peer.client.close().catch(() => {});
      if (peer.child.exitCode === null && peer.child.signalCode === null) peer.child.kill("SIGTERM");
      const timer = setTimeout(() => peer.child.kill("SIGKILL"), 5000);
      await peer.closed; clearTimeout(timer);
    }
    try { await controlService(home, "stop", 8000); }
    catch (error) {
      if (error.kind !== "unreachable" && ready) {
        try { process.kill(ready.pid, "SIGTERM"); } catch {}
        await until(async () => {
          try { await controlService(home, "status", 1000); return false; }
          catch (failure) { return failure.kind === "unreachable"; }
        }).catch(() => {});
      }
    }
    if (connected) rmSync(root, { recursive: true, force: true });
    else t.diagnostic("Failed MCP startup evidence retained at " + root);
  });
  invoke("setup", "--data-dir", dataDir, "--port", "0", "--generate-tokens", "--yes");
  const configPath = join(dataDir, "config.json"), environmentPath = join(dataDir, "environment.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")), environment = JSON.parse(readFileSync(environmentPath, "utf8"));
  config.coordinator = { provider: "openai", model: "not-a-real-model" };
  config.disabledExecutors = ["pi", "codex", "claude"];
  environment.OPENAI_API_KEY = "test-only-unused-model-credential";
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(environmentPath, JSON.stringify(environment), { mode: 0o600 });
  const first = connection(home, projectA, env), second = connection(home, projectB, env);
  peers.push(first, second);
  await Promise.all(peers.map(peer => peer.connect()));
  connected = true;
  ready = await controlService(home, "status");
  const executors = await call(first.client, "executor_list");
  assert.equal(executors.executors.find(item => item.id === "opencode").state, "ready");
  assert(executors.executors.filter(item => item.id !== "opencode").every(item => item.state === "disabled"));
  const input = { requestKey: "inspect", name: "Inspect", prompt: "Inspect project",
    nodes: [{ id: "inspect", executorId: "opencode", prompt: "Inspect project" }],
    schedule: { type: "once", at: new Date(Date.now() + 3000).toISOString() } };
  const taskA = await call(first.client, "task_create", input);
  const taskB = await call(second.client, "task_create", input);
  const taskC = await call(first.client, "task_create", { ...input, requestKey: "override", workspace: override });
  assert.equal(taskA.workspace, projectA); assert.equal(taskB.workspace, projectB); assert.equal(taskC.workspace, override);
  assert.notEqual(taskA.id, taskB.id, "request keys are scoped to the resolved task directory");
  assert.equal((await call(first.client, "task_create", input)).id, taskA.id);
  assert.equal((await call(second.client, "task_get", { id: taskA.id })).workspace, projectA);
  assert.equal((await call(second.client, "task_run_list", { taskId: taskA.id })).items.length, 0);
  await first.client.close(); first.child.stdin.end();
  await waitClosed(first);
  process.kill(-second.child.pid, "SIGHUP");
  await waitClosed(second); await second.client.close();
  const afterDisconnect = await controlService(home, "status");
  assert.equal(afterDisconnect.pid, ready.pid);
  assert.equal(afterDisconnect.instanceId, ready.instanceId);
  const origin = new URL(ready.url).origin;
  const admin = async path => {
    const response = await fetch(origin + "/admin/api" + path, {
      headers: { Authorization: "Bearer " + environment.AGENT_TASK_ADMIN_TOKEN }, signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  const ids = new Set([taskA.id, taskB.id, taskC.id]);
  const runs = await until(async () => {
    const items = (await admin("/runs")).items.filter(run => ids.has(run.taskId));
    return items.length === 3 && items.every(run => run.status === "failed") && items;
  }, 20_000);
  for (const summary of runs) {
    const run = await admin("/runs/" + summary.id);
    assert.match(run.error, /no_model/);
    assert.ok(run.nodes.every(node => node.sessionId === null && node.turns.length === 0));
  }
  assert.equal((await controlService(home, "status")).pid, ready.pid);
  for (const peer of peers) {
    const lines = peer.stdout.trim().split("\n");
    assert(lines.length > 0);
    for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, "2.0", "stdout contains MCP messages only");
    for (const credential of Object.values(environment)) assert(!(peer.stdout + peer.stderr).includes(credential));
  }
  assert.equal(JSON.parse(invoke("stop", "--json")).stopped, true);
  await assert.rejects(controlService(home, "status"), error => error.kind === "unreachable");
});
