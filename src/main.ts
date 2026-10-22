import express from "express";
import { resolve } from "node:path";
import type { Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ADMIN_TOKEN_ENV, loadConfig } from "./config.js";
import { baseEnvironment, readEnvironment } from "./environment.js";
import { bearerVerifier } from "./http-auth.js";
import { Settings } from "./settings.js";
import { createWebRouter } from "./web.js";
import { acquireLock } from "./lock.js";
import { createMcpServer } from "./mcp.js";
import { errorText } from "./model.js";
import { TaskStore } from "./task-storage.js";
import { Tasks } from "./tasks.js";
import { Results } from "./results.js";
import { openExecution } from "./node-execution.js";
import { createCoordinator } from "./coordinator.js";

process.umask(0o077);
const args = process.argv.slice(2);
if (args[0] !== "--config" || (args.length !== 2 && !(args.length === 4 && args[2] === "--environment"))) {
  console.error("Usage: node dist/main.js --config /absolute/path/config.json [--environment /absolute/private/path/environment.json]");
  process.exit(2);
}
const configPath = resolve(args[1]!), environmentPath = args[3] ? resolve(args[3]) : undefined;
const base = baseEnvironment(process.env);
if (environmentPath) {
  const environment = readEnvironment(environmentPath);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, base, environment);
}
const config = loadConfig(configPath);
const token = process.env[config.tokenEnv];
if (!token || token.length < 32) throw new Error(config.tokenEnv + " must contain a token of at least 32 characters");
const authorized = bearerVerifier(token), adminToken = process.env[ADMIN_TOKEN_ENV];
if (adminToken !== undefined && (!environmentPath || !/^[!-~]{32,256}$/.test(adminToken) || adminToken === token)) {
  throw new Error("Console requires --environment and a distinct administrator token of 32–256 visible ASCII characters");
}
let http: Server | undefined;
let tasks: Tasks | undefined, taskStore: TaskStore | undefined, settings: Settings | undefined;
let release: (() => Promise<void>) | undefined;
let shutting: Promise<void> | undefined;
const connections = new Set<() => Promise<void>>();
function shutdown(code: number): Promise<void> {
  process.exitCode = Math.max(process.exitCode ? Number(process.exitCode) : 0, code);
  return shutting ??= (async () => {
    settings?.close();
    try { await tasks?.close(); }
    catch (error) { console.error(errorText(error)); process.exitCode = 1; }
    for (const close of connections) await close().catch(() => {});
    if (http) { http.closeAllConnections(); await new Promise<void>(done => http!.close(() => done())); }
    taskStore?.close();
    await release?.();
  })().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
}
const fatal = (error: unknown) => { console.error(errorText(error)); void shutdown(1); };
try {
  release = await acquireLock(config.dataDir);
  taskStore = new TaskStore(config.dataDir);
  tasks = new Tasks(taskStore, config.executors, new Results(config.dataDir), openExecution,
    config.coordinator ? createCoordinator(config.dataDir, config.coordinator) : undefined, fatal);
  const app = express();
  app.disable("x-powered-by"); app.disable("etag");
  app.use((_req, res, next) => {
    if (shutting) { res.status(503).end(); return; }
    next();
  });
  if (adminToken && environmentPath) {
    settings = new Settings(configPath, environmentPath, config, base, process.env);
    app.use("/admin", createWebRouter(tasks, settings, adminToken, fatal));
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
  tasks.start();
  const address = http.address();
  const origin = "http://127.0.0.1:" + (typeof address === "object" && address ? address.port : config.port);
  console.log(JSON.stringify({ event: "ready", url: origin + "/mcp", consoleUrl: settings ? origin + "/admin/" : null }));
  process.once("SIGINT", () => { void shutdown(0); });
  process.once("SIGTERM", () => { void shutdown(0); });
} catch (error) { fatal(error); }
