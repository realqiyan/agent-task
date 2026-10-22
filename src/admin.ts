import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, validateConfig } from "./config.js";
import { replacePrivateText } from "./private-files.js";
import { executorSchema } from "./model.js";
import { acquireLock } from "./lock.js";

process.umask(0o077);
const [action, configPath, profilePath] = process.argv.slice(2);
if (!configPath || !["register", "list"].includes(action ?? "") || (action === "register" && !profilePath)) {
  throw new Error("Usage: node dist/admin.js list CONFIG | register CONFIG PROFILE.json (service stopped)");
}
const path = resolve(configPath), config = loadConfig(path);
const release = await acquireLock(config.dataDir);
try {
  if (action === "list") {
    console.log(JSON.stringify(config.executors.map(({ id, command, args, cwd, envKeys, permissionAllowlist, unattendedApproved, resultReadRoots }) =>
      ({ id, transport: "stdio", command, args, cwd, envKeys, permissionAllowlist, unattendedApproved, resultReadRoots })), null, 2));
  } else {
    const profile = executorSchema.parse(JSON.parse(readFileSync(resolve(profilePath!), "utf8")));
    if (config.executors.some(item => item.id === profile.id)) throw new Error("Executor ID already registered; edit reviewed config while stopped to replace");
    config.executors.push(profile);
    // Validate the complete candidate before publication, using the same rules as startup and the console.
    replacePrivateText(path, JSON.stringify(validateConfig(config), null, 2) + "\n");
    console.log(JSON.stringify({ registered: profile.id, transport: "stdio" }));
  }
} finally { await release(); }
