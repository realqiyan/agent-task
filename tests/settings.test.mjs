import { LocalSettingsFiles, configurationPaths } from "../dist/configuration/files.js";
import { parseSettings, settingsConfigSchema, settingsChangeSchema, credentialUpdateSchema } from "../dist/protocol/settings-contract.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, chmodSync, statSync, symlinkSync, renameSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Settings } from "../dist/configuration/settings.js";
import { loadConfig } from "../dist/configuration/files.js";
import { ADMIN_TOKEN_ENV } from "../dist/configuration/policy.js";
import { readEnvironment } from "../dist/configuration/files.js";
import { prepareStartup } from "../dist/application/startup.js";
import { replacePrivateText } from "../dist/infrastructure/private-files.js";
import { FileCommitError } from "../dist/shared/errors.js";

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "task-conductor-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json"), environmentPath = join(root, "environment.json");
  const environment = { TASK_CONDUCTOR_TOKEN: randomBytes(32).toString("hex"), [ADMIN_TOKEN_ENV]: randomBytes(32).toString("hex") };
  writeFileSync(configPath, JSON.stringify({ dataDir: root, disabledExecutors: [] }), { mode: 0o600 });
  writeFileSync(environmentPath, JSON.stringify(environment), { mode: 0o600 });
  const settings = new Settings(new LocalSettingsFiles(configPath, environmentPath), configurationPaths, loadConfig(configPath), {}, environment);
  t.after(() => settings.close());
  return { root, configPath, environmentPath, environment, settings };
}
test("startup edits are next-start only; secrets stay private, missing credentials and stale edits are rejected", t => {
  const { root, configPath, environmentPath, settings, environment } = fixture(t);
  const initial = settings.get(), original = readFileSync(configPath, "utf8"), secret = randomBytes(32).toString("hex");
  const config = { ...initial.saved, port: 9876, tokenEnv: "NEXT_SERVICE_TOKEN", dataDir: join(root, "next"),
    coordinator: { provider: "openai", model: "not-a-real-model" },
    disabledExecutors: ["claude"] };
  assert.throws(() => settings.validate(parseSettings(settingsConfigSchema, { editToken: initial.editToken, config })), /missing/);
  assert.equal(readFileSync(configPath, "utf8"), original);
  assert.throws(() => settings.saveCredential(parseSettings(credentialUpdateSchema, { editToken: initial.editToken, key: ADMIN_TOKEN_ENV, action: "replace", value: secret })), /not console-managed/);
  assert.throws(() => settings.saveCredential(parseSettings(credentialUpdateSchema, { editToken: initial.editToken, key: "ALIAS_KEY", action: "replace", value: environment.TASK_CONDUCTOR_TOKEN })), /cannot be reused/);
  const prepared = settings.saveCredential(parseSettings(credentialUpdateSchema, { editToken: initial.editToken, key: "OPENAI_API_KEY", action: "replace", value: secret }));
  assert(!JSON.stringify(prepared).includes(secret));
  assert.throws(() => settings.saveConfig(parseSettings(settingsConfigSchema, { editToken: initial.editToken, config })), /changed/);
  const saved = settings.saveConfig(parseSettings(settingsConfigSchema, { editToken: prepared.editToken, config }));
  assert.equal(saved.running.dataDir, root);
  assert.equal(saved.running.port, 8765);
  assert.equal(saved.saved.dataDir, config.dataDir);
  assert.deepEqual(saved.saved.disabledExecutors, ["claude"]);
  assert.deepEqual(saved.running.disabledExecutors, []);
  assert.equal(settings.status().pendingRestart, true);
  assert.equal(readEnvironment(environmentPath).NEXT_SERVICE_TOKEN, environment.TASK_CONDUCTOR_TOKEN);
  assert.equal(readEnvironment(environmentPath).OPENAI_API_KEY, secret);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(environmentPath).mode & 0o777, 0o600);
  assert.throws(() => settings.saveCredential(parseSettings(credentialUpdateSchema, { editToken: saved.editToken, key: "OPENAI_API_KEY", action: "delete" })), /still references/);
  assert(!JSON.stringify(saved).includes(secret));
});
test("token aliases cannot become model credentials through settings or offline startup", async t => {
  const { root, configPath, settings } = fixture(t);
  let view = settings.get();
  view = settings.saveConfig(parseSettings(settingsConfigSchema, { editToken: view.editToken, config: { ...view.saved, tokenEnv: "NEXT_SERVICE_TOKEN" } }));
  const before = readFileSync(configPath, "utf8");
  const config = { ...view.saved, dataDir: join(root, "next"), coordinator: { provider: "openai-compatible", model: "example",
    baseUrl: "https://untrusted.invalid/v1", apiKeyEnv: "TASK_CONDUCTOR_TOKEN", contextWindow: 4096, maxTokens: 1024 } };
  const input = { editToken: view.editToken, config };
  assert.throws(() => settings.validate(parseSettings(settingsConfigSchema, input)), /distinct/);
  assert.throws(() => settings.saveConfig(parseSettings(settingsConfigSchema, input)), /distinct/);
  assert.equal(readFileSync(configPath, "utf8"), before);
  settings.close();
  const locator = JSON.stringify({ dataDir: root });
  writeFileSync(join(root, "launch.json"), locator, { mode: 0o600 });
  // An offline edit must fail before copying secrets or switching the active directory.
  writeFileSync(configPath, JSON.stringify(config));
  await assert.rejects(prepareStartup(root), /distinct/);
  assert.equal(readFileSync(join(root, "launch.json"), "utf8"), locator);
  assert(!existsSync(config.dataDir));
});
test("changing a model endpoint requires separately prepared credentials", t => {
  const { settings, configPath } = fixture(t);
  let view = settings.saveCredential(parseSettings(credentialUpdateSchema, { editToken: settings.get().editToken, key: "OPENAI_API_KEY", action: "replace", value: randomBytes(32).toString("hex") }));
  view = settings.saveConfig(parseSettings(settingsConfigSchema, { editToken: view.editToken, config: { ...view.saved, coordinator: { provider: "openai", model: "not-a-real-model" } } }));
  const before = readFileSync(configPath, "utf8");
  const config = { ...view.saved, coordinator: { provider: "openai-compatible", model: "example", api: "openai-completions",
    baseUrl: "https://untrusted.invalid/v1", apiKeyEnv: "OPENAI_API_KEY", contextWindow: 4096, maxTokens: 1024 } };
  assert.throws(() => settings.validate(parseSettings(settingsConfigSchema, { editToken: view.editToken, config })), /new credential reference/);
  assert.equal(readFileSync(configPath, "utf8"), before);
  view = settings.saveCredential(parseSettings(credentialUpdateSchema, { editToken: view.editToken, key: "NEXT_API_KEY", action: "replace", value: randomBytes(32).toString("hex") }));
  config.coordinator.apiKeyEnv = "NEXT_API_KEY";
  assert.equal(settings.saveConfig(parseSettings(settingsConfigSchema, { editToken: view.editToken, config })).saved.coordinator.apiKeyEnv, "NEXT_API_KEY");
});
test("private files reject insecure boundaries and out-of-band overwrites without repairing data", t => {
  const { root, configPath, settings } = fixture(t), edit = settings.get();
  const external = JSON.stringify({ dataDir: root, disabledExecutors: [], port: 8766 });
  writeFileSync(configPath, external);
  assert.throws(() => settings.saveConfig(parseSettings(settingsConfigSchema, { editToken: edit.editToken, config: edit.saved })), /changed/);
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
test("executor enable and disable edits share validation and apply only at next start", t => {
  const { settings, configPath } = fixture(t);
  let view = settings.get();
  const change = value => settings.prepareChange(parseSettings(settingsChangeSchema, { editToken: view.editToken, change: value }));
  view = settings.saveConfig(parseSettings(settingsConfigSchema, change({ action: "executor-disable", id: "codex" })));
  assert.deepEqual(view.saved.disabledExecutors, ["codex"]);
  assert.deepEqual(view.running.disabledExecutors, []);
  view = settings.saveConfig(parseSettings(settingsConfigSchema, change({ action: "executor-disable", id: "codex" })));
  assert.deepEqual(view.saved.disabledExecutors, ["codex"]);
  const original = readFileSync(configPath, "utf8");
  assert.throws(() => change({ action: "executor-disable", id: "arbitrary-command" }), /Invalid fields/);
  assert.throws(() => settings.saveConfig(parseSettings(settingsConfigSchema, {
    editToken: view.editToken, config: { ...view.saved, disabledExecutors: ["codex", "codex"] },
  })), /Invalid fields/);
  assert.equal(readFileSync(configPath, "utf8"), original);
  view = settings.saveConfig(parseSettings(settingsConfigSchema, change({ action: "executor-enable", id: "codex" })));
  assert.deepEqual(view.saved.disabledExecutors, []);
  assert.deepEqual(view.running.disabledExecutors, []);
});
