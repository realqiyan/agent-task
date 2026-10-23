import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Results, readInputFile } from "../dist/results.js";
import { acquireLock } from "../dist/lock.js";

function directory(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-artifacts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("result reads require exact upstream files inside results, never other dataDir files", t => {
  const dir = directory(t), results = new Results(dir);
  const path = results.save("round", "node", "run", "first\nsecond\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readInputFile(results.root, [path], path), "first\nsecond\n");
  assert.equal(readInputFile(results.root, [path], path, 2, 1), "second");
  assert.throws(() => readInputFile(results.root, [], path), /authorized/);
  const secret = join(dir, "environment.json"); writeFileSync(secret, "private");
  assert.throws(() => readInputFile(results.root, [secret], secret), /scope/);
  assert.throws(() => readInputFile(results.root, [path], path, 0), /range/);
  const link = join(dir, "link");
  symlinkSync(path, link);
  assert.throws(() => readInputFile(results.root, [link], link), /authorized/);
  assert.throws(() => results.save("round", "node", "run", "overwrite"));
  assert.throws(() => results.save("../escape", "node", "run", ""));
});
test("OS-owned directory lock excludes another process and releases on SIGKILL", { timeout: 10000 }, async t => {
  const dir = directory(t);
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    'import {acquireLock} from "./dist/lock.js"; await acquireLock(process.argv[1]); console.log("ready"); setInterval(()=>{},1000);', dir],
    { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  t.after(async () => { child.kill("SIGKILL"); await closed; });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", resolve); child.once("error", reject);
    child.once("exit", () => reject(new Error("Lock owner exited before ready")));
  });
  await assert.rejects(acquireLock(dir), /locked/);
  child.kill("SIGKILL"); await closed;
  const release = await acquireLock(dir);
  await release(); await release();
});

