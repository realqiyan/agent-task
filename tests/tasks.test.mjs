import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../dist/task-storage.js";
import { Tasks } from "../dist/tasks.js";
import { Results } from "../dist/results.js";
import { executorSchema } from "../dist/model.js";
import { taskSchema } from "../dist/task-contract.js";
import { createExecution } from "../dist/node-execution.js";
import { createCoordinator } from "../dist/coordinator.js";

function executable(dir, name, command, args) {
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(join(dir, name), "#!/bin/sh\nexec " + [command, ...args].map(quote).join(" ") + "\n", { mode: 0o700 });
}
function fixture(t, command = "/usr/bin/false", args = [], nodes = [node("A"), node("B", ["A"])]) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-contract-"));
  const store = new TaskStore(dir);
  // Real failing/waiting OS processes, not ACP protocol imitations.
  executable(dir, "codex-acp", command, args);
  const executor = executorSchema.parse({ id: "local", type: "codex", cwd: dir, unattendedApproved: true });
  const executors = [executor];
  const service = new Tasks(store, executors, new Results(dir), createExecution({ PATH: dir }),
    createCoordinator(dir, { provider: "openai", model: "not-a-real-model" }), error => { throw error; });
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = taskSchema.parse({ requestKey: "task", name: "task", prompt: "Inspect authorized data", nodes, schedule: { type: "now" } });
  const task = service.create(input); service.trigger();
  const run = service.runs(task.id).items[0];
  return { dir, store, executor, executors, service, task, run, input };
}
const node = (id, dependsOn = []) => ({ id, prompt: "Inspect data", executorId: "local", dependsOn, maxRunSeconds: 5 });

test("a turn ending with a question is not a DAG delivery; only accepted excerpts unlock dependencies", async t => {
  const f = fixture(t);
  assert.deepEqual(f.run.nodes.map(node => node.definition), f.input.nodes);
  // Structured storage contract, not an imitation ACP/model execution.
  const run = f.store.run(f.run.id), a = run.nodes[0];
  a.status = "awaiting_review";
  a.turns = [{ prompt: "Inspect data", output: "Which source should I inspect?", stopReason: "end_turn" }];
  f.store.commit(undefined, run);
  assert.equal(f.service.run(run.id).nodes[0].resultFile, null);
  await assert.rejects(f.service.converse(run.id, "B"), /Dependencies/);
  assert.throws(() => f.service.actions(run.id).finish("Finished"), /accepted/);
  await assert.rejects(f.service.accept(run.id, "A", 1, "Invented answer", "complete"), /exact excerpt/);
  // A later, complete turn is selected explicitly; the earlier question stays only in the transcript.
  a.turns.push({ prompt: "Use source X", output: "Progress.\nSource X contains 3 records.\nDone.", stopReason: "end_turn" });
  f.store.commit(undefined, run);
  await assert.rejects(f.service.accept(run.id, "A", 1, "Which source should I inspect?", "complete"), /latest/);
  await f.service.accept(run.id, "A", 2, "Source X contains 3 records.", "The requested source and count are provided.");
  const accepted = f.service.run(run.id).nodes[0];
  assert.equal(readFileSync(accepted.resultFile, "utf8"), "Source X contains 3 records.");
  assert.equal(accepted.status, "succeeded");
  await assert.rejects(f.service.converse(run.id, "new"), /Unknown plan node/);
  const actions = f.service.actions(run.id);
  const question = actions.ask({ nodeId: "B", question: "Which source for B?", completedWork: "A accepted" });
  assert.equal(f.service.run(run.id).status, "waiting_input");
  assert.equal(f.service.run(run.id).nodes[1].status, "pending");
  await assert.rejects(f.service.converse(run.id, "B"), /not running/);
  const reply = { runId: run.id, questionId: question.id, requestKey: "answer-1", answer: "Use Y" };
  f.service.reply(reply, Date.parse(question.createdAt) + 1000);
  assert.equal(f.service.run(run.id).waitedMs, 1000);
  assert.equal(f.service.run(run.id).nodes[0].resultFile, accepted.resultFile);
  assert.equal(f.service.run(run.id).nodes[1].id, run.nodes[1].id);
  assert.throws(() => actions.step(), /Stale/);
  assert.deepEqual(f.service.reply(reply), f.service.run(run.id));
  assert.throws(() => f.service.reply({ ...reply, answer: "changed" }), /requestKey/);
  assert.throws(() => f.service.reply({ ...reply, requestKey: "another" }), /answered/);
});

test("DAG admission validates structure, assigned executors and deduplication before persisting; budgets remain enforced", async t => {
  const f = fixture(t);
  assert.equal(f.service.create(f.input).id, f.task.id);
  assert.throws(() => f.service.create({ ...f.input, nodes: [node("replacement")] }), /requestKey/);
  for (const [nodes, error] of [
    [[], /Too small/], [[node("A"), node("A")], /duplicate/],
    [[node("A", ["B"]), node("B", ["A"])], /Cyclic/], [[node("A", ["missing"])], /Unknown dependency/],
    [[{ ...node("A"), executorId: "unregistered" }], /not found or not approved/],
  ]) assert.throws(() => f.service.create({ ...f.input, requestKey: "invalid", nodes }), error);
  f.executor.unattendedApproved = false;
  assert.throws(() => f.service.create({ ...f.input, requestKey: "unapproved" }), /not found or not approved/);
  await assert.rejects(f.service.converse(f.run.id, "A"), /authorization/);
  assert.equal(f.service.run(f.run.id).nodes[0].startedAt, null);
  assert.equal(f.service.list().items.length, 1);
  const actions = f.service.actions(f.run.id);
  for (let i = 0; i < f.input.maxSteps; i++) actions.step();
  assert.throws(() => actions.step(), /budget/);
  assert.equal(f.service.run(f.run.id).status, "failed");
});

test("each run retains the caller DAG and dispatches only to the node's assigned executor", async t => {
  const f = fixture(t);
  // A real failing process proves executor selection, not successful ACP execution.
  executable(f.dir, "opencode", process.execPath, ["--eval", 'require("node:fs").writeFileSync("selected.txt", "other"); process.exit(1);']);
  f.executors.push(executorSchema.parse({ ...f.executor, id: "other", type: "opencode" }));
  const nodes = [node("A"), { ...node("B"), executorId: "other" }], now = Date.now();
  const task = f.service.create({ ...f.input, requestKey: "assigned", nodes,
    schedule: { type: "interval", startAt: new Date(now).toISOString(), seconds: 60 } }, now);
  assert.deepEqual(Object.keys(task.executors).sort(), ["local", "other"]);
  f.service.trigger(now);
  const first = f.service.runs(task.id).items[0];
  assert.deepEqual(first.nodes.map(node => node.definition), nodes);
  f.service.cancel(first.id);
  f.service.trigger(now + 60_000);
  const second = f.service.runs(task.id).items[1];
  assert.deepEqual(second.nodes.map(node => node.definition), nodes);
  assert.ok(second.nodes.every((node, index) => node.status === "pending" && node.id !== first.nodes[index].id));
  await assert.rejects(f.service.converse(second.id, "B"));
  assert.equal(readFileSync(join(f.dir, "selected.txt"), "utf8"), "other");
  const stopped = f.service.run(second.id);
  assert.equal(stopped.nodes[0].sessionId, null);
  assert.equal(stopped.nodes[0].turns.length, 0);
  assert.equal(stopped.nodes[1].turns[0].prompt, nodes[1].prompt);
  assert.deepEqual(stopped.nodes.map(node => node.definition), nodes);
});

test("recovery blocks uncertain ACP work, but keeps coordinator-only runs resumable", t => {
  const f = fixture(t);
  f.service.recover();
  assert.equal(f.service.run(f.run.id).status, "running");
  const run = f.store.run(f.run.id);
  run.nodes[0].status = "running";
  run.nodes[0].turns = [{ prompt: "operation", output: "", stopReason: null }];
  f.store.commit(undefined, run);
  f.service.recover();
  assert.equal(f.service.run(run.id).status, "interrupted");
  assert.deepEqual(f.service.run(run.id).nodes.map(n => n.status), ["interrupted", "blocked"]);
  assert.throws(() => f.service.actions(run.id).step(), /not running/);
});

test("real failing ACP process closes the run instead of allowing an automatic retry", { timeout: 10000 }, async t => {
  const f = fixture(t);
  await assert.rejects(f.service.converse(f.run.id, "A", "Replace the supplied prompt"), /First turn/);
  await assert.rejects(f.service.converse(f.run.id, "A"));
  assert.equal(f.service.run(f.run.id).nodes[0].turns[0].prompt, f.input.nodes[0].prompt);
  assert.equal(f.service.run(f.run.id).status, "interrupted");
  await assert.rejects(f.service.converse(f.run.id, "A"), /not running/);
});

test("cancellation and timeout stop real waiting ACP processes without producing deliveries", { timeout: 10000 }, async t => {
  const f = fixture(t, "/bin/sleep", ["30"]);
  const pending = f.service.converse(f.run.id, "A");
  const rejected = assert.rejects(pending);
  f.service.cancel(f.run.id);
  await rejected;
  assert.equal(f.service.run(f.run.id).status, "cancelled");
  assert.equal(f.service.run(f.run.id).nodes[0].resultFile, null);
  const timed = fixture(t, "/bin/sleep", ["30"], [{ ...node("A"), maxRunSeconds: 1 }]);
  await assert.rejects(timed.service.converse(timed.run.id, "A"));
  assert.equal(timed.service.run(timed.run.id).status, "timed_out");
  assert.equal(timed.service.run(timed.run.id).nodes[0].resultFile, null);
  const blocked = fixture(t, "/bin/sleep", ["30"]);
  const stopped = assert.rejects(blocked.service.converse(blocked.run.id, "A"));
  assert.throws(() => blocked.service.actions(blocked.run.id).ask({
    question: "Which source?", completedWork: "Turn still active",
  }), /all ACP turns/);
  blocked.service.actions(blocked.run.id).stop("failed", "Cannot safely continue");
  await stopped;
  assert.equal(blocked.service.run(blocked.run.id).status, "failed");
});

test("task_update affects future slots only, resumes without catch-up and rejects invalid actions without mutation", t => {
  const f = fixture(t), now = Date.now();
  const task = f.service.create({ ...f.input, requestKey: "interval", schedule: { type: "interval", startAt: new Date(now).toISOString(), seconds: 60 } }, now);
  f.service.trigger(now);
  const run = f.service.runs(task.id).items[0];
  f.service.update({ id: task.id, action: "pause" }, now);
  f.service.trigger(now + 120000);
  assert.equal(f.service.runs(task.id).items.length, 1);
  const resumed = f.service.update({ id: task.id, action: "resume" }, now + 150000);
  assert.equal(resumed.nextAt, now + 180000);
  assert.equal(f.service.run(run.id).status, "running");
  assert.throws(() => f.service.update({ id: task.id, action: "edit" }), { name: "ZodError" });
  assert.deepEqual(f.service.get(task.id), resumed);
  assert.throws(() => f.service.update({ id: task.id, action: "pause", prompt: "replace" }));
  f.service.update({ id: task.id, action: "cancel" });
  assert.equal(f.service.get(task.id).nextAt, null);
  assert.equal(f.service.run(run.id).status, "running");
  assert.throws(() => f.service.update({ id: task.id, action: "resume" }), /no future/);
});

test("task workspaces override registered cwd without changing authorization; actual failed process cwd persists", async t => {
  // A real Node process writes its cwd and exits. This proves process cwd, not successful ACP execution.
  const f = fixture(t, process.execPath, ["--eval", 'require("node:fs").writeFileSync("cwd-record.txt", process.cwd()); process.exit(1);']);
  const selected = join(f.dir, "selected workspace"); mkdirSync(selected);
  const alias = join(f.dir, "alias"); symlinkSync(selected, alias);
  for (const [key, workspace, expected] of [["override", alias, selected], ["default", undefined, f.dir]]) {
    const task = f.service.create({ ...f.input, requestKey: key, workspace });
    assert.equal(task.workspace, workspace ? selected : null);
    assert.equal(task.executors.local.cwd, f.dir);
    assert.equal(f.service.create({ ...f.input, requestKey: key, workspace }).id, task.id);
    f.service.trigger();
    const run = f.service.runs(task.id).items[0];
    await assert.rejects(f.service.converse(run.id, "A"));
    assert.equal(readFileSync(join(expected, "cwd-record.txt"), "utf8"), expected);
    assert.equal(f.service.run(run.id).nodes[0].workspace, expected);
    assert.equal(f.store.run(run.id).nodes[0].workspace, expected);
    assert.equal(f.service.run(run.id).status, "interrupted");
  }
  for (const workspace of ["relative", selected + "\\0", join(f.dir, "missing")]) {
    assert.throws(() => f.service.create({ ...f.input, requestKey: "invalid", workspace }));
  }
  const file = join(f.dir, "file"); writeFileSync(file, "data");
  assert.throws(() => f.service.create({ ...f.input, requestKey: "file", workspace: file }));
  const removed = join(f.dir, "removed"); mkdirSync(removed);
  const task = f.service.create({ ...f.input, requestKey: "removed", workspace: removed });
  f.service.trigger();
  const run = f.service.runs(task.id).items[0];
  rmSync(removed, { recursive: true }); symlinkSync(selected, removed);
  await assert.rejects(f.service.converse(run.id, "A"), /changed/);
  assert.equal(f.service.run(run.id).nodes[0].startedAt, null);
});

test("an unrelated database is rejected without changing its records", t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-old-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE history(text); INSERT INTO history VALUES('preserve');"); db.close();
  assert.throws(() => new TaskStore(dir), /no such table/);
  const reader = new DatabaseSync(path, { readOnly: true });
  assert.equal(reader.prepare("SELECT text FROM history").get().text, "preserve"); reader.close();
});
