import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startE2e, verifyDelivery } from "./harness.mjs";

// Explicit opt-in command only. Never part of npm test; uses real billable services.
test("real DeepSeek coordinator → MCP task → ACP delivery → accepted completion", { timeout: 240000 }, async t => {
  const e2e = await startE2e(t);
  const marker = `E2E-${randomBytes(8).toString("hex")}`;
  const task = await e2e.create({
    prompt: `Create exactly one node using executor ${e2e.executor.id}. Ask that executor to calculate 17 * 19 and reply with ${marker} and the result. No filesystem, shell, network tools or external side effects are needed. Accept its actual response only if it contains the marker and the correct result, then finish the run. Do not request human input.`,
    maxRunSeconds: 180, maxSteps: 12, maxNodeTurns: 2,
  });
  const run = await e2e.waitFor("succeeded");
  await e2e.save("run.json", run);
  assert.equal(run.nodes.length, 1);
  const node = run.nodes[0];
  await verifyDelivery(node);
  assert.ok(run.summary && node.result.includes(marker) && /\b323\b/.test(node.result));
  e2e.log("verification_passed", { runId: run.id, taskId: task.id, sessionId: node.sessionId, steps: run.steps });
  t.diagnostic(`Verified run ${run.id}: real ACP turn, accepted delivery and persisted result`);
});
