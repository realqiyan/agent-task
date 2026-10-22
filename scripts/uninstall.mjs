#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { argumentsFor, installRoot, readManifest, saveManifest, operationLock, deactivate, removeInventory, json } from "./install-lib.mjs";

import { startupPaths } from "../dist/startup.js";
import { acquireLauncherLock } from "../dist/lock.js";

process.umask(0o077);
const options = argumentsFor(process.argv.slice(2));
if (options.help) {
  console.log("Usage: agent-task uninstall [--home ABSOLUTE_PRIVATE_DIR]\nStops/removes the owned service and installed components only. Keeps configuration, credentials, logs, task history and workspaces.");
  process.exit(0);
}
let unlock, release, unlockLauncher;
try {
  if (Object.keys(options).some(key => key !== "home")) throw new Error("Only --home is accepted");
  const root = installRoot(options);
  if (!existsSync(root)) { console.log("Nothing installed; nothing removed."); process.exit(0); }
  readManifest(root);
  unlock = operationLock(root);
  const manifest = readManifest(root);
  deactivate(manifest);
  manifest.serviceInstalled = false; saveManifest(root, manifest);
  unlockLauncher = acquireLauncherLock(root);
  if (existsSync(join(root, "launch.json"))) {
    const paths = startupPaths(root), config = json(paths.configPath);
    const protectedPaths = [paths.dataDir, config.dataDir, ...config.executors.map(executor => executor.cwd)];
    // Verify the service is stopped, including any manually started owner.
    const lockModule = join(manifest.app, "dist/lock.js");
    if (existsSync(lockModule)) {
      const { acquireLock } = await import(pathToFileURL(lockModule).href);
      release = await acquireLock(paths.dataDir);
      const storeModule = join(manifest.app, "dist/task-storage.js");
      if (existsSync(join(paths.dataDir, "tasks.sqlite")) && existsSync(storeModule)) {
        const { TaskStore } = await import(pathToFileURL(storeModule).href);
        const store = new TaskStore(paths.dataDir);
        try {
          for (const task of store.definitions()) protectedPaths.push(task.workspace, task.input.workspace, ...Object.values(task.executors).map(executor => executor.cwd));
          for (const run of store.rounds()) for (const node of run.nodes) protectedPaths.push(node.workspace);
        } finally { store.close(); }
      }
    } else if (manifest.phase !== "uninstalled") throw new Error("Cannot verify data ownership; resume setup before uninstall");
    for (const path of protectedPaths.filter(Boolean)) {
      const canonical = existsSync(path) ? realpathSync(path) : path;
      const components = join(root, "components");
      if (canonical === components || canonical.startsWith(components + "/")) {
        throw new Error("Installed components are referenced as data/workspace; refusing to delete them");
      }
    }
  }
  removeInventory(root, manifest.files);
  manifest.phase = "uninstalled"; manifest.files = []; saveManifest(root, manifest);
  console.log("Owned service and inventoried components removed. Configuration, environment.json, logs, data, workspaces and all native/shared executor authentication are preserved. Repeated uninstall is safe.");
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await release?.(); unlockLauncher?.(); unlock?.(); }
