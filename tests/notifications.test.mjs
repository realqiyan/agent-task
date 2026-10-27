import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createTaskRuntime } from "../dist/application/task-runtime.js";
import { createCoordinator } from "../dist/integrations/coordinator/coordinator.js";
import { createExecution } from "../dist/integrations/acp/execution.js";
import { HttpServer } from "../dist/protocol/http/server.js";
import { taskSchema } from "../dist/protocol/task-contract.js";
import { TaskStore } from "../dist/tasks/storage/store.js";
import { repositoryIdentity, projectIdentity, runJson } from "../plugin/scripts/notifications.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "task-conductor-notifications-"));
  const executor = { id: "local", type: "custom", nativePath: realpathSync("/usr/bin/false"), command: realpathSync("/usr/bin/false"), args: [], adapterVersion: null };
  const create = () => createTaskRuntime(dir, [executor], createExecution({ PATH: "/usr/bin:/bin" }),
    createCoordinator(dir, { provider: "openai", model: "gpt-4.1" }), error => { throw error; });
  let service = create();
  t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); });
  const origin = { projectId: "uuid:" + randomUUID(), sessionId: "pi:" + randomUUID() };
  const input = taskSchema.parse({ workspace: dir, requestKey: "notify", name: "通知任务", prompt: "检查数据",
    nodes: [{ id: "inspect", prompt: "检查数据", executorId: "local" }], schedule: { type: "now" } });
  return { dir, origin, input, get service() { return service; }, async reopen() { await service.close(); service = create(); } };
}

test("通知与 Run 同事务保存；项目和会话隔离，确认幂等且不改变执行结果", async t => {
  const f = fixture(t), owner = randomUUID();
  const task = f.service.definitions.create(f.input, Date.now(), f.origin);
  assert.equal(f.service.definitions.create(f.input, Date.now(), f.origin).id, task.id);
  assert.throws(() => f.service.definitions.create(f.input), /requestKey/);
  f.service.runs.trigger();
  const run = f.service.runs.list(task.id).items[0];
  const question = f.service.runs.ask(run.id, { question: "需要哪个来源？", completedWork: "尚未执行" });
  assert.equal(f.service.notifications.poll(f.origin, owner).items[0].eventId, question.id);
  assert.equal(f.service.notifications.poll({ ...f.origin, sessionId: "pi:other" }, owner).items.length, 0);
  assert.equal(f.service.notifications.poll({ ...f.origin, projectId: "uuid:" + randomUUID() }, owner).items.length, 0);
  f.service.notifications.acknowledge(f.origin, owner, [question.id]);
  f.service.notifications.acknowledge(f.origin, owner, [question.id]);
  assert.equal(f.service.runs.get(run.id).status, "waiting_input");
  f.service.runs.end(run.id, "cancelled", "用户取消");
  f.service.runs.end(run.id, "failed", "迟到的失败不能覆盖取消");
  await f.reopen();
  const events = f.service.notifications.poll(f.origin, owner).items;
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "cancelled");
  assert.equal(events[0].eventId, run.id);
  f.service.notifications.acknowledge(f.origin, owner, [run.id]);
  await f.reopen();
  assert.equal(f.service.notifications.poll(f.origin, owner).items.length, 0);
});

test("通知接收租约互斥且可过期接续；批量确认验证全部归属后提交", async t => {
  const f = fixture(t), first = randomUUID(), second = randomUUID();
  const task = f.service.definitions.create(f.input, Date.now(), f.origin);
  f.service.runs.trigger();
  const run = f.service.runs.list(task.id).items[0];
  f.service.runs.end(run.id, "failed", "本地失败");
  assert(f.service.notifications.poll(f.origin, first, 1000).acquired);
  assert.equal(f.service.notifications.poll(f.origin, second, 2000).acquired, false);
  assert.throws(() => f.service.notifications.acknowledge(f.origin, second, [run.id], 2000), /租约/);
  assert.throws(() => f.service.notifications.acknowledge(f.origin, first, [run.id, randomUUID()], 2000), /不属于/);
  assert.equal(f.service.notifications.poll(f.origin, first, 2001).items.length, 1);
  assert(f.service.notifications.poll(f.origin, second, 40_000).acquired);
  assert.throws(() => f.service.notifications.acknowledge(f.origin, first, [run.id], 40_001), /租约/);
  f.service.notifications.release(f.origin, first);
  assert.equal(f.service.notifications.poll(f.origin, first, 40_002).acquired, false);
  f.service.notifications.release(f.origin, second);
  assert(f.service.notifications.poll(f.origin, first, 40_003).acquired);
});

test("Cron 各次跳过独立通知；无通知归属的任务不生成事件", async t => {
  const f = fixture(t), now = Date.now();
  const task = f.service.definitions.create({ ...f.input, schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" } }, now, f.origin);
  f.service.runs.trigger(task.nextAt + 31_000);
  f.service.runs.trigger(f.service.definitions.get(task.id).nextAt + 31_000);
  const events = f.service.notifications.poll(f.origin, randomUUID()).items;
  assert.equal(events.length, 2);
  assert(events.every(event => event.kind === "skipped"));
  assert.notEqual(events[0].eventId, events[1].eventId);
  const other = f.service.definitions.create({ ...f.input, requestKey: "no-notify" });
  f.service.runs.trigger();
  f.service.runs.end(f.service.runs.list(other.id).items[0].id, "failed", "失败");
  const store = new TaskStore(f.dir);
  try { assert.equal(store.pendingNotifications(f.origin, 20).length, 2); } finally { store.close(); }
});

test("通知事件写入失败会回滚 Run 终态，不产生半个交付", async t => {
  const f = fixture(t);
  const task = f.service.definitions.create(f.input, Date.now(), f.origin);
  f.service.runs.trigger();
  const run = f.service.runs.list(task.id).items[0];
  const db = new DatabaseSync(join(f.dir, "tasks.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_notification BEFORE INSERT ON notification_events BEGIN SELECT RAISE(ABORT, '拒绝事件写入'); END;");
    assert.throws(() => f.service.runs.end(run.id, "cancelled", "用户取消"), /commit failed/);
    assert.equal(JSON.parse(db.prepare("SELECT data FROM rounds WHERE id=?").get(run.id).data).status, "running");
    assert.equal(db.prepare("SELECT count(*) AS n FROM notification_events").get().n, 0);
  } finally { db.close(); }
});

test("真实 MCP 创建原子绑定通知身份；通知 HTTP 边界拒绝未认证、Origin 和跨会话确认", async t => {
  const f = fixture(t), token = randomUUID();
  const http = new HttpServer({ tasks: f.service, token, instanceId: randomUUID(), fatal: error => { throw error; }, restart: async () => {} });
  const url = await http.listen(0), client = new Client({ name: "notification-test", version: "1" });
  t.after(async () => { await client.close(); await http.close(); });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
  const created = await client.callTool({ name: "task_create", arguments: { ...f.input, notification: f.origin } });
  assert.equal(created.isError, false);
  const taskId = created.structuredContent.data.taskId;
  assert.deepEqual(f.service.definitions.get(taskId).notification, f.origin);
  f.service.runs.trigger();
  const run = f.service.runs.list(taskId).items[0];
  f.service.runs.end(run.id, "cancelled", "取消");
  const owner = randomUUID(), input = { action: "poll", origin: f.origin, owner };
  const post = (body, headers = {}) => fetch(url + "/notifications", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post(input)).status, 401);
  const auth = { Authorization: "Bearer " + token };
  assert.equal((await post(input, { ...auth, Origin: "https://example.com" })).status, 403);
  const result = await (await post(input, auth)).json();
  assert.equal(result.items[0].eventId, run.id);
  assert.equal((await post({ action: "ack", origin: { ...f.origin, sessionId: "wrong" }, owner, eventIds: [run.id] }, auth)).status, 409);
  assert.equal((await post({ action: "ack", origin: f.origin, owner, eventIds: [run.id] }, auth)).status, 200);
  assert.equal((await (await post(input, auth)).json()).items.length, 0);
});

test("项目身份对 SSH/HTTPS 一致；保留完整分组和大小写，无 remote 的 UUID 持久共享", async t => {
  assert.equal(repositoryIdentity("git@github.com:team/app.git"), repositoryIdentity("https://gitlab.com/team/app"));
  assert.equal(repositoryIdentity("ssh://git@example.com/team/sub/app.git"), repositoryIdentity("https://example.com/team/sub/app/"));
  assert.notEqual(repositoryIdentity("https://example.com/Team/app"), repositoryIdentity("https://example.com/team/app"));
  assert.throws(() => repositoryIdentity("/tmp/repo"));
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "task-conductor-project-id-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, TASK_CONDUCTOR_PROJECT_ROOT: dir };
  const [a, b] = await Promise.all([projectIdentity(dir, { env }), projectIdentity(dir, { env })]);
  assert.equal(a, b); assert.match(a, /^uuid:/);
  assert.equal(JSON.parse(readFileSync(join(dir, ".task-conductor/project.json"))).projectId, a);
  execFileSync("git", ["init", "--quiet", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://example.com/team/app.git"]);
  assert.equal(await projectIdentity(dir, { env }), a);
  const repo = join(dir, "second"); mkdirSync(repo);
  execFileSync("git", ["init", "--quiet", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@example.com:team/sub/app.git"]);
  assert.equal(await projectIdentity(repo, { env: { ...env, TASK_CONDUCTOR_PROJECT_ROOT: repo } }), repositoryIdentity("git@example.com:team/sub/app.git"));
  writeFileSync(join(repo, ".task-conductor/project.json"), "{}");
  await assert.rejects(projectIdentity(repo, { env: { ...env, TASK_CONDUCTOR_PROJECT_ROOT: repo } }), /配置无效/);
});

test("插件桥接有界取消真实进程，不回显原始诊断", async () => {
  await assert.rejects(runJson("/usr/bin/false", []), /通知操作失败/);
  const controller = new AbortController();
  const pending = runJson(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /通知操作失败/);
});
