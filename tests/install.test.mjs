import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFile, json, saveManifest, inventory, operationLock, run } from "../scripts/install-lib.mjs";

import { readEnvironment } from "../dist/configuration/files.js";

test("setup preserves credentials, records component inventory and serializes operations", t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-install-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.AGENT_TASK_INSTALL_TEST_SECRET;
  process.env.AGENT_TASK_INSTALL_TEST_SECRET = "must-not-inherit";
  try {
    assert.equal(run(process.execPath, ["--eval", 'process.stdout.write(process.env.AGENT_TASK_INSTALL_TEST_SECRET ?? "excluded")']), "excluded");
  } finally {
    if (previous === undefined) delete process.env.AGENT_TASK_INSTALL_TEST_SECRET;
    else process.env.AGENT_TASK_INSTALL_TEST_SECRET = previous;
  }
  createFile(join(root, "invalid.json"), "private-invalid-json");
  assert.throws(() => json(join(root, "invalid.json")), error => !error.message.includes("private-invalid-json"));
  const release = operationLock(root);
  assert.throws(() => operationLock(root), /Another/); release();
  const manifest = { root, home: root, node: process.execPath, phase: "ready" };
  saveManifest(root, manifest);
  assert.deepEqual(json(join(root, "installation.json")), manifest);
  createFile(join(root, "launch.json"), JSON.stringify({ dataDir: root }));
  createFile(join(root, "environment.json"), JSON.stringify({ AGENT_TASK_TOKEN: "private-test-token", HOME: root }));
  assert.throws(() => createFile(join(root, "environment.json"), "{}"), /EEXIST/);
  assert.equal(readEnvironment(join(root, "environment.json")).AGENT_TASK_TOKEN, "private-test-token");
  assert.equal(readEnvironment(join(root, "environment.json")).HOME, root);
  createFile(join(root, "app/module.js"), "installed code");
  createFile(join(root, "components/bin/agent"), "installed binary");
  const files = [...inventory(root, "components")];
  createFile(join(root, "components/user-work.txt"), "preserve");
  createFile(join(root, "data/history.txt"), "preserve");
  assert(files.includes("components/bin/agent"));
  assert(!files.includes("components/user-work.txt"));
  assert.equal(readFileSync(join(root, "components/user-work.txt"), "utf8"), "preserve");
  assert.equal(readFileSync(join(root, "data/history.txt"), "utf8"), "preserve");
});
