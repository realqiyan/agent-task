import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createTaskRuntime } from "../dist/application/task-runtime.js";
import { createExecution } from "../dist/integrations/acp/execution.js";
import { createCoordinator } from "../dist/integrations/coordinator/coordinator.js";
import { TaskStore } from "../dist/tasks/storage/store.js";
import { NodeSessions } from "../dist/tasks/sessions.js";
import { taskSchema } from "../dist/protocol/task-contract.js";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createRegistry, GenerationTask, Harness } from "@earendil-works/pi-durable";
import { openCoordinatorStorage } from "../dist/integrations/coordinator/storage.js";
import { memoryUpdateParameters, TaskMemory } from "../dist/integrations/coordinator/memory.js";

function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-conversation-"));
  const open = createExecution({ PATH: "/usr/bin:/bin" });
  const coordinate = createCoordinator(dir, { provider: "openai", model: "not-a-real-model" });
  const executor = { id: "local", type: "codex", nativePath: "/usr/bin/false", command: "/usr/bin/false", args: [], adapterVersion: null };
  const service = createTaskRuntime(dir, [executor], open, coordinate, error => { throw error; });
  const store = new TaskStore(dir), sessions = new NodeSessions(open, error => { throw error; });
  const task = service.definitions.create(taskSchema.parse({ workspace: dir, requestKey: "task", name: "Task", prompt: "Inspect authorized data",
    nodes: [{ id: "A", prompt: "Inspect", executorId: "local" }, { id: "B", prompt: "Review", executorId: "local", dependsOn: ["A"] }],
    schedule: { type: "now" } }));
  service.runs.trigger();
  const run = service.runs.list(task.id).items[0];
  t.after(async () => { await service.close(); await sessions.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, service, store, sessions, task, run, coordinate };
}

// Persisted business-state fixtures, not a model/provider or ACP server. These tests do not establish ACP success.
function review(f, runId, nodeId, output) {
  const run = f.store.run(runId), node = run.nodes.find(node => node.definition.id === nodeId);
  node.status = "awaiting_review"; node.startedAt = new Date().toISOString();
  node.turns.push({ prompt: "Stored context", output, stopReason: "end_turn", sessionId: null, contextMessageIds: [], messageIds: [],
    inputDeliveries: node.definition.dependsOn.map(id => run.nodes.find(node => node.definition.id === id).deliveryId) });
  f.store.commitRun(run);
  f.service.runs.accept(runId, nodeId, node.turns.length, output, "The recorded delivery satisfies this node.");
}
function observed(f, message) {
  f.store.saveMessages([{ ...message, status: "submitted", submissionId: "1" }]);
  f.service.runs.observe(f.task.id, message.runId, [message.id]);
}

test("ordinary input is idempotent, does not answer questions or reset budgets, and blocks stale decisions without losing active output", t => {
  const f = fixture(t), actions = f.service.supervisor.actions(f.run.id);
  actions.step();
  f.service.runs.prepareTurn(f.run.id, "A", undefined, f.sessions);
  const input = { taskId: f.task.id, requestKey: "facts", message: "Source X has a corrected count." };
  const receipt = f.service.supervisor.send(input);
  assert.deepEqual(f.service.supervisor.send({ ...input, execute: false }), receipt);
  assert.throws(() => f.service.supervisor.send({ ...input, message: "Different" }), /requestKey/);
  assert.equal(f.service.runs.get(f.run.id).steps, 1);
  assert.equal(f.service.runs.get(f.run.id).inputId, f.run.inputId);
  f.service.runs.record(f.run.id, "A", "output", null, "Original result");
  f.service.runs.completeTurn(f.run.id, "A", "end_turn");
  assert.equal(f.service.runs.get(f.run.id).nodes[0].turns[0].output, "Original result");
  assert.throws(() => f.service.runs.accept(f.run.id, "A", 1, "Original result", "Complete"), /Unprocessed/);
  assert.throws(() => actions.ask({ question: "Which count?", completedWork: "Turn ended" }), /Unprocessed/);
  assert.throws(() => actions.finish("Complete"), /Unprocessed/);
  observed(f, receipt);
  assert.throws(() => f.service.runs.accept(f.run.id, "A", 1, "Original result", "Complete"), /predates/);
  const question = actions.ask({ question: "Which source?", completedWork: "Old result needs clarification" });
  const discussion = f.service.supervisor.send({ taskId: f.task.id, requestKey: "chat", message: "Explain this question." });
  assert.equal(discussion.execute, false);
  const waiting = f.service.runs.get(f.run.id);
  assert.equal(waiting.status, "waiting_input");
  assert.equal(waiting.questions[0].reply, null);
  assert.equal(waiting.questions[0].expiresAt, question.expiresAt);
  assert.throws(() => f.service.supervisor.answer({ taskId: f.task.id, questionId: question.id, requestKey: "chat", answer: "X" }), /requestKey/);
  const page = f.service.conversations.list(f.task.id, 0, 1);
  assert.equal(page.items[0].id, receipt.id); // Internal execution input is not public history.
  assert.ok(page.next !== null);
  assert.notEqual(f.service.conversations.list(f.task.id, page.next, 1).items[0].id, receipt.id);
});

test("supplementary delivery preserves history, requires explicit intent and blocks downstream reuse until its dependencies are current", t => {
  const f = fixture(t);
  review(f, f.run.id, "A", "Original A"); review(f, f.run.id, "B", "Original B");
  const old = f.service.runs.get(f.run.id), oldA = old.nodes[0].deliveries[0], oldB = old.nodes[1].deliveries[0];
  const fact = f.service.supervisor.send({ taskId: f.task.id, requestKey: "correction", message: "The analysis needs a new fact." });
  observed(f, fact);
  assert.deepEqual(f.service.runs.get(f.run.id).nodes.map(node => node.status), ["stale", "stale"]);
  assert.throws(() => f.service.runs.prepareTurn(f.run.id, "A", "Add work", f.sessions), /explicit/);
  const intent = f.service.supervisor.send({ taskId: f.task.id, runId: f.run.id, requestKey: "additional", message: "Update A only; do not repeat external publication.", execute: true });
  observed(f, intent);
  const dispatch = f.service.runs.prepareTurn(f.run.id, "A", "Apply the relevant correction", f.sessions, [fact.id, intent.id]);
  assert.equal(dispatch.kind, "open"); // Known accepted work permits a new session, not a retry of unaccepted work.
  assert.deepEqual(f.service.runs.get(f.run.id).nodes[0].turns.at(-1).contextMessageIds, [fact.id, intent.id]);
  assert.throws(() => f.service.runs.accept(f.run.id, "B", 0, "", "Reuse", true), /dependencies/);
  f.service.runs.record(f.run.id, "A", "output", null, "Revised A");
  f.service.runs.completeTurn(f.run.id, "A", "end_turn");
  f.service.runs.accept(f.run.id, "A", 2, "Revised A", "The additional fact is included.");
  assert.throws(() => f.service.runs.finish(f.run.id, "Complete"), /current accepted/);
  f.service.runs.accept(f.run.id, "B", 0, "", "B remains valid after reviewing the new A and facts; no external operation repeated.", true);
  f.service.runs.finish(f.run.id, "Reviewed supplementary work");
  const finished = f.service.runs.get(f.run.id);
  assert.deepEqual(finished.nodes[0].deliveries[0], oldA);
  assert.deepEqual(finished.nodes[1].deliveries[0], oldB);
  assert.notEqual(finished.nodes[0].resultFile, oldA.path);
  assert.equal(readFileSync(oldA.path, "utf8"), "Original A");
  assert.equal(readFileSync(finished.nodes[0].resultFile, "utf8"), "Revised A");
  assert.equal(finished.nodes[1].deliveries[1].source.deliveryId, oldB.id);
  assert.deepEqual(finished.nodes[1].deliveries[1].inputDeliveries, [finished.nodes[0].deliveryId]);
});

test("idle dialogue does not reopen a Run; explicit supplementary Runs reuse only the same Task's successful baseline", t => {
  const f = fixture(t);
  review(f, f.run.id, "A", "A"); review(f, f.run.id, "B", "B");
  f.service.runs.finish(f.run.id, "Complete");
  const baseline = f.service.runs.get(f.run.id);
  f.service.definitions.controlSchedule({ taskId: f.task.id, action: "cancel" });
  const chat = f.service.supervisor.send({ taskId: f.task.id, requestKey: "discussion", message: "Explain the result." });
  assert.equal(chat.execute, false); assert.equal(chat.runId, null);
  assert.equal(f.service.runs.list(f.task.id).items.length, 1);
  observed(f, chat);
  const historical = f.service.supervisor.send({ taskId: f.task.id, runId: baseline.id,
    requestKey: "historical", message: "A note about the previous Run." });
  observed(f, historical);
  const request = { taskId: f.task.id, runId: baseline.id, requestKey: "new-work", message: "Revalidate these results without repeating publication.", execute: true };
  const receipt = f.service.supervisor.send(request), supplemental = f.service.runs.get(receipt.runId);
  assert.notEqual(supplemental.id, baseline.id);
  assert.equal(supplemental.scheduledAt, null);
  assert.deepEqual(supplemental.source, { type: "message", messageId: receipt.id, baseRunId: baseline.id });
  assert.deepEqual(f.service.supervisor.send(request), receipt);
  assert.throws(() => f.service.supervisor.send({ ...request, requestKey: "another" }), /active|running execution/);
  assert.ok(supplemental.nodes.every(node => node.turns.length === 0 && node.baseline !== null));
  observed(f, receipt);
  const actions = f.service.supervisor.actions(supplemental.id), view = actions.inspect(baseline.id);
  assert.equal(view.run.id, baseline.id);
  assert.ok(view.messages.some(message => message.id === historical.id));
  assert.equal(actions.readMessage(historical.id).content, historical.content);
  assert.equal(view.execution.runId, supplemental.id);
  assert.deepEqual(view.execution.contextMessages.map(message => message.id), [chat.id, receipt.id]);
  assert.throws(() => f.service.runs.prepareTurn(supplemental.id, "A", "Revise", f.sessions, [historical.id]), /contextMessageIds\[0\].*not eligible/);
  assert.ok(f.service.runs.get(supplemental.id).nodes.every(node => node.turns.length === 0));
  for (const node of ["A", "B"]) f.service.runs.accept(supplemental.id, node, 0, "", "Still satisfies this request; reuse with source attribution.", true);
  f.service.runs.finish(supplemental.id, "Explicitly revalidated");
  assert.deepEqual(f.service.runs.get(baseline.id), baseline);
  assert.ok(f.service.runs.get(supplemental.id).nodes.every(node => node.turns.length === 0 && node.startedAt === null));
  const third = f.service.supervisor.send({ ...request, requestKey: "uncertain" });
  observed(f, third);
  f.service.runs.prepareTurn(third.runId, "A", "Authorized additional analysis", f.sessions, [chat.id, third.id]);
  assert.deepEqual(f.service.runs.get(third.runId).nodes[0].turns[0].contextMessageIds, [chat.id, third.id]);
  f.service.runs.end(third.runId, "interrupted", "External outcome unknown");
  assert.throws(() => f.service.supervisor.send({ ...request, requestKey: "bypass" }), /Uncertain/);
  assert.equal(f.service.runs.list(f.task.id).items.length, 3);
});

test("typed memory sources resolve independently of note scope and retain precise ownership failures", t => {
  const f = fixture(t);
  review(f, f.run.id, "A", "Recorded A");
  const delivery = f.service.runs.get(f.run.id).nodes[0].deliveries[0];
  const question = f.service.supervisor.actions(f.run.id).ask({ question: "Which source?", completedWork: "A recorded" });
  const message = f.service.supervisor.send({ taskId: f.task.id, requestKey: "source", message: "Use source X." });
  assert.throws(() => f.service.conversations.readMessage(f.task.id, message.id), /observation boundary/);
  observed(f, message);
  const note = { key: "context", kind: "lesson", text: "A tentative interpretation, not a verified rule.", basis: "inferred",
    scope: { type: "task" }, sources: [
      { type: "task", taskId: f.task.id }, { type: "run", runId: f.run.id },
      { type: "message", messageId: message.id }, { type: "question", runId: f.run.id, questionId: question.id },
      { type: "delivery", runId: f.run.id, nodeId: "A", deliveryId: delivery.id },
    ] };
  const validate = value => f.service.conversations.validateMemory(f.task.id, [value]);
  const argumentsFor = value => validateToolArguments({ name: "task_memory_update", description: "", parameters: memoryUpdateParameters },
    { type: "toolCall", id: "memory-contract", name: "task_memory_update", arguments: { items: [value] } });
  validate(note);
  assert.deepEqual(argumentsFor(note), { items: [note] });
  validate({ ...note, scope: { type: "run", runId: f.run.id } });
  assert.throws(() => argumentsFor({ ...note, confirmed: true }));
  assert.throws(() => argumentsFor({ ...note, sources: [{ type: "message", questionId: question.id }] }));
  assert.throws(() => validate({ ...note, sources: [{ type: "message", messageId: question.id }] }),
    error => error.code === "validation" && /sources\[0\]\.messageId/.test(error.message));
  assert.throws(() => validate({ ...note, sources: [{ type: "delivery", runId: f.run.id, nodeId: "B", deliveryId: delivery.id }] }),
    error => error.code === "validation" && /sources\[0\]\.deliveryId/.test(error.message));
  assert.throws(() => validate({ ...note, scope: { type: "run", runId: randomUUID() } }),
    error => error.code === "validation" && /scope\.runId/.test(error.message));
  const other = f.service.definitions.create({ ...f.task.input, requestKey: "other-task" });
  f.service.runs.trigger();
  const otherRun = f.service.runs.list(other.id).items[0];
  const otherMessage = f.service.supervisor.send({ taskId: other.id, requestKey: "foreign", message: "Other Task data." });
  for (const source of [{ type: "task", taskId: other.id }, { type: "run", runId: otherRun.id },
    { type: "message", messageId: otherMessage.id }]) {
    assert.throws(() => validate({ ...note, sources: [source] }), /sources\[0\].*another Task/);
  }
  assert.throws(() => f.service.conversations.readMessage(f.task.id, otherMessage.id), /another Task/);
});

test("new input cannot extend elapsed Run time while its cancellation timer is pending", t => {
  const f = fixture(t);
  f.service.runs.admitCoordinator(f.run.id, Date.now() - f.task.input.maxRunSeconds * 1000 - 1000);
  f.service.supervisor.send({ taskId: f.task.id, requestKey: "late-fact", message: "Another fact, not a new budget." });
  assert.throws(() => f.service.supervisor.actions(f.run.id).step(), /execution budget elapsed/);
  const ended = f.service.runs.get(f.run.id);
  assert.equal(ended.status, "timed_out");
  assert.equal(ended.steps, 0);
  assert.ok(ended.nodes.every(node => node.turns.length === 0));
});

test("native SDK request preparation observes admitted input, while a memory hook failure blocks the provider boundary", async t => {
  const f = fixture(t);
  // Reserve and close a real loopback port. No HTTP/provider implementation or model response is fabricated.
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const key = "AGENT_TASK_TEST_UNREACHABLE_MODEL_KEY", previous = process.env[key];
  process.env[key] = "test-only-unused-key";
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const failures = [];
  const coordinate = createCoordinator(f.dir, { provider: "openai-compatible", model: "unreachable-local-endpoint",
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: key, api: "openai-completions", reasoning: false, contextWindow: 64000, maxTokens: 1024 }, error => { failures.push(error); });
  const execute = input => coordinate(f.task.id, input, f.service.supervisor.actions(f.run.id), new AbortController().signal);
  await assert.rejects(execute(f.service.conversations.get(f.run.inputId)), /Coordinator unanswered/);
  assert.equal(f.service.conversations.get(f.run.inputId).seen, true);
  const steps = f.service.runs.get(f.run.id).steps;
  assert.equal(steps, 1, "The native provider boundary was reached after request preparation");
  const harness = await Harness.open(await openCoordinatorStorage(f.dir, f.task.id), { models: createModels(), registry: createRegistry() }, context);
  try {
    const root = await harness.root(context);
    await root.commit(async tx => { (await tx.doc(TaskMemory, root.id)).items = [{ key: "invalid-source", kind: "fact", text: "Invalid stored reference",
      sources: [{ type: "message", messageId: randomUUID() }], scope: { type: "task" }, basis: "inferred" }]; }, context);
  } finally { await harness.close(context); }
  const next = f.service.supervisor.send({ taskId: f.task.id, requestKey: "memory-check", message: "Read my task context." });
  await assert.rejects(execute(next));
  assert.equal(f.service.conversations.get(next.id).seen, false);
  assert.equal(f.service.runs.get(f.run.id).steps, steps, "Fail-open SDK hooks must not reach the provider again");
  assert.ok(f.service.runs.get(f.run.id).nodes.every(node => node.turns.length === 0));
  assert.equal(failures.length, 0);
  const memoryEditor = await Harness.open(await openCoordinatorStorage(f.dir, f.task.id), { models: createModels(), registry: createRegistry() }, context);
  try {
    const root = await memoryEditor.root(context);
    await root.commit(async tx => { (await tx.doc(TaskMemory, root.id)).items = []; }, context);
  } finally { await memoryEditor.close(context); }
  const final = f.service.supervisor.send({ taskId: f.task.id, requestKey: "storage-failure", message: "Preserve this input before processing." });
  const db = new DatabaseSync(join(f.dir, "tasks.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_observation BEFORE UPDATE ON messages
      WHEN json_extract(NEW.data,'$.seen')=1 BEGIN SELECT RAISE(ABORT, 'observation rejected'); END`);
    await assert.rejects(execute(final), /storage closed|Task commit failed/);
    assert.equal(failures.length, 1, "SDK envelopes must report storage failure immediately to the application owner");
    assert.match(failures[0].message, /Task commit failed/);
    assert.equal(f.service.runs.healthy, false);
    assert.equal(f.store.message(final.id).seen, false);
    assert.ok(f.store.run(f.run.id).nodes.every(node => node.turns.length === 0));
  } finally { db.close(); }
});

test("terminal-Run receipt reconciliation reads durable state without scheduling pending SDK work", async t => {
  const f = fixture(t);
  const open = async () => Harness.open(await openCoordinatorStorage(f.dir, f.task.id), { models: createModels(), registry: createRegistry() }, context);
  let harness = await open();
  const root = await harness.root(context);
  const pendingId = await root.commit(async tx => {
    await tx.doc(TaskMemory, root.id);
    return tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } });
  }, context);
  f.service.conversations.bind(f.task.id, String(root.id));
  const pending = await harness.getTask(pendingId, context);
  assert.equal(pending.state.status, "pending");
  await harness.close(context);
  f.service.supervisor.cancel(f.run.id);
  f.service.supervisor.tick();
  for (let i = 0; i < 100 && f.service.supervisor.status().activeTaskIds.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.service.supervisor.status().activeTaskIds.length, 0);
  assert.equal(f.service.conversations.get(f.run.inputId).status, "failed");
  assert.equal(f.service.runs.get(f.run.id).status, "cancelled");
  harness = await open();
  try {
    assert.deepEqual(await harness.getTask(pendingId, context), pending);
  } finally { await harness.close(context); }
});

test("a published Task conversation binding rejects missing durable storage without creating an empty replacement", async t => {
  const f = fixture(t);
  const execute = () => f.coordinate(f.task.id, f.service.conversations.get(f.run.inputId), f.service.supervisor.actions(f.run.id), new AbortController().signal);
  await assert.rejects(execute(), /no_model/);
  assert.notEqual(f.store.get(f.task.id).conversationId, null);
  const path = join(f.dir, "coordinators", f.task.id + ".sqlite"), preserved = path + ".preserved";
  renameSync(path, preserved);
  await assert.rejects(execute(), /storage is missing/);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(preserved), true);
  assert.ok(f.service.runs.get(f.run.id).nodes.every(node => node.turns.length === 0));
});
