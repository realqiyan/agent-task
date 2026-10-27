import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "../dist/infrastructure/sqlite.js";
import { acquireLauncherLock, acquireLock } from "../dist/infrastructure/lock.js";
import { TaskStore, taskStorageFormat } from "../dist/tasks/storage/store.js";
import { createTaskRuntime } from "../dist/application/task-runtime.js";
import { createExecution } from "../dist/integrations/acp/execution.js";
import { createCoordinator } from "../dist/integrations/coordinator/coordinator.js";
import { openCoordinatorStorage } from "../dist/integrations/coordinator/storage.js";
import { taskSchema } from "../dist/protocol/task-contract.js";

const cli = resolve("bin/task-conductor.mjs");
function fixture(t, external = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "task-conductor-migration-"));
  const home = join(root, "private"), dataDir = external ? join(root, "data") : join(home, "data");
  const user = join(root, "user"); mkdirSync(user, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args, "--home", home], {
    env: { PATH: "/usr/bin:/bin", HOME: user }, encoding: "utf8", timeout: 10_000,
  });
  const setup = invoke("setup", "--data-dir", dataDir, "--port", "0", "--generate-tokens", "--yes");
  assert.equal(setup.status, 0, setup.stderr);
  const store = new TaskStore(dataDir); store.close();
  const sql = statement => {
    const db = new DatabaseSync(join(dataDir, "tasks.sqlite"));
    try { return db.prepare(statement).all(); } finally { db.close(); }
  };
  return { root, home, dataDir, invoke, sql, backup: join(root, "backup") };
}
const success = result => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };

for (const external of [false, true]) test(`offline migration preserves records, sessions and backup (${external ? "external" : "nested"} data directory)`, async t => {
  const f = fixture(t, external);
  const runtime = createTaskRuntime(f.dataDir, [{ id: "local", type: "codex", nativePath: "/usr/bin/false", command: "/usr/bin/false", args: [], adapterVersion: null }],
    createExecution({ PATH: "/missing" }), createCoordinator(f.dataDir, { provider: "openai", model: "not-a-real-model" }), error => { throw error; });
  const task = runtime.definitions.create(taskSchema.parse({ requestKey: "migration", name: "迁移验证", prompt: "保留记录", workspace: f.root,
    nodes: [{ id: "A", executorId: "local", prompt: "保留记录" }], schedule: { type: "now" } }));
  runtime.runs.trigger(task.nextAt);
  const run = runtime.runs.list(task.id).items[0];
  runtime.supervisor.actions(run.id).ask({ question: "选择哪个来源？", completedWork: "尚未执行" });
  const storage = await openCoordinatorStorage(f.dataDir, task.id); await storage.close();
  runtime.conversations.bind(task.id, "persisted-conversation");
  await runtime.close();
  const before = Object.fromEntries(["definitions", "rounds", "messages"].map(table => [table, f.sql(`SELECT * FROM ${table}`)]));
  f.sql("DROP TABLE storage_format");
  const check = success(f.invoke("migrate", "--check", "--json"));
  assert.equal(check.migrationRequired, true); assert.equal(check.format, taskStorageFormat);
  assert.equal(existsSync(join(f.home, "migration.json")), false);
  const opened = new TaskStore(f.dataDir); opened.close();
  assert.equal(f.sql("SELECT name FROM sqlite_master WHERE name='storage_format'").length, 0, "normal startup never migrates");
  assert.notEqual(f.invoke("migrate", "--backup", f.backup).status, 0);
  assert.equal(existsSync(f.backup), false);
  const migrated = success(f.invoke("migrate", "--backup", f.backup, "--yes", "--json"));
  assert.equal(migrated.status, "completed");
  assert.equal(f.sql("SELECT version FROM storage_format")[0].version, taskStorageFormat);
  for (const table of Object.keys(before)) assert.deepEqual(f.sql(`SELECT * FROM ${table}`), before[table]);
  const backupData = external ? join(f.backup, "data") : join(f.backup, "home/data");
  const backupDb = new DatabaseSync(join(backupData, "tasks.sqlite"), { readOnly: true });
  try {
    assert.equal(backupDb.prepare("SELECT name FROM sqlite_master WHERE name='storage_format'").all().length, 0);
    for (const table of Object.keys(before)) assert.deepEqual(backupDb.prepare(`SELECT * FROM ${table}`).all(), before[table]);
  } finally { backupDb.close(); }
  assert(existsSync(join(backupData, "coordinators", task.id + ".sqlite")));
  assert.equal(statSync(f.backup).mode & 0o777, 0o700);
  const secrets = readFileSync(join(f.dataDir, "environment.json"), "utf8");
  assert.equal(readFileSync(join(backupData, "environment.json"), "utf8"), secrets);
  assert.equal(success(f.invoke("migrate", "--yes", "--json")).status, "current");
  // 持久阶段记录覆盖提交前后两种中断状态；续接不重建备份或重放任务。
  const progressPath = join(f.home, "migration.json");
  const completed = JSON.parse(readFileSync(progressPath, "utf8"));
  for (const committed of [false, true]) {
    if (!committed) f.sql("DROP TABLE storage_format");
    writeFileSync(progressPath, JSON.stringify({ ...completed, phase: "backed-up" }), { mode: 0o600 });
    assert.notEqual(f.invoke("start").status, 0);
    assert.notEqual(f.invoke("migrate", "--yes").status, 0);
    assert.equal(success(f.invoke("migrate", "--resume", "--yes", "--json")).status, "completed");
    for (const table of Object.keys(before)) assert.deepEqual(f.sql(`SELECT * FROM ${table}`), before[table]);
  }
});

test("migration refuses occupied storage, unsafe backup paths and unsupported schemas", async t => {
  const f = fixture(t); f.sql("DROP TABLE storage_format");
  for (const lock of [() => acquireLauncherLock(f.home), () => acquireLock(f.dataDir)]) {
    const release = await lock();
    try { assert.notEqual(f.invoke("migrate", "--backup", f.backup, "--yes").status, 0); }
    finally { await release(); }
    assert.equal(existsSync(f.backup), false);
  }
  for (const backup of [f.home, join(f.dataDir, "backup"), f.root]) {
    assert.notEqual(f.invoke("migrate", "--backup", backup, "--yes").status, 0);
  }
  symlinkSync(join(f.dataDir, "config.json"), join(f.dataDir, "unsafe-link"));
  assert.notEqual(f.invoke("migrate", "--backup", f.backup, "--yes").status, 0);
  assert.equal(f.sql("SELECT name FROM sqlite_master WHERE name='storage_format'").length, 0);
  assert.equal(existsSync(join(f.home, "migration.json")), false);
  rmSync(join(f.dataDir, "unsafe-link"));
  f.sql("DROP INDEX active_task_run");
  assert.notEqual(f.invoke("migrate", "--check").status, 0);
  f.sql("CREATE UNIQUE INDEX active_task_run ON rounds(task_id) WHERE json_extract(data,'$.status') IN ('running','waiting_input')");
  f.sql("DROP TABLE messages");
  assert.throws(() => new TaskStore(f.dataDir), /数据不完整/);
  assert.notEqual(f.invoke("migrate", "--check").status, 0);
  assert.notEqual(f.invoke("migrate", "--backup", join(f.root, "other-backup"), "--yes").status, 0);
  assert.equal(f.sql("SELECT name FROM sqlite_master WHERE name='messages'").length, 0);
});
