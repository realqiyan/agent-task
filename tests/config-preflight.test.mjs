import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { configSchema } from "../dist/configuration/contract.js";
import { executorLaunch } from "../dist/integrations/acp/runtime.js";

test("configuration cannot supply executor commands and launch binds the discovered native executable", () => {
  assert.deepEqual(configSchema.parse({ dataDir: "/tmp/task-conductor" }).disabledExecutors, []);
  for (const field of ["executors", "command", "args", "envKeys", "permissionAllowlist"]) {
    assert.throws(() => configSchema.parse({ dataDir: "/tmp/task-conductor", [field]: [] }));
  }
  assert.throws(() => configSchema.parse({ dataDir: "/tmp/task-conductor", disabledExecutors: ["other"] }));
  const binary = realpathSync("/usr/bin/false");
  for (const [type, key] of [["pi", "PI_ACP_PI_COMMAND"], ["codex", "CODEX_PATH"], ["claude", "CLAUDE_CODE_EXECUTABLE"]]) {
    const executor = { id: type, type, nativePath: binary, command: binary, args: [], adapterVersion: null };
    const launch = executorLaunch(executor, { PATH: "/usr/bin", PI_ACP_PI_COMMAND: "/different", CODEX_PATH: "/different", CLAUDE_CODE_EXECUTABLE: "/different" });
    assert.equal(launch.env[key], binary);
    assert.equal(Object.keys(launch.env).filter(name => ["PI_ACP_PI_COMMAND", "CODEX_PATH", "CLAUDE_CODE_EXECUTABLE"].includes(name)).length, 1);
    assert.throws(() => executorLaunch({ ...executor, args: ["--widen-permissions"] }, {}));
  }
});
