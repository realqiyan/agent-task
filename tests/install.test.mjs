import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFile, json, saveManifest, operationLock } from "../scripts/install-lib.mjs";

import { readEnvironment } from "../dist/configuration/files.js";

test("setup preserves credentials and serializes initialization records", t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "task-conductor-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  createFile(join(root, "invalid.json"), "private-invalid-json");
  assert.throws(() => json(join(root, "invalid.json")), error => !error.message.includes("private-invalid-json"));
  const release = operationLock(root);
  assert.throws(() => operationLock(root), /Another/); release();
  const manifest = { root, home: root, node: process.execPath, phase: "ready" };
  saveManifest(root, manifest);
  assert.deepEqual(json(join(root, "installation.json")), manifest);
  createFile(join(root, "launch.json"), JSON.stringify({ dataDir: root }));
  createFile(join(root, "environment.json"), JSON.stringify({ TASK_CONDUCTOR_TOKEN: "private-test-token", HOME: root }));
  assert.throws(() => createFile(join(root, "environment.json"), "{}"), /EEXIST/);
  assert.equal(readEnvironment(join(root, "environment.json")).TASK_CONDUCTOR_TOKEN, "private-test-token");
  assert.equal(readEnvironment(join(root, "environment.json")).HOME, root);
});
