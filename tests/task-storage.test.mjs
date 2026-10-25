import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTaskRuntime } from "../dist/application/task-runtime.js";
import { createExecution } from "../dist/integrations/acp/execution.js";
import { createCoordinator } from "../dist/integrations/coordinator/coordinator.js";
import { TaskStore } from "../dist/tasks/storage/store.js";
import { taskSchema } from "../dist/protocol/task-contract.js";

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-store-"));
  const executor = { id: "local", type: "codex", nativePath: "/usr/bin/false", command: "/usr/bin/false", args: [], adapterVersion: null };
  const failures = [];
  const runtime = createTaskRuntime(dir, [executor], createExecution({ PATH: "/missing" }),
    createCoordinator(dir, { provider: "openai", model: "not-a-real-model" }), error => { failures.push(error); });
  const input = taskSchema.parse({ workspace: dir, requestKey: "task", name: "  task  ", prompt: "Inspect",
    nodes: [{ id: "A", executorId: "local", prompt: "Inspect" }], schedule: { type: "now" } });
  const task = runtime.definitions.create(input);
  t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, task, runtime, failures };
}

test("stored records reject missing fields and noncanonical values without request defaults or repair", async t => {
  for (const variant of ["task-default", "run-default", "timestamp", "text", "cron", "timezone", "interval"]) {
    const f = fixture(t);
    f.runtime.runs.trigger(f.task.nextAt);
    await f.runtime.close();
    const db = new DatabaseSync(join(f.dir, "tasks.sqlite"));
    try {
      const table = variant === "run-default" ? "rounds" : "definitions";
      const row = db.prepare(`SELECT id,data FROM ${table}`).get(), record = JSON.parse(row.data);
      if (variant === "task-default") delete record.input.maxModelCalls;
      if (variant === "run-default") delete record.nodes[0].definition.dependsOn;
      if (variant === "timestamp") record.createdAt = record.createdAt.replace("Z", "+00:00");
      if (variant === "text") record.input.name = "  task  ";
      if (variant === "cron") record.input.schedule = { type: "cron", expression: "61 * * * *", timezone: "UTC" };
      if (variant === "timezone") record.input.schedule = { type: "cron", expression: "* * * * *", timezone: "invalid" };
      if (variant === "interval") record.input.schedule = { type: "interval", startAt: record.createdAt, seconds: 60 };
      const text = JSON.stringify(record);
      db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(text, row.id);
      assert.throws(() => new TaskStore(f.dir), /Invalid stored task data/);
      assert.equal(db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(row.id).data, text);
    } finally { db.close(); }
  }
});

test("a failed run admission rolls back its task cursor in the same SQLite transaction", async t => {
  const f = fixture(t), db = new DatabaseSync(join(f.dir, "tasks.sqlite"));
  try {
    db.exec("CREATE TRIGGER reject_admission BEFORE INSERT ON rounds BEGIN SELECT RAISE(ABORT, 'admission rejected'); END");
    assert.throws(() => f.runtime.runs.trigger(f.task.nextAt), /Task commit failed/);
    assert.equal(JSON.parse(db.prepare("SELECT data FROM definitions WHERE id=?").get(f.task.id).data).nextAt, f.task.nextAt);
    assert.equal(db.prepare("SELECT count(*) AS count FROM rounds").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM messages").get().count, 0);
    assert.equal(f.runtime.runs.healthy, false);
    assert.throws(() => f.runtime.runs.trigger(), /storage closed/);
  } finally { db.close(); }
});

test("failed dispatch persistence prevents worker creation and closes admission", async t => {
  const f = fixture(t);
  f.runtime.runs.trigger(f.task.nextAt);
  const run = f.runtime.runs.list().items[0];
  const db = new DatabaseSync(join(f.dir, "tasks.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_dispatch BEFORE UPDATE ON rounds
      WHEN json_extract(NEW.data,'$.nodes[0].status')='running'
      BEGIN SELECT RAISE(ABORT, 'dispatch rejected'); END`);
    await assert.rejects(f.runtime.supervisor.converse(run.id, "A"), /Task commit failed/);
    assert.equal(f.runtime.supervisor.status().activeNodeRunIds.length, 0);
    assert.equal(f.failures.length, 1);
    assert.equal(f.runtime.runs.healthy, false);
    const stored = JSON.parse(db.prepare("SELECT data FROM rounds WHERE id=?").get(run.id).data);
    assert.equal(stored.nodes[0].status, "pending");
    assert.equal(stored.nodes[0].turns.length, 0);
  } finally { db.close(); }
});
