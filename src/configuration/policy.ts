import type { Config } from "./model.js";

export const ADMIN_TOKEN_ENV = "TASK_CONDUCTOR_ADMIN_TOKEN";
export const baseEnvKeys = ["HOME", "PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_OPTIONS", "NODE_PATH", "__proto__", "constructor", "prototype"];
export function coordinatorCredentialEnv(config: NonNullable<Config["coordinator"]>): string {
  switch (config.provider) {
    case "openai": return "OPENAI_API_KEY";
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "deepseek": return "DEEPSEEK_API_KEY";
    case "openai-compatible": return config.apiKeyEnv;
  }
}
export function validateConfig(value: Config): Config {
  const config = structuredClone(value);
  if (!config.dataDir.startsWith("/") || /[\x00-\x1f\x7f]/.test(config.dataDir)) throw new Error("dataDir must be absolute without control characters");
  const coordinatorKey = config.coordinator ? coordinatorCredentialEnv(config.coordinator) : undefined;
  if (/^(NODE_|LD_|DYLD_)/.test(config.tokenEnv) || [...baseEnvKeys, ADMIN_TOKEN_ENV, "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", coordinatorKey].includes(config.tokenEnv)) throw new Error("tokenEnv must be separate from base environment, administrator and model credentials");
  if (coordinatorKey === ADMIN_TOKEN_ENV) throw new Error("Administrator token must not be used as a model credential");
  if (new Set(config.disabledExecutors).size !== config.disabledExecutors.length) throw new Error("Duplicate disabled executor type");
  return config;
}
