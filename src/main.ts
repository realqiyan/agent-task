import express from "express";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { baseEnvironment, readEnvironment, validateServiceEnvironment } from "./environment.js";
import { bearerVerifier } from "./http-auth.js";
import { Settings } from "./settings.js";
import { createWebRouter } from "./web.js";
import { acquireLock } from "./lock.js";
import { createMcpServer } from "./mcp.js";
import { errorText } from "./model.js";
import { TaskStore } from "./task-storage.js";
import { Tasks } from "./tasks.js";
import { Results } from "./results.js";
import { createExecution } from "./node-execution.js";
import { executorEnvironment } from "./executor-runtime.js";
import { createCoordinator } from "./coordinator.js";

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
const authorized = bearerVerifier(token);
let http: Server | undefined;
let tasks: Tasks | undefined, taskStore: TaskStore | undefined, settings: Settings | undefined;
let release: (() => Promise<void>) | undefined;
let shutting: Promise<void> | undefined;
const connections = new Set<() => Promise<void>>();
function shutdown(code: number, drain = false): Promise<void> {
  process.exitCode = Math.max(process.exitCode ? Number(process.exitCode) : 0, code);
  return shutting ??= (async () => {
    settings?.close();
    try { await tasks?.close(); }
    catch (error) { console.error(errorText(error)); process.exitCode = 1; }
    for (const close of connections) await close().catch(() => {});
    if (http) {
      if (drain) http.close(); // Release the listener, but retain the in-flight Web restart response.
      else { http.closeAllConnections(); await new Promise<void>(done => http!.close(() => done())); }
    }
    taskStore?.close();
    await release?.();
  })().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
}
const fatal = (error: unknown) => { console.error(errorText(error)); void shutdown(1).finally(() => { if (process.connected) process.disconnect(); }); };
let restartPending = false;
const restart = async () => {
  if (!process.connected || restartPending || shutting || settings?.status().writeBlocked) throw new Error("Restart unavailable");
  restartPending = true;
  return new Promise<unknown>((resolve, reject) => {
    process.once("message", function receive(value: { type?: string; ready?: unknown; error?: string }) {
      if (value.type !== "restarted") { process.once("message", receive); return; }
      // The HTTP adapter finishes the authenticated response before this child exits.
      setTimeout(() => { if (process.connected) process.disconnect(); http?.closeAllConnections(); }, 200);
      if (value.error) reject(new Error(value.error)); else resolve(value.ready);
    });
    process.send!({ type: "restart" });
  });
};
process.on("message", (value: { type?: string }) => {
  if (value.type === "drain") void shutdown(0, true).then(() => {
    if (process.exitCode) { if (process.connected) process.disconnect(); }
    else process.send?.({ type: "drained" });
  });
});
const stop = () => { void shutdown(0).finally(() => { http?.closeAllConnections(); if (process.connected) process.disconnect(); }); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
process.once("disconnect", stop);
try {
  release = await acquireLock(config.dataDir);
  taskStore = new TaskStore(config.dataDir);
  tasks = new Tasks(taskStore, config.executors, new Results(config.dataDir), createExecution(executorEnvironment(native, environment, config)),
    config.coordinator ? createCoordinator(config.dataDir, config.coordinator) : undefined, fatal);
  const app = express();
  app.disable("x-powered-by"); app.disable("etag");
  app.use((_req, res, next) => {
    if (shutting) { res.status(503).end(); return; }
    next();
  });
  if (adminToken) {
    settings = new Settings(configPath, environmentPath, config, base, process.env);
    app.use("/admin", createWebRouter(tasks, settings, adminToken, fatal, restart, instanceId));
  }
  app.use("/mcp", (req, res, next) => {
    const suffix = req.socket.localPort === 80 ? "" : ":" + req.socket.localPort;
    if (req.headers.origin !== undefined || !["127.0.0.1" + suffix, "localhost" + suffix].includes(req.headers.host ?? "")) { res.status(403).end(); return; }
    if (!authorized(req.headers.authorization)) {
      res.status(401).set("WWW-Authenticate", "Bearer").end(); return;
    }
    next();
  }, express.json({ limit: "512kb" }));
  app.post("/mcp", async (req, res) => {
    const server = createMcpServer(tasks!, fatal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const close = async () => { connections.delete(close); await transport.close(); await server.close(); };
    connections.add(close);
    res.once("close", () => { void close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: "MCP request failed" });
      await close();
    }
  });
  app.all("/mcp", (_req, res) => { res.status(405).set("Allow", "POST").end(); });
  app.use((_req, res) => { res.status(404).end(); });
  app.use(((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status === 413 ? 413 : 400).json({ error: "Invalid request body" });
  }) satisfies express.ErrorRequestHandler);
  http = await new Promise<Server>((done, reject) => {
    const listening = app.listen(config.port, "127.0.0.1", () => done(listening));
    listening.once("error", reject);
  });
  if (shutting) { http.closeAllConnections(); http.close(); throw new Error("Startup stopped"); }
  tasks.start();
  const address = http.address();
  const origin = "http://127.0.0.1:" + (typeof address === "object" && address ? address.port : config.port);
  const ready = { instanceId, pid: process.pid, url: origin + "/mcp", consoleUrl: settings ? origin + "/admin/" : null };
  console.log(JSON.stringify({ event: "ready", ...ready }));
  process.send?.({ type: "ready", ready });
} catch (error) { fatal(error); }
