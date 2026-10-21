import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../dist/task-storage.js";
import { Tasks } from "../dist/tasks.js";
import { Results } from "../dist/results.js";
import { executorSchema } from "../dist/model.js";
import { taskSchema } from "../dist/task-contract.js";
import { openExecution } from "../dist/node-execution.js";
import { createCoordinator } from "../dist/coordinator.js";
import { coordinatorInput } from "../dist/human-input.js";
import { openCoordinatorStorage } from "../dist/coordinator-storage.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-task-input-"));
  const executor = executorSchema.parse({ id: "local", command: "/usr/bin/false", cwd: dir, unattendedApproved: true });
  const coordinate = createCoordinator(dir, { provider: "openai", model: "not-a-real-model" });
  let store = new TaskStore(dir), service = new Tasks(store, [executor], new Results(dir), openExecution, coordinate, error => { throw error; });
  const input = taskSchema.parse({ requestKey: "task", name: "task", prompt: "Inspect authorized data",
    executorIds: ["local"], schedule: { type: "interval", startAt: new Date(Date.now() + 1000).toISOString(), seconds: 60 } });
  const task = service.create(input);
  service.trigger(task.nextAt);
  const run = service.runs(task.id).items[0];
  t.after(async () => { await service.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, coordinate, task, run, get store() { return store; }, get service() { return service; },
    async reopen() {
      await service.close(); store.close();
      store = new TaskStore(dir);
      service = new Tasks(store, [executor], new Results(dir), openExecution, coordinate, error => { throw error; });
      service.recover();
    } };
}
const request = { question: "Which source?", completedWork: "No external work started" };
const reply = (run, question) => ({ runId: run.id, questionId: question.id, requestKey: "answer", answer: "Source X" });

test("waiting survives reopen, skips overlapping slots, and a persisted reply resumes the same durable conversation once", async t => {
  const f = fixture(t);
  const execute = () => f.coordinate(f.run.id, coordinatorInput(f.service.run(f.run.id)),
    f.service.actions(f.run.id), new AbortController().signal);
  // Real no-model error path, not successful model/ACP execution.
  await assert.rejects(execute(), /no_model/);
  const question = f.service.actions(f.run.id).ask(request);
  f.service.trigger(f.task.nextAt + 60_000);
  assert.equal(f.service.runs(f.task.id).items.at(-1).status, "skipped");
  await f.reopen();
  assert.equal(f.service.run(f.run.id).status, "waiting_input");
  f.service.reply(reply(f.run, question));
  const input = coordinatorInput(f.service.run(f.run.id));
  await f.reopen(); // Business reply committed before durable admission.
  assert.equal(coordinatorInput(f.service.run(f.run.id)).requestId, input.requestId);
  await assert.rejects(execute(), /no_model/);
  const inspect = async () => {
    const storage = await openCoordinatorStorage(f.dir, f.run.id);
    const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
    try {
      const root = await harness.root(context);
      return { root: root.id, initial: await storage.submissionByRequest(root.id, "run:" + f.run.id, context),
        answer: await storage.submissionByRequest(root.id, input.requestId, context) };
    } finally { await harness.close(context); }
  };
  const first = await inspect();
  assert.ok(first.initial); assert.ok(first.answer);
  assert.notEqual(first.initial.id, first.answer.id);
  await f.reopen(); // Durable admission committed before host completion.
  await assert.rejects(execute(), /no_model/);
  const second = await inspect();
  assert.equal(second.root, first.root);
  assert.equal(second.answer.id, first.answer.id);
  assert.equal(second.answer.reason, "no_model"); // Existing reply was not aborted/replaced.
  assert.equal(f.service.run(f.run.id).questions.length, 1);
});

test("a fast human reply is not failed by the previous coordinator finishing", async t => {
  const f = fixture(t);
  f.service.tick();
  const question = f.service.actions(f.run.id).ask(request);
  f.service.reply(reply(f.run, question));
  const drain = async () => {
    for (let i = 0; i < 100; i++) {
      if (!f.service.status().activeTaskRunIds.length) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Coordinator did not close");
  };
  await drain();
  assert.equal(f.service.run(f.run.id).status, "running");
  f.service.tick();
  await drain();
  assert.equal(f.service.run(f.run.id).status, "failed");
  assert.match(f.service.run(f.run.id).error, /no_model/);
});

test("expired and cancelled questions reject replies without reactivating work", async t => {
  const expired = fixture(t), cancelled = fixture(t);
  const question = expired.service.actions(expired.run.id).ask(request);
  assert.throws(() => expired.service.reply(reply(expired.run, question), Date.parse(question.expiresAt)), /not waiting/);
  assert.equal(expired.service.run(expired.run.id).status, "timed_out");
  assert.equal(expired.service.get(expired.task.id).status, "paused");
  const other = cancelled.service.actions(cancelled.run.id).ask(request);
  cancelled.service.cancel(cancelled.run.id);
  assert.throws(() => cancelled.service.reply(reply(cancelled.run, other)), /not waiting/);
  assert.equal(cancelled.service.run(cancelled.run.id).questions[0].reply, null);
});

test("missing ACP sessions and expired retention never authorize replay after a human answer", async t => {
  for (const mode of ["reply", "recovery", "retention"]) {
    const f = fixture(t);
    f.service.plan(f.run.id, [{ id: "A", prompt: "Inspect", executorId: "local", dependsOn: [], maxRunSeconds: 600 }]);
    // Persisted state contract only; no fabricated ACP server.
    const run = f.store.run(f.run.id);
    run.nodes[0].status = "awaiting_review"; run.nodes[0].startedAt = new Date().toISOString();
    run.nodes[0].turns = [{ prompt: "Inspect", output: "Which source?", stopReason: "end_turn" }];
    f.store.commit(undefined, run);
    const question = f.service.actions(run.id).ask({ ...request, nodeId: "A" });
    assert.ok(Date.parse(question.sessionExpiresAt) <= Date.parse(question.createdAt) + 300_000);
    if (mode === "reply") assert.throws(() => f.service.reply(reply(run, question)), /session unavailable/);
    else if (mode === "recovery") { await f.reopen(); assert.throws(() => f.service.reply(reply(run, question)), /not waiting/); }
    else assert.throws(() => f.service.reply(reply(run, question), Date.parse(question.sessionExpiresAt)), /not waiting/);
    assert.equal(f.service.run(run.id).status, "interrupted");
    assert.equal(f.service.run(run.id).questions[0].reply, null);
    await assert.rejects(f.service.converse(run.id, "A", "Continue"), /not running/);
  }
});
