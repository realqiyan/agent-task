import { startupPaths } from "../configuration/files.js";
import { existsSync, mkdirSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../configuration/files.js";
import { readEnvironment } from "../configuration/files.js";
import { validateServiceEnvironment } from "../configuration/environment.js";
import { checkDataDirectory, readPrivateText, replacePrivateText } from "../infrastructure/private-files.js";
import { acquireLock } from "../infrastructure/lock.js";

function prepareFile(path: string, text: string): void {
  if (existsSync(path)) {
    if (readPrivateText(path) !== text) throw new Error("Target contains different startup files; refusing to overwrite them");
    return; // Explicitly resume an interrupted preparation, not a data repair.
  }
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}
export async function prepareStartup(home: string) {
  const current = startupPaths(home), config = loadConfig(current.configPath), environment = readEnvironment(current.environmentPath);
  validateServiceEnvironment(config, environment);
  checkDataDirectory(config.dataDir);
  if (config.dataDir !== current.dataDir) {
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    checkDataDirectory(config.dataDir);
    const release = await acquireLock(config.dataDir);
    try {
      // Only next-start inputs. Never copy tasks, sessions, results, native configuration or workspaces.
      prepareFile(join(config.dataDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
      prepareFile(join(config.dataDir, "environment.json"), JSON.stringify(environment, null, 2) + "\n");
      const fd = openSync(config.dataDir, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      replacePrivateText(join(home, "launch.json"), JSON.stringify({ dataDir: config.dataDir }) + "\n");
    } finally { await release(); }
  }
  return { ...startupPaths(home), config, environment };
}
