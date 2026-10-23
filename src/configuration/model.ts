import type { ExecutorType } from "../executors/model.js";

export type Environment = Record<string, string | undefined>;
export type CoordinatorConfig = { provider: "openai" | "anthropic" | "deepseek"; model: string } | {
  provider: "openai-compatible"; model: string; api: "openai-completions" | "openai-responses";
  baseUrl: string; apiKeyEnv: string; contextWindow: number; maxTokens: number; reasoning: boolean;
};
export type Config = { dataDir: string; port: number; tokenEnv: string; coordinator?: CoordinatorConfig; disabledExecutors: ExecutorType[] };
export type SettingsSnapshot = { configText: string; environmentText: string; config: Config; environment: Record<string, string> };
export type ConfigEdit = { editToken: string; config: Config };
export type SettingsChange = { editToken: string; change:
  { action: "executor-enable" | "executor-disable"; id: ExecutorType } |
  { action: "coordinator-set"; coordinator: CoordinatorConfig } | { action: "coordinator-clear" }
};
export type CredentialEdit = { editToken: string; key: string } & ({ action: "delete" } | { action: "replace"; value: string });
