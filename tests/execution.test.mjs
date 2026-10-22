import test from "node:test";
import assert from "node:assert/strict";
import { createExecution } from "../dist/node-execution.js";
const openExecution = createExecution({ PATH: "/usr/bin:/bin" });
import { executorSchema } from "../dist/model.js";

test("closing a real worker before readiness is idempotent and never starts ACP", { timeout: 10000 }, async () => {
  const executor = executorSchema.parse({ id: "exit", type: "codex", cwd: "/tmp", unattendedApproved: true });
  let starts = 0, events = 0;
  const session = openExecution({ executor, inputFiles: [], resultsRoot: "/tmp/results" }, () => { events++; }, () => { starts++; });
  await Promise.all([session.close(), session.close()]);
  await assert.rejects(session.prompt("Must not start"), /closed/);
  assert.equal(starts, 0); assert.equal(events, 0);
});
