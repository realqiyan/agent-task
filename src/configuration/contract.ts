import { z } from "zod";
import { executorTypeSchema } from "../executors/validation.js";
import { baseEnvKeys } from "./policy.js";
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
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
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default("TASK_CONDUCTOR_TOKEN"),
  coordinator: coordinatorSchema.optional(),
  disabledExecutors: z.array(executorTypeSchema).max(4).refine(types => new Set(types).size === types.length,
    "Disabled executor types must be unique").default([]),
}).strict();
