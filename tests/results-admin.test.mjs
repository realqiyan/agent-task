import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Results, readInputFile } from "../dist/results.js";
import { executorSchema } from "../dist/model.js";
import { acquireLock } from "../dist/lock.js";
import { loadConfig } from "../dist/config.js";

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "agent-task-artifacts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("result reads require exact run files and approved scope, reject symlinks and invalid ranges", t => {
  const dir = directory(t), results = new Results(dir);
  const executor = executorSchema.parse({ id: "local", command: "/usr/bin/false", cwd: dir, resultReadRoots: [dir] });
  const path = results.save("round", "node", "run", "first\nsecond\n");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readInputFile(executor, [path], path), "first\nsecond\n");
  assert.equal(readInputFile(executor, [path], path, 2, 1), "second");
  assert.throws(() => readInputFile(executor, [], path), /authorized/);
  assert.throws(() => readInputFile({ ...executor, resultReadRoots: [] }, [path], path), /scope/);
  assert.throws(() => readInputFile(executor, [path], path, 0), /range/);
  const link = join(dir, "link");
  symlinkSync(path, link);
  assert.throws(() => readInputFile(executor, [link], link), /authorized/);
  assert.throws(() => results.save("round", "node", "run", "overwrite"));
  assert.throws(() => results.save("../escape", "node", "run", ""));
});
test("administrator CLI registers local profiles atomically, queries them and honors the service lock", async t => {
  const dir = directory(t), path = join(dir, "config.json"), profilePath = join(dir, "profile.json");
  writeFileSync(path, JSON.stringify({ dataDir: join(dir, "state"), executors: [] }));
  writeFileSync(profilePath, JSON.stringify({ id: "local", command: "/usr/bin/false", cwd: dir, args: [],
    envKeys: ["LANG"], permissionAllowlist: [], unattendedApproved: true, resultReadRoots: [dir] }));
  const call = action => spawnSync(process.execPath, [resolve("dist/admin.js"), action, path, profilePath], { encoding: "utf8", timeout: 10_000 });
  const registered = call("register");
  assert.equal(registered.status, 0, registered.stderr);
  assert.equal(loadConfig(path).executors[0].id, "local");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(call("list").stdout)[0].transport, "stdio");
  const original = readFileSync(path, "utf8");
  assert.notEqual(call("register").status, 0);
  assert.equal(readFileSync(path, "utf8"), original);
  const release = await acquireLock(join(dir, "state"), () => {});
  try { assert.notEqual(call("list").status, 0); } finally { await release(); }
  writeFileSync(profilePath, JSON.stringify({ id: "remote", command: "https://remote.invalid", cwd: dir }));
  assert.notEqual(call("register").status, 0);
  assert.equal(readFileSync(path, "utf8"), original);
});
