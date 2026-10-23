import type { SettingsSnapshot } from "./model.js";

/** Private configuration documents. Publication order and conflict policy belong to Settings. */
export interface SettingsFiles {
  read(): SettingsSnapshot;
  publish(target: "config" | "environment", value: unknown): void;
}
export interface ConfigurationPaths {
  resolveWorkspace(path: string): string;
  checkDataDirectory(path: string): void;
}
