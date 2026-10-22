import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { executorSchema } from "./model.js";
import { readPrivateText } from "./private-files.js";

export const ADMIN_TOKEN_ENV = "AGENT_TASK_ADMIN_TOKEN";
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const baseEnvKeys = ["HOME", "PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_OPTIONS", "NODE_PATH", "__proto__", "constructor", "prototype"];
const modelId = z.string().min(1).max(200);
const coordinatorSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.enum(["openai", "anthropic", "deepseek"]), model: modelId }).strict(),
  z.object({
    provider: z.literal("openai-compatible"), model: modelId,
    api: z.enum(["openai-completions", "openai-responses"]).default("openai-completions"),
    baseUrl: z.string().url().refine(value => {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }, "baseUrl must be HTTP(S) without credentials, query or fragment"),
    apiKeyEnv: envKey.refine(key => !baseEnvKeys.includes(key), "Credential must not use a base environment key"),
    contextWindow: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    reasoning: z.boolean().default(false),
  }).strict(),
]).refine(value => value.provider !== "openai-compatible" || value.maxTokens <= value.contextWindow,
  "maxTokens must not exceed contextWindow");

export const configSchema = z.object({
  dataDir: z.string().min(1),
  port: z.number().int().min(0).max(65535).default(8765),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default("AGENT_TASK_TOKEN"),
  coordinator: coordinatorSchema.optional(),
  executors: z.array(executorSchema).max(100).default([]),
}).strict();
export type Config = z.infer<typeof configSchema>;
export function coordinatorCredentialEnv(config: NonNullable<Config["coordinator"]>): string {
  switch (config.provider) {
    case "openai": return "OPENAI_API_KEY";
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "deepseek": return "DEEPSEEK_API_KEY";
    case "openai-compatible": return config.apiKeyEnv;
  }
}
export function loadConfig(path: string): Config {
  let value: unknown;
  try { value = JSON.parse(readPrivateText(path)); } catch { throw new Error("Cannot read configuration JSON"); }
  return validateConfig(value);
}
export function validateConfig(value: unknown): Config {
  const config = configSchema.parse(value);
  if (!isAbsolute(config.dataDir) || /[\x00-\x1f\x7f]/.test(config.dataDir)) throw new Error("dataDir must be absolute without control characters");
  const coordinatorKey = config.coordinator ? coordinatorCredentialEnv(config.coordinator) : undefined;
  if (/^(NODE_|LD_|DYLD_)/.test(config.tokenEnv) || [...baseEnvKeys, ADMIN_TOKEN_ENV, "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", coordinatorKey].includes(config.tokenEnv)) throw new Error("tokenEnv must be separate from base environment, administrator and model credentials");
  if (coordinatorKey === ADMIN_TOKEN_ENV) throw new Error("Administrator token must not be used as a model credential");
  const ids = new Set<string>();
  for (const executor of config.executors) {
    if (ids.has(executor.id)) throw new Error("Duplicate executor ID");
    ids.add(executor.id);
    if (!isAbsolute(executor.cwd)) throw new Error("Executor cwd must be absolute");
    executor.cwd = realpathSync(executor.cwd);
    if (!statSync(executor.cwd).isDirectory()) throw new Error("Invalid executor cwd");
  }
  return config;
}
