import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../dist/tasks/storage/store.js";
import { StorageError } from "../dist/shared/errors.js";
import { createTaskRuntime } from "../dist/application/task-runtime.js";
import { executorRecord } from "../dist/executors/validation.js";
import { taskSchema } from "../dist/protocol/task-contract.js";
import { createExecution } from "../dist/integrations/acp/execution.js";
import { createCoordinator } from "../dist/integrations/coordinator/coordinator.js";

function executable(dir, name, command, args) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(dir, name), "#!/bin/sh\nexec " + [command, ...args].map(quote).join(" ") + "\n", { mode: 0o700 });
}
function fixture(t, command = "/usr/bin/false", args = [], nodes = [node("A"), node("B", ["A"])], custom = false, cwd) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-contract-"));
  const store = new TaskStore(dir);
  // Real failing/waiting OS processes, not ACP protocol imitations.
  executable(dir, "codex-acp", command, args);
  const launch = custom ? { type: "custom", nativePath: realpathSync(command), command: realpathSync(command), args,
    ...(cwd === undefined ? {} : { cwd }) }
    : { type: "codex", nativePath: "/usr/bin/false", command: join(dir, "codex-acp"), args: [] };
  const executor = executorRecord.parse({ id: "local", ...launch, adapterVersion: null });
  const executors = [executor];
  let service = createTaskRuntime(dir, executors, createExecution({ PATH: dir }),
    createCoordinator(dir, { provider: "openai", model: "not-a-real-model" }), error => { throw error; });
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = taskSchema.parse({ workspace: dir, requestKey: "task", name: "task", prompt: "Inspect authorized data", nodes, schedule: { type: "now" } });
  const task = service.definitions.create(input); service.runs.trigger();
  const run = service.runs.list(task.id).items[0];
  return { dir, store, executor, executors, get service() { return service; }, task, run, input,
    async reopen() {
      await service.close();
      service = createTaskRuntime(dir, executors, createExecution({ PATH: dir }),
        createCoordinator(dir, { provider: "openai", model: "not-a-real-model" }), error => { throw error; });
      service.supervisor.recover();
    } };

}
const node = (id, dependsOn = []) => ({ id, prompt: "Inspect data", executorId: "local", dependsOn, maxRunSeconds: 5 });

test("a turn ending with a question is not a DAG delivery; only accepted excerpts unlock dependencies", async t => {
  const f = fixture(t);
  assert.deepEqual(f.run.nodes.map(node => node.definition), f.input.nodes);
  // Structured storage contract, not an imitation ACP/model execution.
  const run = f.store.run(f.run.id), a = run.nodes[0];
  a.status = "awaiting_review"; a.startedAt = new Date().toISOString();
  a.turns = [{ prompt: "Inspect data", output: "Which source should I inspect?", stopReason: "end_turn", sessionId: null, inputDeliveries: [], messageIds: [], contextMessageIds: [] }];
  f.store.commitRun( run);
  assert.equal(f.service.runs.get(run.id).nodes[0].resultFile, null);
  await assert.rejects(f.service.supervisor.converse(run.id, "B"), /Dependencies/);
  assert.throws(() => f.service.supervisor.actions(run.id).finish("Finished"), /accepted/);
  await assert.rejects(f.service.supervisor.actions(run.id).accept("A", 1, "Invented answer", "complete"), /exact excerpt/);
  // A later, complete turn is selected explicitly; the earlier question stays only in the transcript.
  a.turns.push({ prompt: "Use source X", output: "Progress.\nSource X contains 3 records.\nDone.", stopReason: "end_turn", sessionId: null, inputDeliveries: [], messageIds: [], contextMessageIds: [] });
  f.store.commitRun( run);
  await assert.rejects(f.service.supervisor.actions(run.id).accept("A", 1, "Which source should I inspect?", "complete"), /latest/);
  await f.service.supervisor.actions(run.id).accept("A", 2, "Source X contains 3 records.", "The requested source and count are provided.");
  const accepted = f.service.runs.get(run.id).nodes[0];
  assert.equal(readFileSync(accepted.resultFile, "utf8"), "Source X contains 3 records.");
  assert.equal(accepted.status, "succeeded");
  await assert.rejects(f.service.supervisor.converse(run.id, "new"), /Unknown plan node/);
  const actions = f.service.supervisor.actions(run.id);
  const question = actions.ask({ nodeId: "B", question: "Which source for B?", completedWork: "A accepted" });
  assert.equal(f.service.runs.get(run.id).status, "waiting_input");
  assert.equal(f.service.runs.get(run.id).nodes[1].status, "pending");
  await assert.rejects(f.service.supervisor.converse(run.id, "B"), /not running/);
  const reply = { taskId: run.taskId, questionId: question.id, requestKey: "answer-1", answer: "Use Y" };
  const receipt = f.service.supervisor.answer(reply, Date.parse(question.createdAt) + 1000);
  assert.equal(f.service.runs.get(run.id).waitedMs, 1000);
  assert.equal(f.service.runs.get(run.id).nodes[0].resultFile, accepted.resultFile);
  assert.equal(f.service.runs.get(run.id).nodes[1].id, run.nodes[1].id);
  assert.throws(() => actions.requestModel(), /Stale/);
  assert.deepEqual(f.service.supervisor.answer(reply), receipt);
  assert.throws(() => f.service.supervisor.answer({ ...reply, answer: "changed" }), /requestKey/);
  assert.throws(() => f.service.supervisor.answer({ ...reply, requestKey: "another" }), /answered/);
});

test("DAG admission validates structure, assigned executors and deduplication before persisting; budgets remain enforced", async t => {
  const f = fixture(t);
  assert.equal(f.service.definitions.create(f.input).id, f.task.id);
  assert.throws(() => f.service.definitions.create({ ...f.input, nodes: [node("replacement")] }), /requestKey/);
  for (const [nodes, error] of [
    [[], /Too small/], [[node("A"), node("A")], /duplicate/],
    [[node("A", ["B"]), node("B", ["A"])], /Cyclic/], [[node("A", ["missing"])], /Unknown dependency/],
    [[{ ...node("A"), executorId: "unregistered" }], /not ready/],
  ]) assert.throws(() => f.service.definitions.create({ ...f.input, requestKey: "invalid", nodes }), error);
  f.executors.splice(0);
  await f.reopen();
  assert.throws(() => f.service.definitions.create({ ...f.input, requestKey: "unapproved" }), /not ready/);
  await assert.rejects(f.service.supervisor.converse(f.run.id, "A"), /not ready/);
  assert.equal(f.service.runs.get(f.run.id).nodes[0].startedAt, null);
  assert.equal(f.service.definitions.list().items.length, 1);
  const actions = f.service.supervisor.actions(f.run.id);
  for (let i = 0; i < f.input.maxModelCalls; i++) actions.requestModel();
  assert.throws(() => actions.requestModel(), /模型请求额度/);
  assert.equal(f.service.runs.get(f.run.id).status, "failed");
});

test("each run retains the caller DAG and dispatches only to the node's assigned executor", async t => {
  const f = fixture(t);
  // A real failing process proves executor selection, not successful ACP execution.
  executable(f.dir, "opencode", process.execPath, ["--eval", 'require("node:fs").writeFileSync("selected.txt", "other"); process.exit(1);']);
  f.executors.push(executorRecord.parse({ ...f.executor, id: "other", type: "opencode", nativePath: join(f.dir, "opencode"), command: join(f.dir, "opencode"), args: ["acp"] }));
  await f.reopen();
  const nodes = [node("A"), { ...node("B"), executorId: "other" }], now = Math.floor(Date.now() / 60_000) * 60_000;
  const task = f.service.definitions.create({ ...f.input, requestKey: "assigned", nodes,
    schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" } }, now - 1);
  assert.deepEqual(Object.keys(task.executors).sort(), ["local", "other"]);
  f.service.runs.trigger(now);
  const first = f.service.runs.list(task.id).items[0];
  assert.deepEqual(first.nodes.map(node => node.definition), nodes);
  f.service.supervisor.cancel(first.id);
  f.service.runs.trigger(now + 60_000);
  const second = f.service.runs.list(task.id).items[1];
  assert.deepEqual(second.nodes.map(node => node.definition), nodes);
  assert.ok(second.nodes.every((node, index) => node.status === "pending" && node.id !== first.nodes[index].id));
  await assert.rejects(f.service.supervisor.converse(second.id, "B"));
  assert.equal(readFileSync(join(f.dir, "selected.txt"), "utf8"), "other");
  const stopped = f.service.runs.get(second.id);
  assert.equal(stopped.nodes[0].sessionId, null);
  assert.equal(stopped.nodes[0].turns.length, 0);
  assert.equal(stopped.nodes[1].turns.length, 1);
  assert.deepEqual(stopped.nodes.map(node => node.definition), nodes);
});

test("recovery blocks uncertain ACP work, but keeps coordinator-only runs resumable", t => {
  const f = fixture(t);
  f.service.supervisor.recover();
  assert.equal(f.service.runs.get(f.run.id).status, "running");
  const run = f.store.run(f.run.id);
  run.nodes[0].status = "running"; run.nodes[0].startedAt = new Date().toISOString();
  run.nodes[0].turns = [{ prompt: "operation", output: "", stopReason: null, sessionId: null, inputDeliveries: [], messageIds: [], contextMessageIds: [] }];
  f.store.commitRun( run);
  f.service.supervisor.recover();
  assert.equal(f.service.runs.get(run.id).status, "interrupted");
  assert.deepEqual(f.service.runs.get(run.id).nodes.map(n => n.status), ["interrupted", "blocked"]);
  assert.throws(() => f.service.supervisor.actions(run.id).requestModel(), /not running/);
});

test("real failing ACP process closes the run instead of allowing an automatic retry", { timeout: 10000 }, async t => {
  for (const custom of [false, true]) {
    const f = fixture(t, "/usr/bin/false", custom ? ["literal argument"] : [], undefined, custom);
    await assert.rejects(f.service.supervisor.converse(f.run.id, "A", "Inspect the authorized source"));
    await assert.rejects(f.service.supervisor.converse(f.run.id, "A"));
    assert.deepEqual(f.service.runs.get(f.run.id).nodes[0].definition, f.input.nodes[0]);
    assert.equal(f.service.runs.get(f.run.id).status, "interrupted");
    await assert.rejects(f.service.supervisor.converse(f.run.id, "A"), /not running/);
  }
});

test("cancellation and timeout stop real waiting ACP processes without producing deliveries", { timeout: 10000 }, async t => {
  const f = fixture(t, "/bin/sleep", ["30"]);
  const pending = f.service.supervisor.converse(f.run.id, "A");
  const rejected = assert.rejects(pending);
  f.service.supervisor.cancel(f.run.id);
  await rejected;
  assert.equal(f.service.runs.get(f.run.id).status, "cancelled");
  assert.equal(f.service.runs.get(f.run.id).nodes[0].resultFile, null);
  const timed = fixture(t, "/bin/sleep", ["30"], [{ ...node("A"), maxRunSeconds: 1 }]);
  await assert.rejects(timed.service.supervisor.converse(timed.run.id, "A"));
  assert.equal(timed.service.runs.get(timed.run.id).status, "timed_out");
  assert.equal(timed.service.runs.get(timed.run.id).nodes[0].resultFile, null);
  const blocked = fixture(t, "/bin/sleep", ["30"]);
  const stopped = assert.rejects(blocked.service.supervisor.converse(blocked.run.id, "A"));
  assert.throws(() => blocked.service.supervisor.actions(blocked.run.id).ask({
    question: "Which source?", completedWork: "Turn still active",
  }), /all ACP turns/);
  blocked.service.supervisor.actions(blocked.run.id).stop("failed", "Cannot safely continue");
  await stopped;
  assert.equal(blocked.service.runs.get(blocked.run.id).status, "failed");
});

test("task_schedule_control affects future slots only, resumes without catch-up and rejects invalid actions without mutation", t => {
  const f = fixture(t), now = Math.floor(Date.now() / 60_000) * 60_000;
  const task = f.service.definitions.create({ ...f.input, requestKey: "cron", schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" } }, now - 1);
  f.service.runs.trigger(now);
  const run = f.service.runs.list(task.id).items[0];
  f.service.definitions.controlSchedule({ taskId: task.id, action: "pause" }, now);
  f.service.runs.trigger(now + 120000);
  assert.equal(f.service.runs.list(task.id).items.length, 1);
  const resumed = f.service.definitions.controlSchedule({ taskId: task.id, action: "resume" }, now + 150000);
  assert.equal(resumed.nextAt, now + 180000);
  assert.equal(f.service.runs.get(run.id).status, "running");
  assert.throws(() => f.service.definitions.controlSchedule({ taskId: task.id, action: "edit" }), { name: "ZodError" });
  assert.deepEqual(f.service.definitions.get(task.id), resumed);
  assert.throws(() => f.service.definitions.controlSchedule({ taskId: task.id, action: "pause", prompt: "replace" }));
  f.service.definitions.controlSchedule({ taskId: task.id, action: "cancel" });
  assert.equal(f.service.definitions.get(task.id).nextAt, null);
  assert.equal(f.service.runs.get(run.id).status, "running");
  assert.throws(() => f.service.definitions.controlSchedule({ taskId: task.id, action: "resume" }), /no future/);
});

test("Cron admission persists calendar slots, counts misses without catch-up, skips overlaps and respects the cutoff", async t => {
  const f = fixture(t), now = Date.UTC(2026, 0, 1, 9);
  const schedule = { type: "cron", expression: "*/5 9-17 * * 1-5", timezone: "UTC" };
  const expiresAt = new Date(now + 30 * 60_000).toISOString();
  assert.throws(() => f.service.definitions.create({ ...f.input, requestKey: "invalid-cutoff", schedule,
    expiresAt: new Date(now).toISOString() }, now - 1), /Deadline/);
  const input = { ...f.input, requestKey: "calendar", schedule, expiresAt };
  const task = f.service.definitions.create(input, now - 1);
  assert.equal(task.nextAt, now);
  assert.equal(f.service.definitions.create(input, now + 1).id, task.id);
  f.service.runs.trigger(now - 1);
  assert.equal(f.service.runs.list(task.id).items.length, 0);
  f.service.runs.trigger(now + 16 * 60_000);
  const missed = f.service.runs.list(task.id).items[0];
  assert.equal(missed.scheduledAt, now + 15 * 60_000);
  assert.equal(missed.status, "skipped");
  assert.equal(missed.skippedCount, 4);
  f.service.runs.trigger(now + 20 * 60_000 + 20_000);
  const run = f.service.runs.list(task.id).items[1];
  assert.equal(run.status, "running");
  assert.equal(run.skippedCount, 0);
  f.service.runs.trigger(now + 25 * 60_000);
  const overlap = f.service.runs.list(task.id).items[2];
  assert.equal(overlap.status, "skipped");
  assert.equal(overlap.skippedCount, 1);
  assert.match(overlap.error, /Previous round/);
  await f.reopen();
  assert.equal(f.service.definitions.get(task.id).nextAt, now + 30 * 60_000);
  assert.deepEqual(f.service.definitions.get(task.id).input.schedule, schedule);
  f.service.runs.trigger(now + 30 * 60_000);
  assert.equal(f.service.definitions.get(task.id).scheduleStatus, "expired");
  assert.equal(f.service.definitions.get(task.id).nextAt, null);
  assert.equal(f.service.runs.list(task.id).items.length, 3);
  assert.equal(f.service.runs.get(run.id).status, "running");
});

test("custom process cwd defaults to the task workspace or uses its registered directory without changing task records", async t => {
  const startup = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-startup-"));
  try {
    for (const cwd of [undefined, startup]) {
      // Real failing process: this checks process startup and persistence, not successful ACP session setup.
      const f = fixture(t, process.execPath,
        ["--eval", 'require("node:fs").writeFileSync("cwd-record.txt", process.cwd()); process.exit(1);'], undefined, true, cwd);
      const expected = cwd ?? f.task.workspace;
      await assert.rejects(f.service.supervisor.converse(f.run.id, "A"));
      assert.equal(readFileSync(join(expected, "cwd-record.txt"), "utf8"), expected);
      assert.equal(f.service.runs.get(f.run.id).nodes[0].workspace, f.task.workspace);
      assert.equal(f.service.definitions.get(f.task.id).workspace, f.dir);
      assert.equal(f.service.definitions.get(f.task.id).executors.local.cwd, cwd);
      await f.reopen();
      assert.equal(f.service.definitions.get(f.task.id).executors.local.cwd, cwd);
      assert.equal(f.store.run(f.run.id).nodes[0].workspace, f.task.workspace);
    }
  } finally { rmSync(startup, { recursive: true, force: true }); }
});

test("task workspaces are canonical and immutable; actual failed process cwd persists", async t => {
  // A real Node process writes its cwd and exits. This proves process cwd, not successful ACP execution.
  const f = fixture(t, process.execPath, ["--eval", 'require("node:fs").writeFileSync("cwd-record.txt", process.cwd()); process.exit(1);']);
  const selected = join(f.dir, "selected workspace"); mkdirSync(selected);
  const alias = join(f.dir, "alias"); symlinkSync(selected, alias);
  for (const [key, workspace, expected] of [["override", alias, selected], ["launch", f.dir, f.dir]]) {
    const task = f.service.definitions.create({ ...f.input, requestKey: key, workspace });
    assert.equal(task.workspace, expected);
    assert.equal(task.executors.local.nativePath, "/usr/bin/false");
    assert.equal(f.service.definitions.create({ ...f.input, requestKey: key, workspace }).id, task.id);
    f.service.runs.trigger();
    const run = f.service.runs.list(task.id).items[0];
    await assert.rejects(f.service.supervisor.converse(run.id, "A"));
    assert.equal(readFileSync(join(expected, "cwd-record.txt"), "utf8"), expected);
    assert.equal(f.service.runs.get(run.id).nodes[0].workspace, expected);
    assert.equal(f.store.run(run.id).nodes[0].workspace, expected);
    assert.equal(f.service.runs.get(run.id).status, "interrupted");
  }
  for (const workspace of ["relative", selected + "\\0", join(f.dir, "missing")]) {
    assert.throws(() => f.service.definitions.create({ ...f.input, requestKey: "invalid", workspace }));
  }
  const file = join(f.dir, "file"); writeFileSync(file, "data");
  assert.throws(() => f.service.definitions.create({ ...f.input, requestKey: "file", workspace: file }));
  const removed = join(f.dir, "removed"); mkdirSync(removed);
  const task = f.service.definitions.create({ ...f.input, requestKey: "removed", workspace: removed });
  f.service.runs.trigger();
  const run = f.service.runs.list(task.id).items[0];
  rmSync(removed, { recursive: true }); symlinkSync(selected, removed);
  await assert.rejects(f.service.supervisor.converse(run.id, "A"), /changed/);
  assert.equal(f.service.runs.get(run.id).nodes[0].startedAt, null);
});

test("creation keys are scoped to the final workspace, including canonical aliases", t => {
  const f = fixture(t);
  const second = join(f.dir, "second"); mkdirSync(second);
  const alias = join(f.dir, "second-alias"); symlinkSync(second, alias);
  const task = f.service.definitions.create({ ...f.input, workspace: second });
  assert.notEqual(task.id, f.task.id);
  assert.equal(f.service.definitions.create({ ...f.input, workspace: alias }).id, task.id);
  assert.throws(() => f.service.definitions.create({ ...f.input, workspace: second, prompt: "Changed" }), /requestKey/);
  assert.throws(() => f.service.definitions.create({ ...f.input, workspace: undefined }), /workspace is required/);
  assert.equal(f.store.definitions().length, 2);
});

test("an unrelated database is rejected without changing its records", t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-old-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE history(text); INSERT INTO history VALUES('preserve');"); db.close();
  assert.throws(() => new TaskStore(dir), StorageError);
  const reader = new DatabaseSync(path, { readOnly: true });
  assert.equal(reader.prepare("SELECT text FROM history").get().text, "preserve"); reader.close();
});

test("an actual executor process observes committed dispatch intent before doing work", async t => {
  const f = fixture(t, process.execPath, ["--input-type=module", "--eval", `
    import { DatabaseSync } from 'node:sqlite';
    import { writeFileSync } from 'node:fs';
    const db = new DatabaseSync('tasks.sqlite', { readOnly: true });
    const run = JSON.parse(db.prepare('SELECT data FROM rounds LIMIT 1').get().data);
    writeFileSync('observed.json', JSON.stringify({ status: run.nodes[0].status, turns: run.nodes[0].turns.length }));
    db.close(); process.exit(1);
  `]);
  await assert.rejects(f.service.supervisor.converse(f.run.id, "A"));
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, "observed.json"), "utf8")), { status: "running", turns: 1 });
  assert.equal(f.service.runs.get(f.run.id).status, "interrupted");
});

test("shutdown closes real waiting execution once, rejects late output and preserves the no-replay barrier", async t => {
  const f = fixture(t, "/bin/sleep", ["30"]);
  const turn = assert.rejects(f.service.supervisor.converse(f.run.id, "A"));
  const close = f.service.close();
  assert.equal(f.service.close(), close);
  assert.throws(() => f.service.definitions.create(f.input), /closed/);
  assert.throws(() => f.service.runs.trigger(), /closed/); assert.throws(() => f.service.conversations.list(f.task.id), /closed/);
  assert.throws(() => f.service.runs.record(f.run.id, "A", "output", null, "late"), /closed/);
  assert.throws(() => f.service.supervisor.tick(), /closed/);
  await close; await turn;
  assert.equal(f.service.supervisor.status().activeNodeRunIds.length, 0);
  assert.equal(f.store.run(f.run.id).status, "interrupted");
  assert.equal(f.store.run(f.run.id).nodes[0].turns[0].output, "");
  await f.reopen();
  await assert.rejects(f.service.supervisor.converse(f.run.id, "A"), /not running/);
});

test("cancelling an open external turn pauses future slots and late events cannot overwrite cancellation", async t => {
  const f = fixture(t, "/bin/sleep", ["30"]), now = Math.floor(Date.now() / 60_000) * 60_000;
  const task = f.service.definitions.create({ ...f.input, requestKey: "uncertain-cancel",
    schedule: { type: "cron", expression: "* * * * *", timezone: "UTC" } }, now - 1);
  f.service.runs.trigger(now);
  const run = f.service.runs.list(task.id).items[0];
  const pending = assert.rejects(f.service.supervisor.converse(run.id, "A"));
  f.service.supervisor.cancel(run.id);
  assert.throws(() => f.service.runs.record(run.id, "A", "output", null, "late"), /not running/);
  assert.throws(() => f.service.runs.completeTurn(run.id, "A", "end_turn"), /not running/);
  await pending;
  assert.equal(f.service.runs.get(run.id).status, "cancelled");
  assert.equal(f.service.definitions.get(task.id).scheduleStatus, "paused");
  assert.throws(() => f.service.definitions.controlSchedule({ taskId: task.id, action: "resume" }), /uncertain external outcomes/);
  f.service.runs.trigger(now + 60_000);
  assert.equal(f.service.runs.list(task.id).items.length, 1);
  // A previously persisted active cursor must not bypass the same dispatch guard on restart.
  const active = f.store.get(task.id); active.scheduleStatus = "active"; f.store.saveDefinition(active);
  await f.reopen();
  f.service.runs.trigger(now + 120_000);
  assert.equal(f.service.runs.list(task.id).items.length, 1);
  assert.equal(f.service.definitions.get(task.id).scheduleStatus, "paused");
});
