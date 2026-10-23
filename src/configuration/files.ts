import { join } from "node:path";
import { z } from "zod";
import { checkDataDirectory, readPrivateText, replacePrivateText } from "../infrastructure/private-files.js";
import { configSchema } from "./contract.js";
import { parseEnvironment } from "./environment.js";
import { validateConfig } from "./policy.js";
import type { ConfigurationPaths, SettingsFiles } from "./ports.js";

export const configurationPaths: ConfigurationPaths = { checkDataDirectory };
export function loadConfig(path: string) {
  let value: unknown;
  try { value = JSON.parse(readPrivateText(path)); } catch { throw new Error("Cannot read configuration JSON"); }
  return validateConfig(configSchema.parse(value));
}
export function readEnvironment(path: string): Record<string, string> { return parseEnvironment(readPrivateText(path)); }
export class LocalSettingsFiles implements SettingsFiles {
  constructor(private readonly configPath: string, private readonly environmentPath: string) {
    if (configPath === environmentPath) throw new Error("Configuration and environment must be separate files");
  }
  read() {
    const configText = readPrivateText(this.configPath), environmentText = readPrivateText(this.environmentPath);
    return { configText, environmentText, config: configSchema.parse(JSON.parse(configText)), environment: parseEnvironment(environmentText) };
  }
  publish(target: "config" | "environment", value: unknown): void {
    replacePrivateText(target === "config" ? this.configPath : this.environmentPath, JSON.stringify(value, null, 2) + "\n");
  }
}

/** A stable launch locator is the only runtime input outside the selected dataDir. */
export function startupPaths(home: string) {
  const { dataDir } = z.object({ dataDir: z.string() }).strict().parse(JSON.parse(readPrivateText(join(home, "launch.json"))));
  checkDataDirectory(dataDir);
  return { dataDir, configPath: join(dataDir, "config.json"), environmentPath: join(dataDir, "environment.json") };
}
