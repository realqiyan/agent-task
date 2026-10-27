import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { controlService } from "../dist/integrations/local-service/control.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createTaskRuntime } from "../dist/application/task-runtime.js";
import { createCoordinator } from "../dist/integrations/coordinator/coordinator.js";
import { createExecution } from "../dist/integrations/acp/execution.js";
import { HttpServer } from "../dist/protocol/http/server.js";
import { bindPiNotifications, DeliveryReceipts, notificationMessage, originType } from "../plugin/scripts/notifications.mjs";

// 原生 Pi 是显式验收依赖，不自动下载安装，也不读取个人认证。
const sdkRoot = process.env.TASK_CONDUCTOR_PI_SDK;
async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(20); }
  throw new Error("等待原生 Pi 行为超时");
}
async function native(t, factories = []) {
  const sdk = await import(pathToFileURL(resolve(sdkRoot, "dist/index.js")).href);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "task-conductor-pi-notify-"));
  const agentDir = join(root, "agent"); mkdirSync(agentDir);
  // 真实 TCP 连接等待，不实现模型协议或返回模型响应；所有模型请求只到本机。
  const sockets = new Set();
  const server = createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { baseUrl: `http://127.0.0.1:${server.address().port}/v1` } } }));
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath, allowModelNetwork: false, modelsStorePath: join(agentDir, "catalog.sqlite") });
  await modelRuntime.setRuntimeApiKey("openai", "local-failure-probe-not-a-credential");
  const manager = sdk.SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "通知接收契约验收，不调用真实模型", timestamp: Date.now() });
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, extensionFactories: factories });
  await loader.reload();
  const { session } = await sdk.createAgentSession({ cwd: root, agentDir, modelRuntime,
    model: modelRuntime.getModel("openai", "gpt-4.1"), sessionManager: manager,
    settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoader: loader });
  t.after(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise(done => server.close(done));
    rmSync(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode: "rpc" });
  return { sdk, root, agentDir, manager, session, sockets };
}

test("原生 Pi：followUp 排队不形成回执，空闲触发真实 SDK 后才出现持久消息；恢复去重、不同会话标识隔离", {
  skip: !sdkRoot && "设置 TASK_CONDUCTOR_PI_SDK 指向 Pi 1.4.0+ 包目录", timeout: 20_000,
}, async t => {
  let api;
  const f = await native(t, [pi => { api = pi; }]);
  const origin = { projectId: "uuid:" + randomUUID(), sessionId: "pi:" + f.manager.getSessionId() };
  const event = { eventId: randomUUID(), taskId: randomUUID(), runId: randomUUID(), kind: "cancelled", summary: "已取消", createdAt: new Date().toISOString() };
  const receipts = new DeliveryReceipts(f.manager.getSessionFile(), origin, f.manager.getSessionId());
  const running = f.session.prompt("等待中的本机连接");
  await until(() => f.sockets.size);
  api.sendMessage(notificationMessage(origin, [event]), { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(receipts.read().has(event.eventId), false);
  assert(f.session.agent.hasQueuedMessages());
  assert.equal(f.session.agent.peekQueuedMessages()[0].details.eventIds[0], event.eventId);
  // 明确取消本轮和队列，原事件仍未确认，模拟之后补投。
  f.session.agent.clearAllQueues();
  await f.session.abort(); await running;
  assert.equal(receipts.read().has(event.eventId), false);
  api.sendMessage(notificationMessage(origin, [event]), { triggerTurn: true, deliverAs: "followUp" });
  await until(() => receipts.read().has(event.eventId));
  assert(f.session.isStreaming);
  await f.session.abort();
  const reopened = f.sdk.SessionManager.open(f.manager.getSessionFile());
  const reopenedReceipts = new DeliveryReceipts(reopened.getSessionFile(), origin, reopened.getSessionId());
  assert(reopenedReceipts.read().has(event.eventId));
  const different = new DeliveryReceipts(reopened.getSessionFile(), { ...origin, sessionId: "pi:" + randomUUID() }, reopened.getSessionId());
  assert.equal(different.read().size, 0);
});

test("原生 Pi tool_call 扩展注入身份后经真实 MCP 保存；不调用模型生成工具输入", {
  skip: !sdkRoot && "设置 TASK_CONDUCTOR_PI_SDK 指向 Pi 1.4.0+ 包目录", timeout: 20_000,
}, async t => {
  const sdk = await import(pathToFileURL(resolve(sdkRoot, "dist/index.js")).href);
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "task-conductor-pi-mcp-"));
  const executor = { id: "local", type: "custom", nativePath: realpathSync("/usr/bin/false"), command: realpathSync("/usr/bin/false"), args: [], adapterVersion: null };
  const service = createTaskRuntime(directory, [executor], createExecution({ PATH: "/usr/bin:/bin" }),
    createCoordinator(directory, { provider: "openai", model: "gpt-4.1" }), error => { throw error; });
  const token = randomUUID();
  const http = new HttpServer({ tasks: service, token, instanceId: randomUUID(), fatal: error => { throw error; }, restart: async () => {} });
  const url = await http.listen(0);
  const oldCommand = process.env.TASK_CONDUCTOR_PREFLIGHT_COMMAND;
  process.env.TASK_CONDUCTOR_PREFLIGHT_COMMAND = "/usr/bin/false";
  t.after(async () => {
    if (oldCommand === undefined) delete process.env.TASK_CONDUCTOR_PREFLIGHT_COMMAND; else process.env.TASK_CONDUCTOR_PREFLIGHT_COMMAND = oldCommand;
    await http.close(); await service.close(); rmSync(directory, { recursive: true, force: true });
  });
  const f = await native(t, [bindPiNotifications, sdk.createMcpExtension(), pi => {
    pi.registerMcpServer("task-conductor", { url: url + "/mcp", headers: { Authorization: "Bearer " + token }, exposure: "direct" });
  }]);
  await until(() => f.session.getAllTools().some(tool => tool.name === "mcp__task_conductor__task_create")).catch(error => {
    t.diagnostic(JSON.stringify(f.session.getAllTools().map(tool => ({ name: tool.name, namespace: tool.namespace })))); throw error;
  });
  const input = {
    workspace: directory, requestKey: "native", name: "通知验收", prompt: "不执行领域工作",
    nodes: [{ id: "a", prompt: "不执行", executorId: "local" }],
    schedule: { type: "once", at: new Date(Date.now() + 86_400_000).toISOString() },
  };
  const name = "mcp__task_conductor__task_create";
  const decision = await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: "probe-1", input });
  assert.notEqual(decision?.block, true);
  const tool = f.session.agent.state.tools.find(tool => tool.name === name);
  const result = await tool.execute("probe-1", input, new AbortController().signal);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const task = service.definitions.list().items[0];
  assert(task);
  assert.equal(task.notification.sessionId, "pi:" + f.manager.getSessionId());
  assert.match(task.notification.projectId, /^uuid:/);
  assert.equal(task.notification.projectId, JSON.parse(readFileSync(join(f.root, ".task-conductor/project.json"))).projectId);
  assert(f.manager.getEntries().some(entry => entry.type === "custom" && entry.customType === originType));
});

test("原生 Pi 插件端到端轮询真实后台，经 CLI 投递并只在落盘后确认", {
  skip: !sdkRoot && "设置 TASK_CONDUCTOR_PI_SDK 指向 Pi 1.4.0+ 包目录", timeout: 30_000,
}, async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "task-conductor-pi-delivery-"));
  const bin = join(root, "bin"), home = join(root, "home"), user = join(root, "user");
  mkdirSync(bin); mkdirSync(user);
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(resolve("bin/task-conductor.mjs"), join(bin, "task-conductor"));
  symlinkSync("/usr/bin/false", join(bin, "opencode"));
  const env = { PATH: bin, HOME: user };
  execFileSync(process.execPath, [resolve("bin/task-conductor.mjs"), "setup", "--home", home, "--data-dir", join(home, "data"), "--port", "0", "--generate-tokens", "--yes"], {
    cwd: root, env, stdio: "pipe", timeout: 10_000,
  });
  const configPath = join(home, "data/config.json");
  const config = JSON.parse(readFileSync(configPath));
  writeFileSync(configPath, JSON.stringify({ ...config, disabledExecutors: ["pi", "codex", "claude"], coordinator: { provider: "openai", model: "gpt-4.1" } }), { mode: 0o600 });
  const client = new Client({ name: "pi-notification-probe", version: "1" });
  await client.connect(new StdioClientTransport({ command: join(bin, "task-conductor"), args: ["mcp", "--home", home], cwd: root, env, stderr: "pipe" }));
  const ready = await controlService(home, "status");
  const token = JSON.parse(readFileSync(join(home, "data/environment.json")))[config.tokenEnv ?? "TASK_CONDUCTOR_TOKEN"];
  const old = { command: process.env.TASK_CONDUCTOR_PREFLIGHT_COMMAND, home: process.env.TASK_CONDUCTOR_PREFLIGHT_HOME };
  process.env.TASK_CONDUCTOR_PREFLIGHT_COMMAND = join(bin, "task-conductor");
  process.env.TASK_CONDUCTOR_PREFLIGHT_HOME = home;
  let f;
  t.after(async () => {
    if (f) await f.session.extensionRunner.emit({ type: "session_shutdown" });
    if (old.command === undefined) delete process.env.TASK_CONDUCTOR_PREFLIGHT_COMMAND; else process.env.TASK_CONDUCTOR_PREFLIGHT_COMMAND = old.command;
    if (old.home === undefined) delete process.env.TASK_CONDUCTOR_PREFLIGHT_HOME; else process.env.TASK_CONDUCTOR_PREFLIGHT_HOME = old.home;
    await client.close(); await controlService(home, "stop", 8000);
    rmSync(root, { recursive: true, force: true });
  });
  const sdk = await import(pathToFileURL(resolve(sdkRoot, "dist/index.js")).href);
  f = await native(t, [bindPiNotifications, sdk.createMcpExtension(), pi => {
    pi.registerMcpServer("task-conductor", { url: ready.url, headers: { Authorization: "Bearer " + token }, exposure: "direct" });
  }]);
  const name = "mcp__task_conductor__task_create";
  await until(() => f.session.getAllTools().some(tool => tool.name === name));
  const input = { workspace: root, requestKey: "delivery", name: "失败路径通知", prompt: "检查数据",
    nodes: [{ id: "a", executorId: "opencode", prompt: "检查数据" }], schedule: { type: "now" } };
  assert.notEqual((await f.session.extensionRunner.emitToolCall({ type: "tool_call", toolName: name, toolCallId: "create", input }))?.block, true);
  const result = await f.session.agent.state.tools.find(tool => tool.name === name).execute("create", input, new AbortController().signal);
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const receipts = new DeliveryReceipts(f.manager.getSessionFile(), input.notification, f.manager.getSessionId());
  await until(() => receipts.read().size === 1, 15_000);
  await f.session.abort();
  const eventId = [...receipts.ids][0];
  // 查看真实数据库中的渠道确认；不手工生成业务事件或伪造模型输出。
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, "data/tasks.sqlite"));
  try {
    await until(() => db.prepare("SELECT acknowledged_at FROM notification_deliveries WHERE event_id=? AND channel='session'").get(eventId), 10_000);
    const event = JSON.parse(db.prepare("SELECT data FROM notification_events WHERE id=?").get(eventId).data);
    assert.equal(event.kind, "failed");
    assert.deepEqual(event.origin, input.notification);
    assert.equal(f.manager.getEntries().filter(entry => entry.type === "custom_message" && entry.customType === "task-conductor-notification").length, 1);
  } finally { db.close(); }
});
