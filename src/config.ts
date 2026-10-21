import { readFileSync, realpathSync, statSync, accessSync, constants } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";
import { executorSchema } from "./model.js";

const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const baseEnvKeys = ["PATH", "LANG", "LC_ALL", "TZ"];
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
  const config = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  if (!isAbsolute(config.dataDir)) throw new Error("dataDir must be absolute");
  const coordinatorKey = config.coordinator ? coordinatorCredentialEnv(config.coordinator) : undefined;
  if ([...baseEnvKeys, "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", coordinatorKey].includes(config.tokenEnv)) throw new Error("tokenEnv must be separate from base environment and model credentials");
  const ids = new Set<string>();
  for (const executor of config.executors) {
    if (ids.has(executor.id)) throw new Error("Duplicate executor ID");
    ids.add(executor.id);
    if (!isAbsolute(executor.command) || !isAbsolute(executor.cwd)) throw new Error("Executor command and cwd must be absolute");
    if (basename(executor.command) === "pi") {
      throw new Error(`Executor ${executor.id}: pi CLI is not an ACP server (including --mode rpc). Install pi-acp with npm install -g pi-acp@0.0.34 and configure its absolute executable path.`);
    }
    const piCommandOverride = executor.envKeys.includes("PI_ACP_PI_COMMAND") && process.env.PI_ACP_PI_COMMAND;
    if (basename(executor.command) === "pi-acp" && !piCommandOverride && !(process.env.PATH ?? "").split(delimiter).some(directory => {
      if (!isAbsolute(directory)) return false;
      try {
        const file = join(directory, "pi");
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch { return false; }
    })) {
      throw new Error(`Executor ${executor.id}: pi-acp requires pi on the executor PATH. Install/configure pi before starting the service.`);
    }
    try {
      executor.command = realpathSync(executor.command);
      accessSync(executor.command, constants.X_OK);
    } catch {
      throw new Error(`Executor ${executor.id}: ACP executable is missing or not executable. Check the administrator-configured absolute command path. For Pi, install npm install -g pi-acp@0.0.34 and use command -v pi-acp to locate it; pi must also be on the executor PATH.`);
    }
    executor.cwd = realpathSync(executor.cwd);
    if (!statSync(executor.command).isFile() || !statSync(executor.cwd).isDirectory()) throw new Error("Invalid executor command or cwd");
    for (const root of executor.resultReadRoots) {
      if (!isAbsolute(root) || realpathSync(root) !== root || !statSync(root).isDirectory()) throw new Error("Result read roots must be canonical absolute directories");
    }
    if (executor.envKeys.includes(config.tokenEnv)) throw new Error("Service token must not be passed to executors");
    if (coordinatorKey && executor.envKeys.includes(coordinatorKey)) throw new Error("Coordinator credential must not be passed to executors; use separate executor credentials");
  }
  return config;
}
/** No shell or wholesale inheritance; secrets are references to administrator-selected environment keys. */
export function executorEnv(keys: string[], source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of new Set(["PATH", "LANG", "LC_ALL", "TZ", ...keys])) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}
