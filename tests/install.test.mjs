import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFile, json, saveManifest, runtimeEnv, inventory, removeInventory, operationLock, run } from "../scripts/install-lib.mjs";

test("installer preserves credentials and uninventoried files, rejects escaping paths and serializes operations", t => {
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
  createFile(join(root, "environment.json"), JSON.stringify({ AGENT_TASK_TOKEN: "private-test-token", HOME: root }));
  assert.throws(() => createFile(join(root, "environment.json"), "{}"), /EEXIST/);
  assert.equal(runtimeEnv(manifest).AGENT_TASK_TOKEN, "private-test-token");
  assert.equal(runtimeEnv(manifest).HOME, root);
  createFile(join(root, "app/module.js"), "installed code");
  createFile(join(root, "components/bin/agent"), "installed binary");
  const files = [...inventory(root, "app"), ...inventory(root, "components")];
  createFile(join(root, "app/user-work.txt"), "preserve");
  createFile(join(root, "data/history.txt"), "preserve");
  removeInventory(root, files);
  removeInventory(root, files);
  assert.equal(existsSync(join(root, "app/module.js")), false);
  assert.equal(readFileSync(join(root, "app/user-work.txt"), "utf8"), "preserve");
  assert.equal(readFileSync(join(root, "data/history.txt"), "utf8"), "preserve");
  assert.equal(json(join(root, "environment.json")).AGENT_TASK_TOKEN, "private-test-token");
  assert.throws(() => removeInventory(root, ["app/../environment.json"]), /Invalid/);
  mkdirSync(join(root, "outside")); writeFileSync(join(root, "outside/keep"), "preserve");
  symlinkSync(join(root, "outside"), join(root, "app/link"));
  assert.throws(() => removeInventory(root, ["app/link/keep"]), /parent path changed/);
  assert.equal(readFileSync(join(root, "outside/keep"), "utf8"), "preserve");
});
