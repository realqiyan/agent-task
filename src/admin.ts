import { readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadConfig } from "./config.js";
import { executorSchema } from "./model.js";
import { acquireLock } from "./lock.js";

process.umask(0o077);
const [action, configPath, profilePath] = process.argv.slice(2);
if (!configPath || !["register", "list"].includes(action ?? "") || (action === "register" && !profilePath)) {
  throw new Error("Usage: node dist/admin.js list CONFIG | register CONFIG PROFILE.json (service stopped)");
}
const path = resolve(configPath), config = loadConfig(path);
const release = await acquireLock(config.dataDir, () => { process.exitCode = 1; });
try {
  if (action === "list") {
    console.log(JSON.stringify(config.executors.map(({ id, command, args, cwd, envKeys, permissionAllowlist, unattendedApproved, resultReadRoots }) =>
      ({ id, transport: "stdio", command, args, cwd, envKeys, permissionAllowlist, unattendedApproved, resultReadRoots })), null, 2));
  } else {
    const profile = executorSchema.parse(JSON.parse(readFileSync(resolve(profilePath!), "utf8")));
    if (config.executors.some(item => item.id === profile.id)) throw new Error("Executor ID already registered; edit reviewed config while stopped to replace");
    config.executors.push(profile);
    const temporary = path + ".register-" + process.pid;
    writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    try {
      // Validate the complete candidate, including token separation and canonical local paths, before publication.
      loadConfig(temporary);
      const fd = openSync(temporary, "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, path);
    } catch (error) { unlinkSync(temporary); throw error; }
    const dir = openSync(dirname(path), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
    console.log(JSON.stringify({ registered: profile.id, transport: "stdio" }));
  }
} finally { await release(); }
