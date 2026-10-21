import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startE2e, verifyDelivery } from "./harness.mjs";

const answerFile = process.env.AGENT_TASK_E2E_ANSWER_FILE;
const fixtureQuantity = Number(process.env.AGENT_TASK_E2E_QUANTITY ?? 3);
const manualWaitMs = 900000;

async function readAnswer() {
  try { return await readFile(answerFile, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
function quantityOf(value) {
  assert.match(String(value).trim(), /^[1-9]$/, "Quantity must be an integer from 1 to 9");
  return Number(value);
}

// The model and ACP execution are real. Only the human-role input may be a declared test fixture.
test("real three-node DAG waits for human quantity and resumes without replay", { timeout: answerFile ? manualWaitMs + 420000 : 420000 }, async t => {
  if (answerFile) assert.equal(await readAnswer(), undefined, "Use a new answer file; stale answers must not be replayed");
  else quantityOf(fixtureQuantity);
  const e2e = await startE2e(t, { dependencies: true });
  const marker = `QUOTE-${randomBytes(8).toString("hex")}`;
  const task = await e2e.create({ inputWaitSeconds: 1800, prompt: `Run a three-node quotation workflow using only executor ${e2e.executor.id}. This is arithmetic, not a purchase or external transaction.
Commit exactly these nodes once, with maxRunSeconds=180 each:
1. price, no dependencies: calculate 17 * 19 and return only JSON {"marker":"${marker}","unitPrice":323}. Independently calculate the number rather than blindly copy it.
2. total, dependsOn=["price"]: read the accepted upstream JSON using the read tool. The purchase quantity is deliberately absent from this committed prompt. On the FIRST turn return exactly NEED_QUANTITY, not a quote. On a follow-up in this SAME session, use the explicitly supplied human quantity, multiply the actual upstream unitPrice by it, and return only JSON with marker, unitPrice, quantity, total.
3. audit, dependsOn=["total"]: use the read tool to read the accepted total delivery, independently check its arithmetic, and return only JSON with marker, unitPrice, quantity, total, verified=true if correct. Do not request more human input.
Execution order is mandatory: run price and accept its exact JSON delivery. BEFORE starting total or audit, call request_input alone, asking the human for an integer quantity from 1 to 9, with completedWork identifying the accepted price. Do not guess a quantity, use a default, or start downstream work before the human reply. There must be no open ACP session when waiting.
After the human reply, preserve this plan and price delivery. Start total with its committed prompt (no message on first converse). Its NEED_QUANTITY response is NOT a delivery: send the human quantity in a second converse to the SAME total session, without requesting human input again. Accept the computed JSON only after checking it. Then run audit and accept its JSON, and finish_run. No writes, shell commands, network tools or side effects; only read the supplied upstream result files. Keep all acceptance excerpts as complete JSON objects without Markdown fences.` });
  const waiting = await e2e.waitFor("waiting_input");
  await e2e.save("waiting-run.json", waiting);
  assert.equal(waiting.nodes.length, 3);
  const byName = run => Object.fromEntries(run.nodes.map(node => [node.definition.id, node]));
  const before = byName(waiting);
  assert.deepEqual(Object.keys(before).sort(), ["audit", "price", "total"]);
  assert.deepEqual(before.price.definition.dependsOn, []);
  assert.deepEqual(before.total.definition.dependsOn, ["price"]);
  assert.deepEqual(before.audit.definition.dependsOn, ["total"]);
  await verifyDelivery(before.price);
  assert.deepEqual(JSON.parse(before.price.result), { marker, unitPrice: 323 });
  for (const node of [before.total, before.audit]) {
    assert.equal(node.status, "pending"); assert.equal(node.sessionId, null); assert.equal(node.turns.length, 0);
  }
  assert.equal(waiting.questions.length, 1);
  const question = waiting.questions[0];
  assert.equal(question.reply, null);
  assert.equal(question.sessionExpiresAt, null, "Human wait must not depend on a short-lived ACP connection");
  const questionNotice = { runId: waiting.id, questionId: question.id, question: question.question,
    evidenceDir: e2e.dir, answerFile: answerFile ?? null, expiresAt: new Date(Date.now() + manualWaitMs).toISOString() };
  await e2e.save("question.json", questionNotice);
  if (answerFile) await writeFile(answerFile + ".question.json", JSON.stringify(questionNotice, null, 2), { mode: 0o600, flag: "wx" });
  e2e.log("waiting_for_human", { runId: waiting.id, questionId: question.id,
    source: answerFile ? "manual-answer-file" : "declared-test-fixture", question: question.question });
  t.diagnostic(`Human question: ${question.question}`);
  if (answerFile) t.diagnostic(`Write one integer (1–9) to ${answerFile} to reply through MCP. Deadline: 15 minutes.`);
  // Demonstrate quiescence, not just a transient waiting flag.
  await delay(2000);
  const stillWaiting = await e2e.getRun();
  assert.equal(stillWaiting.status, "waiting_input");
  assert.equal(stillWaiting.steps, waiting.steps);
  assert.deepEqual(stillWaiting.nodes, waiting.nodes);
  let quantity;
  if (answerFile) {
    quantity = await e2e.until(async () => {
      const current = await e2e.getRun();
      assert.equal(current.status, "waiting_input");
      assert.equal(current.steps, waiting.steps);
      const answer = await readAnswer();
      return answer === undefined ? undefined : quantityOf(answer);
    }, manualWaitMs);
  } else quantity = fixtureQuantity;
  const reply = { runId: waiting.id, questionId: question.id, requestKey: "quantity-reply",
    answer: `The human-approved quantity is ${quantity}. Use exactly this quantity; this is not permission for purchases or other external actions.` };
  const receipt = await e2e.call("task_run_reply", reply);
  assert.equal(receipt.id, waiting.id);
  assert.equal(receipt.questions[0].reply.answer, reply.answer);
  assert.deepEqual(receipt.nodes, waiting.nodes, "Accepting the reply itself must not mutate node identities or deliveries");
  e2e.log("human_reply_submitted", { runId: waiting.id, questionId: question.id, quantity, source: answerFile ? "manual-answer-file" : "declared-test-fixture" });
  const duplicate = await e2e.call("task_run_reply", reply);
  assert.equal(duplicate.questions.length, 1);
  assert.equal(duplicate.questions[0].reply.receivedAt, receipt.questions[0].reply.receivedAt);
  const run = await e2e.waitFor("succeeded", 200000);
  await e2e.save("run.json", run);
  assert.equal(run.id, waiting.id); assert.equal(run.taskId, task.id);
  assert.equal(run.questions.length, 1); assert.ok(run.waitedMs >= 2000 && run.summary);
  const after = byName(run);
  assert.equal(run.nodes.length, 3);
  assert.deepEqual(after.price, before.price, "Accepted upstream work must not be replayed or rewritten");
  for (const name of ["price", "total", "audit"]) {
    assert.equal(after[name].id, before[name].id);
    assert.deepEqual(after[name].definition, before[name].definition);
    await verifyDelivery(after[name]);
  }
  assert.equal(new Set(run.nodes.map(node => node.sessionId)).size, 3);
  assert.equal(after.total.turns.length, 2, "Total must clarify within the same ACP session");
  assert.match(after.total.turns[0].output, /\bNEED_QUANTITY\b/);
  assert.ok(!after.total.turns[0].output.includes(after.total.result), "The quantity request must not be accepted as the computed delivery");
  assert.deepEqual(JSON.parse(after.total.result), { marker, unitPrice: 323, quantity, total: 323 * quantity });
  assert.deepEqual(JSON.parse(after.audit.result), { marker, unitPrice: 323, quantity, total: 323 * quantity, verified: true });
  assert.deepEqual(after.total.inputFiles, [after.price.resultFile]);
  assert.deepEqual(after.audit.inputFiles, [after.total.resultFile]);
  assert.deepEqual(await e2e.call("task_run_reply", reply), run, "A duplicate reply after completion must not reactivate the run");
  e2e.log("verification_passed", { runId: run.id, taskId: task.id, quantity, total: 323 * quantity, steps: run.steps,
    sessions: run.nodes.map(node => node.sessionId) });
  t.diagnostic(`Verified three-node run ${run.id}: quantity=${quantity}, total=${323 * quantity}, same run resumed, no upstream replay`);
});
