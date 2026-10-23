import express from "express";
import type { Server } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Settings } from "../../configuration/settings.js";
import type { TaskApi } from "../services.js";
import { createMcpServer } from "../mcp.js";
import { bearerVerifier } from "./auth.js";
import { createWebRouter } from "./web.js";

type HttpOptions = { tasks: TaskApi; settings?: Settings; token: string; adminToken?: string;
  fatal(error: unknown): void; restart(): Promise<unknown>; instanceId: string };

/** Owns the listener and request-scoped MCP transports. Disconnecting a request never cancels a task. */
export class HttpServer {
  private readonly app = express();
  private readonly connections = new Set<() => Promise<void>>();
  private listener?: Server;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private accepting = true;
  constructor(options: HttpOptions) {
    const authorized = bearerVerifier(options.token);
    const app = this.app;
    app.disable("x-powered-by"); app.disable("etag");
    app.use((_req, res, next) => {
      if (!this.accepting) { res.status(503).end(); return; }
      next();
    });
    if (options.settings && options.adminToken) {
      app.use("/admin", createWebRouter(options.tasks, options.settings, options.adminToken, options.fatal, options.restart, options.instanceId));
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
      if (req.body?.method === "initialize") {
        const discovered = options.tasks.executors.refresh();
        if (!discovered.executors.some(executor => executor.nativePath !== null)) {
          res.json({ jsonrpc: "2.0", id: req.body.id ?? null, error: { code: -32000,
            message: "No local executor CLI found. Install and configure at least one of pi, codex, claude or opencode, then reconnect. Management remains available." } });
          return;
        }
      }
      const server = createMcpServer(options.tasks, options.fatal);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      let closed: Promise<void> | undefined;
      const close = () => closed ??= (async () => {
        try { await transport.close(); } finally { try { await server.close(); } finally { this.connections.delete(close); } }
      })();
      this.connections.add(close);
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
  }
  async listen(port: number): Promise<string> {
    if (this.closing || this.listener) throw new Error("HTTP server closed or already listening");
    const server = this.app.listen(port, "127.0.0.1");
    this.listener = server;
    this.opening = new Promise<void>((done, reject) => {
      server.once("listening", done); server.once("error", reject);
    });
    await this.opening;
    if (this.closing) {
      await this.closing; throw new Error("Startup stopped");
    }
    const address = this.listener.address();
    return "http://127.0.0.1:" + (typeof address === "object" && address ? address.port : port);
  }
  stopAccepting(): void { this.accepting = false; }
  closeConnections(): void { this.listener?.closeAllConnections(); }
  close(drain = false): Promise<void> {
    this.stopAccepting();
    return this.closing ??= (async () => {
      await this.opening?.catch(() => {});
      await Promise.allSettled([...this.connections].map(close => close()));
      if (this.listener) {
        if (drain) this.listener.close(); // Keep the authenticated restart response alive.
        else {
          this.listener.closeAllConnections();
          await new Promise<void>(done => this.listener!.close(() => done()));
        }
      }
    })();
  }
}
