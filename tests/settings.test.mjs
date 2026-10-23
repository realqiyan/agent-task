import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, chmodSync, statSync, symlinkSync, renameSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Settings } from "../dist/settings.js";
import { loadConfig, ADMIN_TOKEN_ENV } from "../dist/config.js";
import { readEnvironment } from "../dist/environment.js";
import { prepareStartup } from "../dist/startup.js";
import { replacePrivateText, FileCommitError } from "../dist/private-files.js";

function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json"), environmentPath = join(root, "environment.json");
  const environment = { AGENT_TASK_TOKEN: randomBytes(32).toString("hex"), [ADMIN_TOKEN_ENV]: randomBytes(32).toString("hex") };
  writeFileSync(configPath, JSON.stringify({ dataDir: root, executors: [] }), { mode: 0o600 });
  writeFileSync(environmentPath, JSON.stringify(environment), { mode: 0o600 });
  const settings = new Settings(configPath, environmentPath, loadConfig(configPath), {}, environment);
  t.after(() => settings.close());
  return { root, configPath, environmentPath, environment, settings };
}
test("startup edits are next-start only; secrets stay private, missing credentials and stale edits are rejected", t => {
  const { root, configPath, environmentPath, settings, environment } = fixture(t);
  const initial = settings.get(), original = readFileSync(configPath, "utf8"), secret = randomBytes(32).toString("hex");
  const config = { ...initial.saved, port: 9876, tokenEnv: "NEXT_SERVICE_TOKEN", dataDir: join(root, "next"),
    coordinator: { provider: "openai", model: "not-a-real-model" },
    executors: [{ id: "local", type: "claude", note: "native authorization", cwd: root }] };
  assert.throws(() => settings.validate({ editToken: initial.editToken, config }), /missing/);
  assert.equal(readFileSync(configPath, "utf8"), original);
  assert.throws(() => settings.saveCredential({ editToken: initial.editToken, key: ADMIN_TOKEN_ENV, action: "replace", value: secret }), /not console-managed/);
  assert.throws(() => settings.saveCredential({ editToken: initial.editToken, key: "ALIAS_KEY", action: "replace", value: environment.AGENT_TASK_TOKEN }), /cannot be reused/);
  const prepared = settings.saveCredential({ editToken: initial.editToken, key: "OPENAI_API_KEY", action: "replace", value: secret });
  assert(!JSON.stringify(prepared).includes(secret));
  assert.throws(() => settings.saveConfig({ editToken: initial.editToken, config }), /changed/);
  const saved = settings.saveConfig({ editToken: prepared.editToken, config });
  assert.equal(saved.running.dataDir, root);
  assert.equal(saved.running.port, 8765);
  assert.equal(saved.saved.dataDir, config.dataDir);
  assert.equal(saved.saved.executors[0].note, "native authorization");
  assert.equal(settings.status().pendingRestart, true);
  assert.equal(readEnvironment(environmentPath).NEXT_SERVICE_TOKEN, environment.AGENT_TASK_TOKEN);
  assert.equal(readEnvironment(environmentPath).OPENAI_API_KEY, secret);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(environmentPath).mode & 0o777, 0o600);
  assert.throws(() => settings.saveCredential({ editToken: saved.editToken, key: "OPENAI_API_KEY", action: "delete" }), /still references/);
  assert(!JSON.stringify(saved).includes(secret));
});
test("token aliases cannot become model credentials through settings or offline startup", async t => {
  const { root, configPath, settings } = fixture(t);
  let view = settings.get();
  view = settings.saveConfig({ editToken: view.editToken, config: { ...view.saved, tokenEnv: "NEXT_SERVICE_TOKEN" } });
  const before = readFileSync(configPath, "utf8");
  const config = { ...view.saved, dataDir: join(root, "next"), coordinator: { provider: "openai-compatible", model: "example",
    baseUrl: "https://untrusted.invalid/v1", apiKeyEnv: "AGENT_TASK_TOKEN", contextWindow: 4096, maxTokens: 1024 } };
  const input = { editToken: view.editToken, config };
  assert.throws(() => settings.validate(input), /distinct/);
  assert.throws(() => settings.saveConfig(input), /distinct/);
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
  let view = settings.saveCredential({ editToken: settings.get().editToken, key: "OPENAI_API_KEY", action: "replace", value: randomBytes(32).toString("hex") });
  view = settings.saveConfig({ editToken: view.editToken, config: { ...view.saved, coordinator: { provider: "openai", model: "not-a-real-model" } } });
  const before = readFileSync(configPath, "utf8");
  const config = { ...view.saved, coordinator: { provider: "openai-compatible", model: "example", api: "openai-completions",
    baseUrl: "https://untrusted.invalid/v1", apiKeyEnv: "OPENAI_API_KEY", contextWindow: 4096, maxTokens: 1024 } };
  assert.throws(() => settings.validate({ editToken: view.editToken, config }), /new credential reference/);
  assert.equal(readFileSync(configPath, "utf8"), before);
  view = settings.saveCredential({ editToken: view.editToken, key: "NEXT_API_KEY", action: "replace", value: randomBytes(32).toString("hex") });
  config.coordinator.apiKeyEnv = "NEXT_API_KEY";
  assert.equal(settings.saveConfig({ editToken: view.editToken, config }).saved.coordinator.apiKeyEnv, "NEXT_API_KEY");
});
test("private files reject insecure boundaries and out-of-band overwrites without repairing data", t => {
  const { root, configPath, settings } = fixture(t), edit = settings.get();
  const external = JSON.stringify({ dataDir: root, executors: [], port: 8766 });
  writeFileSync(configPath, external);
  assert.throws(() => settings.saveConfig({ editToken: edit.editToken, config: edit.saved }), /changed/);
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
test("executor identity changes require fresh approval in the service; convenience edits cannot retain it", t => {
  const { settings, root, configPath } = fixture(t);
  let view = settings.get();
  const change = value => settings.prepareChange({ editToken: view.editToken, change: value });
  view = settings.saveConfig(change({ action: "executor-add", executor: { id: "local", type: "codex", cwd: root } }));
  assert.equal(view.saved.executors[0].unattendedApproved, false);
  view = settings.saveConfig(change({ action: "executor-approve", id: "local" }));
  assert.equal(view.saved.executors[0].unattendedApproved, true);
  view = settings.saveConfig(change({ action: "executor-update", id: "local", patch: { note: "reviewed" } }));
  assert.equal(view.saved.executors[0].unattendedApproved, true);
  const original = readFileSync(configPath, "utf8");
  for (const patch of [{ id: "renamed" }, { type: "pi" }, { cwd: realpathSync(tmpdir()) }]) {
    const config = structuredClone(view.saved); Object.assign(config.executors[0], patch);
    assert.throws(() => settings.saveConfig({ editToken: view.editToken, config }), /explicit approval/);
    assert.equal(readFileSync(configPath, "utf8"), original);
  }
  const draft = change({ action: "executor-update", id: "local", patch: { type: "pi" } });
  assert.equal(draft.config.executors[0].unattendedApproved, false);
  assert.equal(draft.config.executors[0].note, "reviewed", "partial edits preserve omitted fields");
  // The same reviewed candidate can explicitly renew authorization through either client.
  draft.config.executors[0].unattendedApproved = true; draft.approveExecutors = ["local"];
  view = settings.saveConfig(draft);
  assert.equal(view.saved.executors[0].type, "pi");
  assert.equal(view.saved.executors[0].unattendedApproved, true);
});
