import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startE2e, verifyDelivery } from "./harness.mjs";

const answerFile = process.env.TASK_CONDUCTOR_E2E_ANSWER_FILE;
const fixtureQuantity = Number(process.env.TASK_CONDUCTOR_E2E_QUANTITY ?? 3);
const manualWaitMs = 900000;

async function readAnswer() {
  try { return await readFile(answerFile, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
function quantityOf(value) {
  assert.match(String(value).trim(), /^[1-9]$/, "Quantity must be an integer from 1 to 9");
  return Number(value);
}

// Literal data transfer keeps this test focused on DAG/session behavior, not model arithmetic.
function verifyRecord(text, marker, quantity) {
  assert.deepEqual(JSON.parse(text), { marker, label: "blue", ...(quantity === undefined ? {} : { quantity }) });
}

// The model and ACP execution are real. Only the human-role input may be a declared test fixture.
test("real three-node DAG waits for human quantity and resumes without replay", { timeout: answerFile ? manualWaitMs + 420000 : 420000 }, async t => {
  if (answerFile) assert.equal(await readAnswer(), undefined, "Use a new answer file; stale answers must not be replayed");
  else quantityOf(fixtureQuantity);
  const e2e = await startE2e(t, { dependencies: true });
  const marker = `DAG-${randomBytes(8).toString("hex")}`;
  const task = await e2e.create({ inputWaitSeconds: 1800,
    nodes: [
      { id: "source", executorId: e2e.executor.id, dependsOn: [], maxRunSeconds: 180,
        prompt: `只返回 JSON 对象 {"marker":"${marker}","label":"blue"}，不加 Markdown 围栏或说明。不需要工具或外部副作用。` },
      { id: "record", executorId: e2e.executor.id, dependsOn: ["source"], maxRunSeconds: 180,
        prompt: "使用 read 读取已验收上游文件。第一轮只读取记录并向协调者请求确认数量，即使上下文已经提供数量也要确认，暂不交付完整记录。在同一会话的后续轮次，原样复制上游 marker 和 label，并将明确提供的数量作为数值 quantity 加入。只返回包含 marker、label、quantity 的 JSON 对象，不加围栏或说明。不计算或编造字段；仅可读取提供的上游文件，不写入、不运行 shell 或网络工具、不产生外部副作用。" },
      { id: "copy", executorId: e2e.executor.id, dependsOn: ["record"], maxRunSeconds: 180,
        prompt: "使用 read 读取已验收上游文件。只返回其中的 JSON 对象，保持 marker、label、quantity 不变，不加围栏或说明。不计算或索取更多用户事实；只读提供的上游文件，不写入、不使用 shell 或网络工具、不产生外部副作用。" },
    ],
    prompt: `推进给定的三节点数据传递 DAG，原样传递字段，不做算术、购买或外部交易。
先执行 source，核对 marker 和 label 后验收。在开始 record 或 copy 前，询问用户一个 1 到 9 的整数 quantity，completedWork 说明已验收的 source。不能猜测、使用默认数量或在用户回答前启动下游。等待不能依赖保留已经验收的 source 会话。
收到回答后保留原计划和 source 原交付；明确重验证 source，不再次执行。给 record 选择包含回答 messageId 的上下文。第一轮请求确认数量的回复不是交付：在同一 record 会话的第二轮确认数量，不再次询问用户。核对 marker、label、quantity 后验收记录，再执行 copy，核对并验收原样副本，最后判断整体完成。只读提供的上游文件，不写入、不使用 shell 或网络工具、不产生外部副作用。交付必须是无围栏、无说明的 JSON 对象，不要求算术或开放式审计。` });
  const waiting = await e2e.waitFor("waiting_input");
  await e2e.save("waiting-run.json", waiting);
  assert.deepEqual(waiting.nodes.map(node => node.definition), task.input.nodes);
  const byName = run => Object.fromEntries(run.nodes.map(node => [node.definition.id, node]));
  const before = byName(waiting);
  assert.deepEqual(Object.keys(before).sort(), ["copy", "record", "source"]);
  assert.deepEqual(before.source.definition.dependsOn, []);
  assert.deepEqual(before.record.definition.dependsOn, ["source"]);
  assert.deepEqual(before.copy.definition.dependsOn, ["record"]);
  await verifyDelivery(before.source);
  verifyRecord(before.source.result, marker);
  for (const node of [before.record, before.copy]) {
    assert.equal(node.status, "pending"); assert.equal(node.sessionId, null); assert.equal(node.turns.length, 0);
  }
  assert.equal(waiting.questions.length, 1);
  const question = waiting.questions[0];
  assert.equal(question.reply, null);
  assert.equal(question.sessionExpiresAt, null, "Human wait must not depend on a short-lived ACP connection");
  const questionNotice = { runId: waiting.runId, questionId: question.questionId, question: question.question,
    evidenceDir: e2e.dir, answerFile: answerFile ?? null, expiresAt: new Date(Date.now() + manualWaitMs).toISOString() };
  await e2e.save("question.json", questionNotice);
  if (answerFile) await writeFile(answerFile + ".question.json", JSON.stringify(questionNotice, null, 2), { mode: 0o600, flag: "wx" });
  e2e.log("waiting_for_human", { runId: waiting.runId, questionId: question.questionId,
    source: answerFile ? "manual-answer-file" : "declared-test-fixture", question: question.question });
  t.diagnostic(`Human question: ${question.question}`);
  if (answerFile) t.diagnostic(`Write one integer (1–9) to ${answerFile} to reply through MCP. Deadline: 15 minutes.`);
  // Demonstrate quiescence, not just a transient waiting flag.
  await delay(2000);
  const stillWaiting = await e2e.getRun();
  assert.equal(stillWaiting.status, "waiting_input");
  assert.equal(stillWaiting.modelCalls, waiting.modelCalls);
  assert.deepEqual(stillWaiting.nodes, waiting.nodes);
  let quantity;
  if (answerFile) {
    quantity = await e2e.until(async () => {
      const current = await e2e.getRun();
      assert.equal(current.status, "waiting_input");
      assert.equal(current.modelCalls, waiting.modelCalls);
      const answer = await readAnswer();
      return answer === undefined ? undefined : quantityOf(answer);
    }, manualWaitMs);
  } else quantity = fixtureQuantity;
  const reply = { taskId: task.taskId, questionId: question.questionId, requestKey: "quantity-reply",
    answer: `用户确认数量为 ${quantity}，请使用这个确切值。这不授权购买或其他外部操作。` };
  const receipt = await e2e.call("task_question_answer", reply);
  assert.equal(receipt.runId, waiting.runId);
  assert.equal(receipt.content, reply.answer);
  assert.equal(receipt.questionId, question.questionId);
  e2e.log("human_reply_submitted", { runId: waiting.runId, questionId: question.questionId, quantity, source: answerFile ? "manual-answer-file" : "declared-test-fixture" });
  const duplicate = await e2e.call("task_question_answer", reply);
  assert.equal(duplicate.messageId, receipt.messageId);
  assert.equal(duplicate.createdAt, receipt.createdAt);
  const run = await e2e.waitFor("succeeded", 200000);
  await e2e.save("run.json", run);
  assert.equal(run.runId, waiting.runId); assert.equal(run.taskId, task.taskId);
  assert.equal(run.questions.length, 1); assert.ok(run.waitedMs >= 2000 && run.summary);
  const after = byName(run);
  assert.equal(run.nodes.length, 3);
  assert.deepEqual(after.source.turns, before.source.turns, "Accepted upstream work must not be replayed");
  assert.deepEqual(after.source.deliveries[0], before.source.deliveries[0], "Original acceptance is immutable");
  assert.equal(after.source.resultFile, before.source.resultFile);
  for (const name of ["source", "record", "copy"]) {
    assert.equal(after[name].nodeRunId, before[name].nodeRunId);
    assert.deepEqual(after[name].definition, before[name].definition);
    await verifyDelivery(after[name]);
  }
  assert.equal(new Set(run.nodes.map(node => node.sessionId)).size, 3);
  assert.equal(after.record.turns.length, 2, "Record must clarify within the same ACP session");
  assert.ok(after.record.turns[0].output.trim(), "The clarification turn must have an actual response");
  assert.ok(!after.record.turns[0].output.includes(after.record.result), "The quantity request must not be accepted as the completed delivery");
  for (const node of [after.record, after.copy]) verifyRecord(node.result, marker, quantity);
  assert.deepEqual(after.record.inputFiles, [after.source.resultFile]);
  assert.deepEqual(after.copy.inputFiles, [after.record.resultFile]);
  assert.equal((await e2e.call("task_question_answer", reply)).messageId, receipt.messageId, "A duplicate answer returns the original receipt");
  e2e.log("verification_passed", { runId: run.runId, taskId: task.taskId, quantity, modelCalls: run.modelCalls,
    sessions: run.nodes.map(node => node.sessionId) });
  t.diagnostic(`Verified three-node run ${run.runId}: quantity=${quantity}, same run resumed, no upstream replay`);
});
