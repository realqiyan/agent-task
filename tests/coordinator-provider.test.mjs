import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configSchema } from "../dist/configuration/contract.js";
import { loadConfig } from "../dist/configuration/files.js";
import { executorEnvironment } from "../dist/executors/environment.js";
import { validateServiceEnvironment } from "../dist/configuration/environment.js";
import { createCoordinatorProvider } from "../dist/integrations/coordinator/provider.js";
import { createModels } from "@earendil-works/pi-ai/models";

const compatible = { provider: "openai-compatible", model: "administrator-model",
  baseUrl: "https://models.example.org/v1", apiKeyEnv: "COORDINATOR_KEY", contextWindow: 32000, maxTokens: 4096 };
const parse = coordinator => configSchema.parse({ dataDir: "/tmp/agent-task", coordinator }).coordinator;

test("SDK providers expose DeepSeek and administrator-defined compatible models without network", () => {
  const deepseek = createCoordinatorProvider(parse({ provider: "deepseek", model: "deepseek-flash" }));
  assert.equal(deepseek.id, "deepseek");
  assert.ok(deepseek.getModels().some(model => model.id === "deepseek-flash"));
  for (const api of ["openai-completions", "openai-responses"]) {
    const models = createModels();
    models.setProvider(createCoordinatorProvider(parse({ ...compatible, api })));
    const model = models.getModel("openai-compatible", compatible.model);
    assert.equal(model.api, api);
    assert.equal(model.baseUrl, compatible.baseUrl);
    assert.equal(model.contextWindow, 32000);
    assert.equal(model.maxTokens, 4096);
    assert.equal(models.getModel("openai-compatible", "unregistered"), undefined);
  }
});

test("compatible config requires explicit endpoint, credential reference and valid limits", () => {
  for (const change of [{ baseUrl: "file:///tmp/model" }, { baseUrl: "https://secret@example.org/v1" },
    { baseUrl: "https://example.org/v1?key=secret" }, { apiKeyEnv: "PATH" }, { apiKeyEnv: "!command" },
    { contextWindow: undefined }, { maxTokens: 32001 }, { apiKey: "literal-secret" }]) {
    assert.throws(() => parse({ ...compatible, ...change }));
  }
});

test("loadConfig isolates DeepSeek and custom coordinator credentials from token and executors", () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "coordinator-config-"));
  const path = join(directory, "config.json");
  try {
    for (const [coordinator, key] of [[{ provider: "deepseek", model: "deepseek-flash" }, "DEEPSEEK_API_KEY"],
      [compatible, "COORDINATOR_KEY"]]) {
      const base = { dataDir: directory, coordinator };
      writeFileSync(path, JSON.stringify({ ...base, tokenEnv: key }), { mode: 0o600 });
      assert.throws(() => loadConfig(path), /tokenEnv must be separate/);
      writeFileSync(path, JSON.stringify({ ...base, disabledExecutors: [] }), { mode: 0o600 });
      const config = loadConfig(path);
      assert.equal(config.coordinator.provider, coordinator.provider);
      assert.equal(executorEnvironment({ [key]: "private" }, {}, config)[key], undefined);
      const environment = { AGENT_TASK_TOKEN: "s".repeat(64), AGENT_TASK_ADMIN_TOKEN: "a".repeat(64) };
      for (const credential of Object.values(environment)) {
        assert.throws(() => validateServiceEnvironment(config, { ...environment, [key]: credential }), /distinct/);
      }
      assert.equal(validateServiceEnvironment(config, { ...environment, [key]: "m".repeat(64) }).token, environment.AGENT_TASK_TOKEN);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
