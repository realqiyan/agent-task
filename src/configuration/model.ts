import type { Executor } from "../executors/model.js";

export type Environment = Record<string, string | undefined>;
export type CoordinatorConfig = { provider: "openai" | "anthropic" | "deepseek"; model: string } | {
  provider: "openai-compatible"; model: string; api: "openai-completions" | "openai-responses";
  baseUrl: string; apiKeyEnv: string; contextWindow: number; maxTokens: number; reasoning: boolean;
};
export type Config = { dataDir: string; port: number; tokenEnv: string; coordinator?: CoordinatorConfig; executors: Executor[] };
export type SettingsSnapshot = { configText: string; environmentText: string; config: Config; environment: Record<string, string> };
export type ConfigEdit = { editToken: string; config: Config; approveExecutors: string[] };
export type SettingsChange = { editToken: string; change:
  { action: "executor-add"; executor: Omit<Executor, "unattendedApproved"> } |
  { action: "executor-update"; id: string; patch: Partial<Omit<Executor, "unattendedApproved">> } |
  { action: "executor-remove" | "executor-approve" | "executor-revoke"; id: string } |
  { action: "coordinator-set"; coordinator: CoordinatorConfig } | { action: "coordinator-clear" }
};
export type CredentialEdit = { editToken: string; key: string } & ({ action: "delete" } | { action: "replace"; value: string });
