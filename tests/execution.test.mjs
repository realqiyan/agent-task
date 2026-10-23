import test from "node:test";
import assert from "node:assert/strict";
import { createExecution } from "../dist/integrations/acp/execution.js";
const openExecution = createExecution({ PATH: "/usr/bin:/bin" });
import { executorRecord } from "../dist/executors/validation.js";

test("closing a real worker before readiness is idempotent and never starts ACP", { timeout: 10000 }, async () => {
  const executor = executorRecord.parse({ id: "exit", type: "codex", nativePath: "/usr/bin/false", command: "/usr/bin/false", args: [], adapterVersion: null });
  let starts = 0, events = 0;
  const session = openExecution({ executor, workspace: "/tmp", inputFiles: [], resultsRoot: "/tmp/results" }, () => { events++; }, () => { starts++; });
  await Promise.all([session.close(), session.close()]);
  await assert.rejects(session.prompt("Must not start"), /closed/);
  assert.equal(starts, 0); assert.equal(events, 0);
});
