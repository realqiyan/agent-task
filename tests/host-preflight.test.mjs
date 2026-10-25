import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectInstallation, runtimeState, onboardingNotice } from "../plugin/scripts/preflight.mjs";
import { version, versionStatus } from "../dist/infrastructure/version.js";

const cli = resolve("bin/agent-task.mjs");
const hook = resolve("plugin/scripts/session-start.mjs");
const json = path => JSON.parse(readFileSync(path, "utf8"));
function snapshot(directory) {
  if (!existsSync(directory)) return null;
  const result = {};
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name), stat = lstatSync(path);
    result[name] = { mode: stat.mode, mtime: stat.mtimeMs,
      data: stat.isDirectory() ? snapshot(path) : readFileSync(path) };
  }
  return result;
}
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-preflight-"));
  const bin = join(root, "bin"), user = join(root, "user"), home = join(root, "custom home");
  for (const path of [bin, user]) mkdirSync(path, { mode: 0o700 });
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(cli, join(bin, "agent-task"));
  const env = { PATH: bin, HOME: user, AGENT_TASK_PREFLIGHT_HOME: home };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, bin, home, env };
}

test("runtime version reports distinguish mismatch, missing evidence and stopped backends", () => {
  const same = { launcherVersion: version, serviceVersion: version };
  assert.equal(versionStatus(same).restartRequired, false);
  assert.equal(versionStatus({ ...same, serviceVersion: null }).restartRequired, null);
  assert.equal(versionStatus({ launcherVersion: null, serviceVersion: null }).restartRequired, null);
  const different = version + "-different";
  assert.equal(versionStatus({ ...same, launcherVersion: different }).restartRequired, true);
  assert.equal(versionStatus({ launcherVersion: different, serviceVersion: null }).restartRequired, true);
  const report = { event: "healthy", ...versionStatus(same) };
  assert.equal(runtimeState(report, 0), "ready");
  for (const field of ["launcherVersion", "serviceVersion"]) {
    assert.equal(runtimeState({ ...report, [field]: different }, 0), "runtime-outdated");
    for (const value of [undefined, null, "", 42]) {
      assert.equal(runtimeState({ ...report, [field]: value }, 0), "runtime-unknown");
    }
  }
  assert.equal(runtimeState({ event: "healthy" }, 0), "runtime-unknown");
  assert.equal(runtimeState(report, 1), "runtime-unknown");
  assert.equal(runtimeState({ event: "unreachable", installedVersion: version }, 1), "ready");
  assert.equal(runtimeState({ event: "unreachable" }, 1), "runtime-unknown");
  for (const state of ["runtime-outdated", "runtime-unknown"]) {
    for (const host of ["pi", "claude", "codex"]) assert(onboardingNotice(state, host));
  }
});

test("preflight distinguishes missing executable, setup and failed processes without writing state", async t => {
  const { root, home, env } = fixture(t);
  const before = snapshot(root);
  assert.equal(await inspectInstallation({ env: { ...env, AGENT_TASK_PREFLIGHT_COMMAND: join(root, "absent") } }), "command-unavailable");
  assert.equal(await inspectInstallation({ env }), "setup-missing");
  assert.equal(await inspectInstallation({ env: { ...env, AGENT_TASK_PREFLIGHT_COMMAND: "/usr/bin/false" } }), "check-failed");
  // A real unbounded-output process proves output bounding and child cleanup, not a simulated CLI.
  assert.equal(await inspectInstallation({ env: { ...env, AGENT_TASK_PREFLIGHT_COMMAND: "/usr/bin/yes" } }), "check-failed");
  const controller = new AbortController();
  controller.abort();
  assert.equal(await inspectInstallation({ env, signal: controller.signal }), "cancelled");
  assert.equal(existsSync(home), false);
  assert.deepEqual(snapshot(root), before);
});

test("setup check and both native hook outputs remain read-only and suppress private error values", async t => {
  const { root, home, env } = fixture(t);
  const setup = spawnSync(process.execPath, [cli, "setup", "--home", home, "--data-dir", join(home, "data"), "--port", "0", "--generate-tokens", "--yes"], {
    cwd: root, env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(setup.status, 0, setup.stderr);
  // A check must not recreate this test installation's setup lock.
  rmSync(join(home, "setup-lock.sqlite"));
  let before = snapshot(root);
  assert.equal(await inspectInstallation({ env }), "coordinator-missing");
  assert.deepEqual(snapshot(root), before);

  const configPath = join(home, "data/config.json"), environmentPath = join(home, "data/environment.json");
  const environment = json(environmentPath);
  environment.OPENAI_API_KEY = "private-test-value-never-used-for-a-model";
  writeFileSync(configPath, JSON.stringify({ ...json(configPath), coordinator: { provider: "openai", model: "not-a-real-model" } }), { mode: 0o600 });
  writeFileSync(environmentPath, JSON.stringify(environment), { mode: 0o600 });
  before = snapshot(root);
  assert.equal(await inspectInstallation({ env }), "ready");
  for (const host of ["claude", "codex"]) {
    const ready = spawnSync(process.execPath, [hook, host], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(ready.status, 0);
    assert.equal(ready.stdout, "");
    assert.equal(ready.stderr, "");
  }
  assert.deepEqual(snapshot(root), before);

  const manifestPath = join(home, "installation.json"), manifest = json(manifestPath);
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, phase: "initializing" }), { mode: 0o600 });
  before = snapshot(root);
  assert.equal(await inspectInstallation({ env }), "setup-incomplete");
  assert.deepEqual(snapshot(root), before);
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });

  writeFileSync(environmentPath, environment.OPENAI_API_KEY, { mode: 0o600 });
  before = snapshot(root);
  const checked = spawnSync(process.execPath, [cli, "setup", "--check", "--json", "--home", home], { env, encoding: "utf8", timeout: 5000 });
  assert.equal(checked.status, 1);
  assert.deepEqual(JSON.parse(checked.stdout), { configuration: "invalid" });
  assert.equal(await inspectInstallation({ env }), "setup-invalid");
  for (const host of ["claude", "codex"]) {
    const failed = spawnSync(process.execPath, [hook, host], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(failed.status, 0, "A diagnostic cannot block the host session");
    const output = JSON.parse(failed.stdout);
    assert.equal(typeof output.systemMessage, "string");
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.equal(typeof output.hookSpecificOutput.additionalContext, "string");
    assert.equal(output.continue, undefined);
    assert.equal(failed.stderr, "");
    for (const secret of Object.values(environment)) assert(!(checked.stdout + checked.stderr + failed.stdout).includes(secret));
  }
  assert.deepEqual(snapshot(root), before);
  assert.equal(existsSync(join(home, "launcher.log")), false);
  assert.equal(existsSync(join(home, "setup-lock.sqlite")), false);
});
