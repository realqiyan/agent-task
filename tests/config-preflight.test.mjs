import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";

test("executor preflight explains missing commands, Pi RPC misuse and missing Pi dependency", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-preflight-"));
  const path = join(directory, "config.json");
  const originalPath = process.env.PATH;
  const check = (command, args = []) => {
    writeFileSync(path, JSON.stringify({ dataDir: directory,
      executors: [{ id: "local", command, args, cwd: directory }] }));
    return () => loadConfig(path);
  };
  try {
    assert.throws(check(join(directory, "absent")), /ACP executable is missing or not executable.*npm install -g pi-acp@0\.0\.34/);
    assert.throws(check(join(directory, "pi"), ["--mode", "rpc"]), /pi CLI is not an ACP server/);
    process.env.PATH = directory;
    assert.throws(check(join(directory, "pi-acp")), /pi-acp requires pi on the executor PATH/);
    assert.equal(check("/usr/bin/false")().executors.length, 1);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
