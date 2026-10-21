import test from "node:test";
import assert from "node:assert/strict";
import { openExecution } from "../dist/node-execution.js";
import { executorSchema } from "../dist/model.js";

test("closing a real worker before readiness is idempotent and never starts ACP", { timeout: 10000 }, async () => {
  const executor = executorSchema.parse({ id: "exit", command: "/usr/bin/false", cwd: "/tmp", unattendedApproved: true });
  let starts = 0, events = 0;
  const session = openExecution({ executor, inputFiles: [] }, () => { events++; }, () => { starts++; });
  await Promise.all([session.close(), session.close()]);
  await assert.rejects(session.prompt("Must not start"), /closed/);
  assert.equal(starts, 0); assert.equal(events, 0);
});
