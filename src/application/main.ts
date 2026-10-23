import { HttpServer } from "../protocol/http/server.js";
import { createTaskRuntime } from "./task-runtime.js";
import { LocalSettingsFiles, configurationPaths } from "../configuration/files.js";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../configuration/files.js";
import { baseEnvironment, validateServiceEnvironment } from "../configuration/environment.js";
import { readEnvironment } from "../configuration/files.js";
import { Settings } from "../configuration/settings.js";
import { acquireLock } from "../infrastructure/lock.js";
import { errorText } from "../shared/errors.js";
import { createExecution } from "../integrations/acp/execution.js";
import { executorEnvironment } from "../executors/environment.js";
import { createCoordinator } from "../integrations/coordinator/coordinator.js";

process.umask(0o077);
const args = process.argv.slice(2);
if (args[0] !== "--config" || args.length !== 4 || args[2] !== "--environment") {
  console.error("Internal runtime requires --config PATH --environment PATH; use agent-task start");
  process.exit(2);
}
const configPath = resolve(args[1]!), environmentPath = resolve(args[3]!);
const native = { ...process.env }, base = baseEnvironment(native);
const environment = readEnvironment(environmentPath);
const instanceId = process.env.AGENT_TASK_INSTANCE_ID ?? randomUUID();
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, base, environment);
const config = loadConfig(configPath);
const { token, adminToken } = validateServiceEnvironment(config, environment);
let http: HttpServer | undefined;
let tasks: ReturnType<typeof createTaskRuntime> | undefined, settings: Settings | undefined;
let release: (() => Promise<void>) | undefined;
let shutting: Promise<void> | undefined;
function shutdown(code: number, drain = false): Promise<void> {
  process.exitCode = Math.max(process.exitCode ? Number(process.exitCode) : 0, code);
  return shutting ??= (async () => {
    http?.stopAccepting();
    settings?.close();
    try { await tasks?.close(); }
    catch (error) { console.error(errorText(error)); process.exitCode = 1; }
    await http?.close(drain);
    await release?.();
  })().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
}
const fatal = (error: unknown) => { console.error(errorText(error)); void shutdown(1).finally(() => { if (process.connected) process.disconnect(); }); };
let restartPending = false;
const restart = async () => {
  if (!process.connected || restartPending || shutting) throw new Error("Restart unavailable");
  restartPending = true;
  return new Promise<unknown>((resolve, reject) => {
    process.once("message", function receive(value: { type?: string; ready?: unknown; error?: string }) {
      if (value.type !== "restarted") { process.once("message", receive); return; }
      if (value.error && !shutting) { restartPending = false; reject(new Error(value.error)); return; }
      // The HTTP adapter finishes the authenticated response before this child exits.
      setTimeout(() => { if (process.connected) process.disconnect(); http?.closeConnections(); }, 200);
      if (value.error) reject(new Error(value.error)); else resolve(value.ready);
    });
    process.send!({ type: "restart" });
  });
};
process.on("message", (value: { type?: string }) => {
  if (value.type !== "drain") return;
  // Both Web and CLI restarts pass this boundary before changing runtime ownership.
  try {
    if (settings?.status().writeBlocked) throw new Error("Configuration publication is uncertain");
  } catch {
    process.send?.({ type: "drained", error: "Restart blocked; stop and inspect private configuration files" });
    return;
  }
  void shutdown(0, true).then(() => {
    if (process.exitCode) { if (process.connected) process.disconnect(); }
    else process.send?.({ type: "drained" });
  });
});
const stop = () => { void shutdown(0).finally(() => { http?.closeConnections(); if (process.connected) process.disconnect(); }); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
process.once("disconnect", stop);
try {
  release = await acquireLock(config.dataDir);
  tasks = createTaskRuntime(config.dataDir, config.executors, createExecution(executorEnvironment(native, environment, config)),
    config.coordinator ? createCoordinator(config.dataDir, config.coordinator) : undefined, fatal);
  if (adminToken) settings = new Settings(new LocalSettingsFiles(configPath, environmentPath), configurationPaths, config, base, process.env);
  http = new HttpServer({ tasks, settings, token, adminToken, fatal, restart, instanceId });
  const origin = await http.listen(config.port);
  if (shutting) throw new Error("Startup stopped");
  tasks.supervisor.start();
  const ready = { instanceId, pid: process.pid, url: origin + "/mcp", consoleUrl: settings ? origin + "/admin/" : null };
  console.log(JSON.stringify({ event: "ready", ...ready }));
  process.send?.({ type: "ready", ready });
} catch (error) { fatal(error); }
