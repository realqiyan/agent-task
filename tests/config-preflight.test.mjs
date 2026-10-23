import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig as validate } from "../dist/configuration/policy.js";
import { configSchema } from "../dist/configuration/contract.js";
import { resolveWorkspace } from "../dist/infrastructure/workspace.js";
const validateConfig = value => validate(configSchema.parse(value), resolveWorkspace);
import { executorCommand } from "../dist/integrations/acp/runtime.js";

test("only four native executor types are registered; ACP commands and arguments are system-owned", t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-preflight-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const name of ["pi", "pi-acp", "codex-acp", "claude-agent-acp", "opencode"]) symlinkSync("/usr/bin/false", join(directory, name));
  for (const type of ["pi", "codex", "claude", "opencode"]) {
    const config = validateConfig({ dataDir: directory, executors: [{ id: type, type, cwd: directory, note: "native" }] });
    assert.equal(config.executors[0].type, type);
    const launch = executorCommand(type, { PATH: directory });
    assert.equal(launch.command, realpathSync("/usr/bin/false"));
    assert.deepEqual(launch.args, type === "opencode" ? ["acp"] : []);
  }
  for (const field of ["command", "args", "envKeys", "permissionAllowlist", "resultReadRoots"]) {
    assert.throws(() => validateConfig({ dataDir: directory, executors: [{ id: "x", type: "pi", cwd: directory, [field]: [] }] }));
  }
  assert.throws(() => validateConfig({ dataDir: directory, executors: [{ id: "x", type: "other", cwd: directory }] }));
  assert.throws(() => executorCommand("pi", { PATH: "/missing" }), /Missing ACP dependency/);
});
