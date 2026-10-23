import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { CompactionTask, GenerationTask, Harness, createRegistry } from "@earendil-works/pi-durable";
import { openCoordinatorStorage } from "../dist/integrations/coordinator/storage.js";

test("pending SDK tasks reopen unchanged while unsupported versions and kinds still fail closed", async t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-pending-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const id = randomUUID(), path = join(dir, "coordinators", id + ".sqlite");
  const open = async () => Harness.open(await openCoordinatorStorage(dir, id), { models: createModels(), registry: createRegistry() }, context);
  let harness = await open();
  let records;
  try {
    const root = await harness.root(context);
    // A commit does not start scheduling: these are real SDK pending tasks, not fabricated model responses.
    const ids = await root.commit(async tx => [
      await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } }),
      await tx.createTask(CompactionTask, { reason: "manual" }, { ownership: { kind: "conversation" } }),
    ], context);
    assert.equal((await harness.inspect(context)).scheduling, "paused");
    records = await Promise.all(ids.map(id => harness.getTask(id, context)));
    assert.ok(records.every(record => record.state.status === "pending"));
  } finally { await harness.close(context); }

  harness = await open(); // Before the fix: Unsupported durable task version.
  try {
    assert.equal((await harness.inspect(context)).scheduling, "paused");
    assert.deepEqual(await Promise.all(records.map(record => harness.getTask(record.id, context))), records);
  } finally { await harness.close(context); }

  // Only the disposable test database is changed. Unsupported records must not be silently migrated/repaired.
  for (const change of [{ version: 999 }, { kind: "unsupported.task" }]) {
    const record = { ...records[0], ...change }, stored = JSON.stringify(record);
    const db = new DatabaseSync(path);
    try { db.prepare("UPDATE tasks SET kind=?, record=? WHERE id=?").run(JSON.stringify(record.kind), stored, record.id); }
    finally { db.close(); }
    await assert.rejects(openCoordinatorStorage(dir, id), /Unsupported durable task version/);
    const read = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(read.prepare("SELECT record FROM tasks WHERE id=?").get(record.id).record, stored); }
    finally { read.close(); }
  }
});

test("real durable SQLite preserves a submission across reopen and isolates task runs", async t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-durable-"));
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
