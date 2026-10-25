import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openCoordinatorStorage } from "../../dist/integrations/coordinator/storage.js";
import { TaskMemory } from "../../dist/integrations/coordinator/memory.js";
import { startE2e, verifyDelivery } from "./harness.mjs";

// Observer only: the service is stopped; no resume, submit, memory writes or fabricated model responses.
async function snapshot(directory, taskId) {
  const storage = await openCoordinatorStorage(directory, taskId, true);
  let harness;
  try {
    assert.ok(await storage.conversation(ROOT_CONVERSATION_ID, context));
    harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, context);
    assert.equal((await harness.inspect(context)).scheduling, "paused");
    const root = await harness.root(context), tools = [];
    let cursor, inputMessageId = null;
    do {
      const page = await root.entries({ order: "ascending" }, 100, cursor, context);
      for (const entry of page.items) {
        if (entry.kind === "agent-task.input") inputMessageId = entry.data.messageId;
        for (const message of entry.model ?? []) if (message.role === "toolResult") tools.push({
          entryId: entry.id, inputMessageId, toolName: message.toolName, isError: message.isError,
          output: message.content.filter(block => block.type === "text").map(block => block.text).join("\n"),
        });
      }
      cursor = page.next;
    } while (cursor);
    return { conversationId: String(root.id), memory: await harness.snapshot(TaskMemory, root.id, context), tools,
      usage: await harness.usage(context) };
  } finally { if (harness) await harness.close(context); else await storage.close(context); }
}

function verifyQuote(text, marker, quantity, tag) {
  assert.ok(text.includes(marker), "Accepted delivery must retain the required marker");
  if (tag) assert.ok(text.includes(tag), "Supplementary delivery must use the saved reporting tag");
  const numbers = (text.replaceAll(marker, "").replaceAll(tag ?? "\0", "").match(/-?\b\d+(?:,\d{3})*(?:\.\d+)?\b/g) ?? [])
    .map(value => Number(value.replaceAll(",", "")));
  for (const value of [323, quantity, 323 * quantity]) assert.ok(numbers.includes(value), `Accepted delivery must contain ${value}`);
}

// Explicit, billable acceptance. Questions and follow-ups are declared user-role test inputs, not a live human.
test("real Task dialogue, persisted model-written memory, restart and supplementary ACP deliveries", { timeout: 720000 }, async t => {
  const e2e = await startE2e(t, { dependencies: true });
  const marker = `TASK-${randomBytes(8).toString("hex")}`, tag = `TAG-${randomBytes(8).toString("hex")}`;
  const task = await e2e.create({ maxSteps: 50, inputWaitSeconds: 300,
    prompt: `Produce an arithmetic quotation and an independent audit with marker ${marker}. Initially the quantity is missing: ask the user for it before starting any node. Only an explicit answer supplies that quantity. Later supplementary messages may change the quantity. Include any user-supplied reporting tag in both deliveries. This is a read-only calculation, not a purchase, publication or other external action.`,
    nodes: [
      { id: "quote", executorId: e2e.executor.id, dependsOn: [], maxRunSeconds: 180,
        prompt: `Calculate unit price 17 * 19 and multiply it by the current explicitly supplied quantity. Include ${marker}, the unit price, quantity, total and any supplied reporting tag in the delivery. Missing facts require clarification, never defaults. No tools or external actions are needed.` },
      { id: "audit", executorId: e2e.executor.id, dependsOn: ["quote"], maxRunSeconds: 180,
        prompt: `Read the accepted quote file using the read tool and independently verify its arithmetic. Include ${marker}, the unit price, quantity, total, any reporting tag and your conclusion. Only read the provided upstream file; do not write, publish or use shell/network tools.` },
    ],
  });
  const waiting = await e2e.waitFor("waiting_input");
  assert.ok(waiting.nodes.every(node => node.turns.length === 0));
  assert.equal(waiting.questions.length, 1);
  const discussion = await e2e.call("task_message_send", { taskId: task.taskId, requestKey: "waiting-discussion",
    message: "Please briefly explain what fact is missing. This is discussion, not an answer to the pending quantity question. Do not execute any node." });
  await e2e.waitMessage(discussion);
  const unchangedWait = await e2e.getRun();
  assert.equal(unchangedWait.status, "waiting_input");
  assert.equal(unchangedWait.steps, waiting.steps);
  assert.deepEqual(unchangedWait.questions, waiting.questions);
  assert.deepEqual(unchangedWait.nodes, waiting.nodes);
  await e2e.save("waiting-after-discussion.json", unchangedWait);

  const answer = await e2e.call("task_question_answer", { taskId: task.taskId, questionId: waiting.questions[0].questionId,
    requestKey: "initial-quantity", answer: "For this declared test fixture, the quantity is 3. No purchase or other external action is authorized." });
  assert.equal(answer.runId, waiting.runId);
  const initial = await e2e.waitFor("succeeded");
  await e2e.idle();
  await e2e.save("initial-run.json", initial);
  for (const node of initial.nodes) { await verifyDelivery(node); verifyQuote(node.result, marker, 3); }

  const noteRequest = { taskId: task.taskId, requestKey: "remember-tag",
    message: `Our reporting tag is ${tag}. Remember it for this Task's later quotations, record this message as its source and keep other applicable notes. This is discussion only; do not start ACP work.` };
  const note = await e2e.call("task_message_send", noteRequest);
  assert.equal(note.runId, null);
  await e2e.waitMessage(note);
  assert.equal((await e2e.call("task_message_send", noteRequest)).messageId, note.messageId);
  await e2e.idle();
  assert.deepEqual(await e2e.getRun(initial.runId), initial, "Idle memory discussion must not mutate the completed Run");
  assert.equal((await e2e.call("task_run_list", { taskId: task.taskId })).items.length, 1);
  const beforeRestart = await e2e.restart(directory => snapshot(directory, task.taskId));
  await e2e.save("memory-before-restart.json", beforeRestart);
  const saved = beforeRestart.memory.items.find(item => item.text.includes(tag));
  assert.equal(saved?.basis, "reported");
  assert.ok(saved.sources.some(source => source.type === "message" && source.messageId === note.messageId));
  assert.deepEqual(saved.scope, { type: "task" });
  assert.ok(beforeRestart.tools.some(tool => tool.inputMessageId === note.messageId && tool.toolName === "task_memory_update" && !tool.isError));

  const recall = await e2e.call("task_message_send", { taskId: task.taskId, requestKey: "recall-tag",
    message: "Retrieve my saved reporting tag using task_memory_read and tell me its exact value. Do not execute nodes or change the completed Run." });
  await e2e.waitMessage(recall);
  await e2e.idle();
  const messages = await e2e.messages(), recallIndex = messages.findIndex(item => item.messageId === recall.messageId);
  assert.ok(messages.slice(recallIndex + 1).some(item => item.role === "coordinator" && item.content.includes(tag)));
  assert.deepEqual(await e2e.getRun(initial.runId), initial);
  assert.equal((await e2e.call("task_run_list", { taskId: task.taskId })).items.length, 1);
  const afterRestart = await e2e.restart(directory => snapshot(directory, task.taskId));
  await e2e.save("memory-after-restart.json", afterRestart);
  assert.equal(afterRestart.conversationId, beforeRestart.conversationId);
  assert.ok(afterRestart.tools.some(tool => tool.inputMessageId === recall.messageId && tool.toolName === "task_memory_read" && !tool.isError && tool.output.includes(tag)));
  assert.ok(afterRestart.memory.items.some(item => item.text.includes(tag) && item.sources.some(source => source.type === "message" && source.messageId === note.messageId)));

  const supplementRequest = { taskId: task.taskId, runId: initial.runId, requestKey: "quantity-supplement", execute: true,
    message: "Explicit supplementary work: change the quantity to 5 and include my saved reporting tag. Produce a revised quote and have the dependent audit verify the new quote. Use the message that supplied the reporting tag together with this quantity update as selected node context, retain the fixed DAG and old deliveries, and perform no publication or other external action." };
  const supplement = await e2e.call("task_message_send", supplementRequest);
  assert.notEqual(supplement.runId, initial.runId);
  assert.equal((await e2e.call("task_message_send", supplementRequest)).messageId, supplement.messageId);
  const revised = await e2e.waitFor("succeeded", 240000, supplement.runId);
  await e2e.idle();
  await e2e.save("supplementary-run.json", revised);
  assert.equal(revised.scheduledAt, null);
  assert.deepEqual(revised.source, { type: "message", messageId: supplement.messageId, baseRunId: initial.runId });
  assert.deepEqual(revised.nodes.map(node => node.definition), task.input.nodes);
  for (let index = 0; index < revised.nodes.length; index++) {
    const node = revised.nodes[index], old = initial.nodes[index];
    await verifyDelivery(node); verifyQuote(node.result, marker, 5, tag);
    assert.equal(node.baseline.deliveryId, old.deliveryId);
    assert.notEqual(node.deliveryId, old.deliveryId);
    assert.notEqual(node.resultFile, old.resultFile);
    assert.notEqual(node.sessionId, old.sessionId, "New supplementary work must not impersonate the prior Run's session");
    assert.equal(await readFile(old.resultFile, "utf8"), old.result);
  }
  const quote = revised.nodes[0], audit = revised.nodes[1];
  assert.ok(quote.turns.some(turn => turn.contextMessageIds.includes(supplement.messageId)));
  assert.ok(quote.turns.some(turn => turn.contextMessageIds.includes(note.messageId)), "Task-scoped facts remain selectable in a supplementary Run");
  assert.ok(quote.turns.some(turn => turn.prompt.includes(tag)));
  assert.deepEqual(audit.inputFiles, [quote.resultFile]);
  assert.deepEqual(audit.deliveries.at(-1).inputDeliveries, [quote.deliveryId]);
  assert.deepEqual(await e2e.getRun(initial.runId), initial, "Supplementary work must leave the original Run immutable");
  assert.equal((await e2e.call("task_run_list", { taskId: task.taskId })).items.length, 2);
  const final = await e2e.restart(directory => snapshot(directory, task.taskId));
  await e2e.save("coordinator-evidence.json", final);
  assert.equal(final.conversationId, beforeRestart.conversationId);
  await e2e.messages();
  e2e.log("verification_passed", { taskId: task.taskId, originalRunId: initial.runId, supplementaryRunId: revised.runId,
    conversationId: final.conversationId, memorySourceMessageId: note.messageId, totals: [969, 1615] });
  t.diagnostic(`Verified Task ${task.taskId}: waiting discussion, model-written memory across restart, no idle ACP work, new supplementary deliveries and downstream review`);
});
