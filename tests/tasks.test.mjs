import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "../dist/task-storage.js";
import { Tasks } from "../dist/tasks.js";
import { Results } from "../dist/results.js";
import { executorSchema } from "../dist/model.js";
import { taskSchema } from "../dist/task-contract.js";
import { openExecution } from "../dist/node-execution.js";
import { createCoordinator } from "../dist/coordinator.js";

function fixture(t, command = "/usr/bin/false", args = []) {
  const dir = mkdtempSync(join(tmpdir(), "agent-task-contract-"));
  const store = new TaskStore(dir);
  const executor = executorSchema.parse({ id: "local", command, args, cwd: dir, unattendedApproved: true, resultReadRoots: [dir] });
  const service = new Tasks(store, [executor], new Results(dir), openExecution,
    createCoordinator(dir, { provider: "openai", model: "not-a-real-model" }), error => { throw error; });
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const input = taskSchema.parse({ requestKey: "task", name: "task", prompt: "Inspect authorized data", executorIds: ["local"], schedule: { type: "now" } });
  const task = service.create(input); service.trigger();
  const run = service.runs(task.id).items[0];
  return { dir, store, executor, service, task, run, input };
}
const node = (id, dependsOn = []) => ({ id, prompt: "Inspect data", executorId: "local", dependsOn, maxRunSeconds: 5 });

test("a turn ending with a question is not a DAG delivery; only accepted excerpts unlock dependencies", async t => {
  const f = fixture(t);
  f.service.plan(f.run.id, [node("A"), node("B", ["A"])]);
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
  assert.throws(() => f.service.plan(run.id, [node("new")]), /already committed/);
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

test("plan authorization, cycles, idempotent admission, and step budgets are enforced without model judgment", t => {
  const f = fixture(t);
  assert.equal(f.service.create(f.input).id, f.task.id);
  assert.throws(() => f.service.create({ ...f.input, prompt: "changed" }), /requestKey/);
  assert.throws(() => f.service.plan(f.run.id, [node("A", ["B"]), node("B", ["A"])]), /Cyclic/);
  assert.throws(() => f.service.plan(f.run.id, [{ ...node("A"), executorId: "unregistered" }]), /authorization/);
  const actions = f.service.actions(f.run.id);
  for (let i = 0; i < f.input.maxSteps; i++) actions.step();
  assert.throws(() => actions.step(), /budget/);
  assert.equal(f.service.run(f.run.id).status, "failed");
});

test("recovery blocks uncertain ACP work, but keeps coordinator-only runs resumable", t => {
  const f = fixture(t);
  f.service.plan(f.run.id, [node("A"), node("B", ["A"])]);
  f.service.recover();
  assert.equal(f.service.run(f.run.id).status, "running");
  const run = f.store.run(f.run.id);
  run.nodes[0].status = "running";
  run.nodes[0].turns = [{ prompt: "operation", output: "", stopReason: null }];
  f.store.commit(undefined, run);
  f.service.recover();
  assert.equal(f.service.run(run.id).status, "interrupted");
  assert.deepEqual(f.service.run(run.id).nodes.map(n => n.status), ["interrupted", "blocked"]);
  assert.throws(() => f.service.plan(run.id, [node("replacement")]), /not running/);
});

test("real failing ACP process closes the run instead of allowing an automatic retry", { timeout: 10000 }, async t => {
  const f = fixture(t);
  f.service.plan(f.run.id, [node("A")]);
  await assert.rejects(f.service.converse(f.run.id, "A"));
  assert.equal(f.service.run(f.run.id).status, "interrupted");
  await assert.rejects(f.service.converse(f.run.id, "A"), /not running/);
});

test("cancellation and timeout stop real waiting ACP processes without producing deliveries", { timeout: 10000 }, async t => {
  const f = fixture(t, "/usr/bin/sleep", ["30"]);
  f.service.plan(f.run.id, [node("A")]);
  const pending = f.service.converse(f.run.id, "A");
  const rejected = assert.rejects(pending);
  f.service.cancel(f.run.id);
  await rejected;
  assert.equal(f.service.run(f.run.id).status, "cancelled");
  assert.equal(f.service.run(f.run.id).nodes[0].resultFile, null);
  const timed = fixture(t, "/usr/bin/sleep", ["30"]);
  timed.service.plan(timed.run.id, [{ ...node("A"), maxRunSeconds: 1 }]);
  await assert.rejects(timed.service.converse(timed.run.id, "A"));
  assert.equal(timed.service.run(timed.run.id).status, "timed_out");
  assert.equal(timed.service.run(timed.run.id).nodes[0].resultFile, null);
  const blocked = fixture(t, "/usr/bin/sleep", ["30"]);
  blocked.service.plan(blocked.run.id, [node("A")]);
  const stopped = assert.rejects(blocked.service.converse(blocked.run.id, "A"));
  assert.throws(() => blocked.service.actions(blocked.run.id).ask({
    question: "Which source?", completedWork: "Turn still active",
  }), /all ACP turns/);
  blocked.service.actions(blocked.run.id).stop("failed", "Cannot safely continue");
  await stopped;
  assert.equal(blocked.service.run(blocked.run.id).status, "failed");
});

test("an unrelated database is rejected without changing its records", t => {
  const dir = mkdtempSync(join(tmpdir(), "agent-task-old-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "tasks.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE history(text); INSERT INTO history VALUES('preserve');"); db.close();
  assert.throws(() => new TaskStore(dir), /no such table/);
  const reader = new DatabaseSync(path, { readOnly: true });
  assert.equal(reader.prepare("SELECT text FROM history").get().text, "preserve"); reader.close();
});
