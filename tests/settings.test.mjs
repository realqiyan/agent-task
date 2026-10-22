import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, chmodSync, statSync, symlinkSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Settings } from "../dist/settings.js";
import { loadConfig, validateConfig, executorEnv, ADMIN_TOKEN_ENV } from "../dist/config.js";
import { readEnvironment } from "../dist/environment.js";
import { replacePrivateText, FileCommitError } from "../dist/private-files.js";

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json"), environmentPath = join(root, "environment.json");
  const environment = { AGENT_TASK_TOKEN: randomBytes(32).toString("hex"), [ADMIN_TOKEN_ENV]: randomBytes(32).toString("hex") };
  writeFileSync(configPath, JSON.stringify({ dataDir: join(root, "data"), executors: [] }), { mode: 0o600 });
  writeFileSync(environmentPath, JSON.stringify(environment), { mode: 0o600 });
  const settings = new Settings(configPath, environmentPath, loadConfig(configPath), {}, environment);
  t.after(() => settings.close());
  return { root, configPath, environmentPath, environment, settings };
}
test("settings validate against saved credentials, reject stale edits and never change live environment or expose keys", t => {
  const { root, configPath, environmentPath, settings, environment } = fixture(t);
  const initial = settings.get(), original = readFileSync(configPath, "utf8"), secret = randomBytes(32).toString("hex");
  const previous = process.env.CONSOLE_TEST_KEY;
  process.env.CONSOLE_TEST_KEY = "inherited-value-must-not-be-used";
  try {
    const config = { executors: [{ id: "local", command: "/usr/bin/false", cwd: root, envKeys: ["CONSOLE_TEST_KEY"] }] };
    assert.throws(() => settings.validate({ editToken: initial.editToken, config }), /missing/);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.throws(() => settings.saveCredential({ editToken: initial.editToken, key: ADMIN_TOKEN_ENV, action: "replace", value: secret }), /not console-managed/);
    assert.throws(() => settings.saveCredential({ editToken: initial.editToken, key: "ALIAS_KEY", action: "replace", value: environment.AGENT_TASK_TOKEN }), /cannot be reused/);
    const prepared = settings.saveCredential({ editToken: initial.editToken, key: "CONSOLE_TEST_KEY", action: "replace", value: secret });
    assert(!JSON.stringify(prepared).includes(secret));
    assert.deepEqual(prepared.credentials.find(item => item.key === "CONSOLE_TEST_KEY"),
      { key: "CONSOLE_TEST_KEY", saved: true, running: false, pendingRestart: true, referenced: false });
    assert.throws(() => settings.saveConfig({ editToken: initial.editToken, config }), /changed/);
    const saved = settings.saveConfig({ editToken: prepared.editToken, config });
    assert.equal(saved.running.executors.length, 0);
    assert.equal(saved.saved.executors.length, 1);
    assert.equal(settings.status().pendingRestart, true);
    assert.equal(process.env.CONSOLE_TEST_KEY, "inherited-value-must-not-be-used");
    assert.equal(readEnvironment(environmentPath).CONSOLE_TEST_KEY, secret);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.equal(statSync(environmentPath).mode & 0o777, 0o600);
    assert.throws(() => settings.saveCredential({ editToken: saved.editToken, key: "CONSOLE_TEST_KEY", action: "delete" }), /still references/);
    assert.throws(() => settings.validate({ editToken: saved.editToken, config: { ...config, port: 9999 } }), /Invalid/);
    assert.throws(() => validateConfig({ dataDir: root, executors: [{ ...config.executors[0], envKeys: [ADMIN_TOKEN_ENV] }] }), /administrator token/);
    assert.equal(executorEnv([ADMIN_TOKEN_ENV], environment)[ADMIN_TOKEN_ENV], undefined);
    // A new instance, not a settings save, loads the new runtime values.
    const restarted = new Settings(configPath, environmentPath, loadConfig(configPath), {}, readEnvironment(environmentPath));
    try {
      assert.equal(restarted.get().credentials.find(item => item.key === "CONSOLE_TEST_KEY").running, true);
      assert.equal(restarted.status().pendingRestart, false);
    } finally { restarted.close(); }
  } finally {
    if (previous === undefined) delete process.env.CONSOLE_TEST_KEY; else process.env.CONSOLE_TEST_KEY = previous;
  }
});
test("changing a credential destination requires separately prepared keys, not a mixed two-file update", t => {
  const { settings, configPath } = fixture(t);
  let view = settings.saveCredential({ editToken: settings.get().editToken, key: "OPENAI_API_KEY", action: "replace", value: randomBytes(32).toString("hex") });
  view = settings.saveConfig({ editToken: view.editToken, config: { executors: [], coordinator: { provider: "openai", model: "not-a-real-model" } } });
  const before = readFileSync(configPath, "utf8");
  const config = { executors: [], coordinator: { provider: "openai-compatible", model: "example", api: "openai-completions",
    baseUrl: "https://untrusted.invalid/v1", apiKeyEnv: "OPENAI_API_KEY", contextWindow: 4096, maxTokens: 1024 } };
  assert.throws(() => settings.validate({ editToken: view.editToken, config }), /new credential reference/);
  assert.equal(readFileSync(configPath, "utf8"), before);
  view = settings.saveCredential({ editToken: view.editToken, key: "NEXT_API_KEY", action: "replace", value: randomBytes(32).toString("hex") });
  config.coordinator.apiKeyEnv = "NEXT_API_KEY";
  const saved = settings.saveConfig({ editToken: view.editToken, config });
  assert.equal(saved.saved.coordinator.apiKeyEnv, "NEXT_API_KEY");
  assert.equal(saved.running.coordinator, undefined);
});

test("configuration files reject insecure ownership boundaries and out-of-band overwrites without repairing data", t => {
  const { root, configPath, settings } = fixture(t), edit = settings.get();
  const external = JSON.stringify({ dataDir: join(root, "data"), executors: [], port: 8766 });
  writeFileSync(configPath, external);
  assert.throws(() => settings.saveConfig({ editToken: edit.editToken, config: { executors: [] } }), /changed/);
  assert.equal(readFileSync(configPath, "utf8"), external);
  chmodSync(configPath, 0o644);
  assert.throws(() => settings.get(), /private configuration/);
  chmodSync(configPath, 0o600);
  const retained = join(root, "retained.json"); renameSync(configPath, retained); symlinkSync(retained, configPath);
  assert.throws(() => settings.get(), /private configuration/);
  assert.throws(() => replacePrivateText(configPath, "overwrite"), error => error instanceof FileCommitError && !error.uncertain);
  assert.equal(readFileSync(retained, "utf8"), external);
  settings.close(); settings.close();
  assert.throws(() => settings.get(), /closed/);
});
