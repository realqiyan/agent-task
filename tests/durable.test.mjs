import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openCoordinatorStorage } from "../dist/coordinator-storage.js";

test("real durable SQLite preserves a submission across reopen and isolates task runs", async t => {
  const dir = mkdtempSync(join(tmpdir(), "agent-task-durable-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = randomUUID();
  const open = async runId => Harness.open(await openCoordinatorStorage(dir, runId), { models: createModels(), registry: createRegistry() }, context);
  let harness = await open(id);
  const root = await harness.root(context);
  const input = { type: "input", content: "No model is configured; check durable admission only.", requestId: "stable" };
  const first = await root.submit(input, context);
  const settled = await first.wait(context);
  assert.equal(settled.status, "unanswered"); assert.equal(settled.reason, "no_model");
  await harness.close(context);
  harness = await open(id);
  try {
    assert.equal((await harness.inspect(context)).scheduling, "paused");
    const restored = await harness.root(context);
    assert.equal((await restored.submit(input, context)).id, first.id);
    assert.equal((await harness.submission(first.id, context)).id, first.id);
  } finally { await harness.close(context); }
  const other = await open(randomUUID());
  try {
    assert.equal(await other.submission(first.id, context), undefined);
  } finally { await other.close(context); }
});
