import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startE2e, verifyDelivery } from "./harness.mjs";

// Explicit opt-in command only. Never part of npm test; uses real billable services.
test("real DeepSeek coordinator → MCP task → ACP delivery → accepted completion", { timeout: 240000 }, async t => {
  const e2e = await startE2e(t);
  const marker = `E2E-${randomBytes(8).toString("hex")}`;
  const task = await e2e.create({
    prompt: `推进给定 echo 节点，仅在实际输出恰好为 ${marker} 时验收，然后完成 Run。不需要用户补充事实。`,
    nodes: [{ id: "echo", executorId: e2e.executor.id, dependsOn: [], maxRunSeconds: 180,
      prompt: `只回复 ${marker}，不附加说明或 Markdown。不需要文件、shell、网络工具或外部副作用。` }],
    maxRunSeconds: 180, maxModelCalls: 6, maxNodeTurns: 2,
  });
  const run = await e2e.waitFor("succeeded");
  await e2e.save("run.json", run);
  assert.deepEqual(run.nodes.map(node => node.definition), task.input.nodes);
  const node = run.nodes[0];
  await verifyDelivery(node);
  assert.ok(run.summary);
  assert.equal(node.result.trim(), marker);
  e2e.log("verification_passed", { runId: run.runId, taskId: task.taskId, sessionId: node.sessionId, modelCalls: run.modelCalls });
  t.diagnostic(`Verified run ${run.runId}: real ACP turn, accepted delivery and persisted result`);
});
