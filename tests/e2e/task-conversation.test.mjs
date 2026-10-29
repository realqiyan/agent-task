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
    const root = await harness.root(context), tools = [], submissions = [];
    let cursor, inputMessageId = null;
    do {
      const page = await root.entries({ order: "ascending" }, 100, cursor, context);
      for (const entry of page.items) {
        if (entry.kind === "agent-task.input") {
          inputMessageId = entry.data.messageId;
          submissions.push(await storage.submissionByRequest(root.id, inputMessageId, context));
        }
        for (const message of entry.model ?? []) if (message.role === "toolResult") tools.push({
          entryId: entry.id, inputMessageId, toolName: message.toolName, isError: message.isError,
          output: message.content.filter(block => block.type === "text").map(block => block.text).join("\n"),
        });
      }
      cursor = page.next;
    } while (cursor);
    return { conversationId: String(root.id), memory: await harness.snapshot(TaskMemory, root.id, context), tools, submissions,
      usage: await harness.usage(context) };
  } finally { if (harness) await harness.close(context); else await storage.close(context); }
}

// A caller-defined data contract, not an arithmetic or open-ended review benchmark.
function verifyRecord(text, marker, quantity, tag = null) {
  assert.deepEqual(JSON.parse(text), { marker, quantity, tag });
}

// Explicit, billable acceptance. Questions and follow-ups are declared user-role test inputs, not a live human.
test("real Task dialogue, persisted model-written memory, restart and supplementary ACP deliveries", { timeout: 720000 }, async t => {
  const e2e = await startE2e(t, { dependencies: true });
  const marker = `TASK-${randomBytes(8).toString("hex")}`, tag = `TAG-${randomBytes(8).toString("hex")}`;
  const task = await e2e.create({ maxModelCalls: 25, inputWaitSeconds: 300,
    prompt: `生成标识为 ${marker} 的记录及下游副本。初始缺少数量，启动任何节点前先询问用户；只有明确回答才提供数量。后续补充消息可以修改数量。两份交付都包含用户提供的报告 tag，未提供时用 null。每份交付只包含 marker、quantity、tag 的 JSON 对象，不加围栏或说明。核对字面字段，不做算术或领域判断。这只是只读数据传递，不是购买、发布或其他外部操作。`,
    nodes: [
      { id: "record", executorId: e2e.executor.id, dependsOn: [], maxRunSeconds: 180,
        prompt: `只返回 JSON 对象，marker 为 "${marker}"，quantity 为当前明确提供的数值数量，tag 为已提供的字符串报告标签，未提供则为 null。使用 marker、quantity、tag 三个键。缺少数量时请求澄清，不使用默认值。不计算、不添加说明、不使用工具。` },
      { id: "copy", executorId: e2e.executor.id, dependsOn: ["record"], maxRunSeconds: 180,
        prompt: "用 read 读取已验收上游记录。只返回其中的 JSON 对象，原样保留 marker、quantity、tag。不计算、不添加说明或索取其他事实。只读提供的上游文件，不写入、不发布、不使用 shell 或网络工具。" },
    ],
  });
  const waiting = await e2e.waitFor("waiting_input");
  assert.ok(waiting.nodes.every(node => node.turns.length === 0));
  assert.equal(waiting.questions.length, 1);
  const discussion = await e2e.call("task_message_send", { taskId: task.taskId, requestKey: "waiting-discussion",
    message: "请简要说明缺少什么事实。这只是讨论，不是对待决数量问题的回答。不要执行任何节点。" });
  await e2e.waitMessage(discussion);
  const unchangedWait = await e2e.getRun();
  assert.equal(unchangedWait.status, "waiting_input");
  assert.equal(unchangedWait.modelCalls, waiting.modelCalls);
  assert.deepEqual(unchangedWait.questions, waiting.questions);
  assert.deepEqual(unchangedWait.nodes, waiting.nodes);
  await e2e.save("waiting-after-discussion.json", unchangedWait);

  const answer = await e2e.call("task_question_answer", { taskId: task.taskId, questionId: waiting.questions[0].questionId,
    requestKey: "initial-quantity", answer: "本次声明的测试输入中，数量为 3。不授权购买或其他外部操作。" });
  assert.equal(answer.runId, waiting.runId);
  const initial = await e2e.waitFor("succeeded");
  await e2e.idle();
  await e2e.save("initial-run.json", initial);
  for (const node of initial.nodes) { await verifyDelivery(node); verifyRecord(node.result, marker, 3); }

  const noteRequest = { taskId: task.taskId, requestKey: "remember-tag",
    message: `报告标签为 ${tag}。请记住它，用于本 Task 后续记录，以本消息作为来源，并保留其他仍适用的笔记。这只是讨论，不要启动 ACP 工作。` };
  const note = await e2e.call("task_message_send", noteRequest);
  assert.equal(note.runId, null);
  await e2e.waitMessage(note);
  assert.equal((await e2e.call("task_message_send", noteRequest)).messageId, note.messageId);
  await e2e.idle();
  assert.deepEqual(await e2e.getRun(initial.runId), initial, "Idle memory discussion must not mutate the completed Run");
  assert.equal((await e2e.call("task_run_list", { taskId: task.taskId })).items.length, 1);
  const beforeRestart = await e2e.restart(directory => snapshot(directory, task.taskId));
  await e2e.save("memory-before-restart.json", beforeRestart);
  assert.ok(beforeRestart.submissions.length > 0);
  assert.ok(beforeRestart.submissions.every(receipt => receipt?.status === "done"), "Waiting must settle the original SDK input without a generation failure");
  const saved = beforeRestart.memory.items.find(item => item.text.includes(tag));
  assert.equal(saved?.basis, "reported");
  assert.ok(saved.sources.some(source => source.type === "message" && source.messageId === note.messageId));
  assert.deepEqual(saved.scope, { type: "task" });
  assert.ok(beforeRestart.tools.some(tool => tool.inputMessageId === note.messageId && tool.toolName === "task_memory_update" && !tool.isError));

  const recall = await e2e.call("task_message_send", { taskId: task.taskId, requestKey: "recall-tag",
    message: "请用 task_memory_read 读取保存的报告标签，告诉我确切值。不执行节点，也不改变已完成的 Run。" });
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
    message: "明确请求补充工作：将数量改为 5，加入已保存的报告标签。生成修订记录，再让依赖它的 copy 节点读取并复制新记录。给节点选择提供标签的消息和本次数量更新作为上下文；保留固定 DAG 和旧交付，不发布或执行其他外部操作。" };
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
    await verifyDelivery(node); verifyRecord(node.result, marker, 5, tag);
    assert.equal(node.baseline.deliveryId, old.deliveryId);
    assert.notEqual(node.deliveryId, old.deliveryId);
    assert.notEqual(node.resultFile, old.resultFile);
    assert.notEqual(node.sessionId, old.sessionId, "New supplementary work must not impersonate the prior Run's session");
    assert.equal(await readFile(old.resultFile, "utf8"), old.result);
  }
  const record = revised.nodes[0], copy = revised.nodes[1];
  assert.ok(record.turns.some(turn => turn.contextMessageIds.includes(supplement.messageId)));
  assert.ok(record.turns.some(turn => turn.contextMessageIds.includes(note.messageId)), "Task-scoped facts remain selectable in a supplementary Run");
  assert.ok(record.turns.some(turn => turn.prompt.includes(tag)));
  assert.deepEqual(copy.inputFiles, [record.resultFile, initial.nodes[1].resultFile]);
  assert.deepEqual(copy.deliveries.at(-1).inputDeliveries, [record.deliveryId]);
  assert.deepEqual(await e2e.getRun(initial.runId), initial, "Supplementary work must leave the original Run immutable");
  assert.equal((await e2e.call("task_run_list", { taskId: task.taskId })).items.length, 2);
  const final = await e2e.restart(directory => snapshot(directory, task.taskId));
  await e2e.save("coordinator-evidence.json", final);
  assert.ok(final.submissions.every(receipt => receipt?.status === "done"), "Every admitted input must settle cleanly");
  assert.equal(final.conversationId, beforeRestart.conversationId);
  await e2e.messages();
  e2e.log("verification_passed", { taskId: task.taskId, originalRunId: initial.runId, supplementaryRunId: revised.runId,
    conversationId: final.conversationId, memorySourceMessageId: note.messageId, quantities: [3, 5] });
  t.diagnostic(`Verified Task ${task.taskId}: waiting discussion, model-written memory across restart, no idle ACP work, new supplementary deliveries and downstream file reads`);
});
