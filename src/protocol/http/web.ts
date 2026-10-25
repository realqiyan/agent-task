import express from "express";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { bearerVerifier } from "./auth.js";
import { SettingsError } from "../../configuration/settings.js";
import type { Settings } from "../../configuration/settings.js";
import { previewSettings } from "../../configuration/management.js";
import { StorageError, TaskError } from "../../shared/errors.js";
import type { TaskApi } from "../services.js";
import { parseSettings, settingsConfigSchema, settingsChangeSchema, credentialUpdateSchema,
  executorRefreshSchema, executorUpgradeSchema, executorRegisterSchema, executorUnregisterSchema } from "../settings-contract.js";
import { taskIdSchema, taskListSchema, taskRunListSchema, taskUpdateSchema } from "../task-contract.js";

type ConsoleTasks = Pick<TaskApi, "definitions" | "runs" | "supervisor" | "executors">;
function query<T>(schema: z.ZodType<T>, request: express.Request): T {
  const value = { ...request.query };
  for (const key of ["after", "limit"]) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !/^\d+$/.test(value[key])) throw new Error("Invalid pagination");
    // Protocol adaptation only; the shared contract owns range checks.
    (value as Record<string, unknown>)[key] = Number(value[key]);
  }
  return schema.parse(value);
}
export function createWebRouter(tasks: ConsoleTasks, settings: Settings, token: string, fatal: (error: unknown) => void, restart: () => Promise<unknown>, instanceId: string): express.Router {
  const router = express.Router(), authorized = bearerVerifier(token);
  router.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "X-Frame-Options": "DENY",
    });
    const origin = new URL("http://127.0.0.1:" + req.socket.localPort).origin;
    if (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin)) {
      res.status(403).end(); return;
    }
    next();
  });
  // Mount authentication with the same router matching rules as the API, including case variants.
  router.use("/api", (req, res, next) => {
    const origin = new URL("http://127.0.0.1:" + req.socket.localPort).origin;
    if (req.headers["sec-fetch-site"] !== undefined && req.headers["sec-fetch-site"] !== "same-origin") { res.status(403).end(); return; }
    if (!authorized(req.headers.authorization)) { res.status(401).set("WWW-Authenticate", "Bearer").end(); return; }
    if (req.method !== "GET" && (req.method !== "POST" || req.headers.origin !== origin)) { res.status(403).end(); return; }
    if (req.method === "POST" && !req.is("application/json")) { res.status(415).end(); return; }
    next();
  });
  const assets = new Map(["index.html", "app.js", "api.js", "dom.js", "tasks-view.js", "settings-view.js", "style.css"]
    .map(name => [name === "index.html" ? "/" : "/" + name, fileURLToPath(new URL("../../web/" + name, import.meta.url))]));
  router.get(["/", ...[...assets.keys()].filter(path => path !== "/")], (req, res) => {
    res.sendFile(assets.get(req.path)!, { lastModified: false, cacheControl: false, acceptRanges: false },
      error => { if (error && !res.headersSent) res.status(404).end(); });
  });
  router.use("/api", express.json({ limit: "512kb" }));
  const respond = (execute: (req: express.Request) => unknown): express.RequestHandler => (req, res) => {
    try { res.json({ data: execute(req) }); }
    catch (error) {
      if (error instanceof StorageError) { fatal(error); res.status(503).json({ error: "Service storage unavailable" }); }
      else if (error instanceof SettingsError) {
        res.status({ invalid: 400, conflict: 409, unavailable: 503 }[error.code]).json({ error: error.message });
      } else if (error instanceof TaskError) {
        res.status({ validation: 400, not_found: 404, conflict: 409, precondition: 409, unavailable: 503, internal: 500 }[error.code])
          .json({ error: error.message });
      } else res.status(400).json({ error: "Request rejected; check inputs and refresh the current state" });
    }
  };
  router.get("/api/status", respond(() => ({ ...tasks.supervisor.status(), settings: settings.status(), instanceId })));
  router.get("/api/tasks", respond(req => {
    const input = query(taskListSchema, req), page = tasks.definitions.list(input.after, input.limit);
    return { ...page, items: page.items.map(task => ({ id: task.id, name: task.input.name, status: task.status, nextAt: task.nextAt, schedule: task.input.schedule })) };
  }));
  router.get("/api/tasks/:id", respond(req => tasks.definitions.get(taskIdSchema.parse(req.params).id)));
  router.get("/api/runs", respond(req => {
    const input = query(taskRunListSchema, req), page = tasks.runs.list(input.taskId, input.after, input.limit);
    return { ...page, items: page.items.map(run => ({ id: run.id, taskId: run.taskId, status: run.status,
      createdAt: run.createdAt, finishedAt: run.finishedAt, error: run.error,
      accepted: run.nodes.filter(node => node.status === "succeeded").length, total: run.nodes.length })) };
  }));
  router.get("/api/runs/:id", respond(req => tasks.runs.get(taskIdSchema.parse(req.params).id)));
  router.post("/api/task-update", respond(req => tasks.definitions.update(taskUpdateSchema.parse(req.body))));
  router.get("/api/executors", respond(() => tasks.executors.list()));
  router.post("/api/executors/refresh", respond(req => {
    parseSettings(executorRefreshSchema, req.body);
    return tasks.executors.refresh();
  }));
  router.post("/api/executors/upgrade", respond(req => tasks.executors.upgrade(parseSettings(executorUpgradeSchema, req.body).id)));
  router.post("/api/executors/register", respond(req => tasks.executors.register(parseSettings(executorRegisterSchema, req.body))));
  router.post("/api/executors/unregister", respond(req => tasks.executors.unregister(parseSettings(executorUnregisterSchema, req.body).id)));
  router.get("/api/settings", respond(() => settings.get()));
  router.get("/api/settings/diff", respond(() => settings.diff()));
  router.post("/api/settings/prepare", respond(req => settings.prepareChange(parseSettings(settingsChangeSchema, req.body))));
  router.post("/api/settings/validate", respond(req => previewSettings(settings, tasks.definitions, parseSettings(settingsConfigSchema, req.body))));
  router.post("/api/settings/config", respond(req => settings.saveConfig(parseSettings(settingsConfigSchema, req.body))));
  router.post("/api/settings/credential", respond(req => settings.saveCredential(parseSettings(credentialUpdateSchema, req.body))));
  router.post("/api/restart", async (req, res) => {
    if (!req.body || Array.isArray(req.body) || typeof req.body !== "object" || Object.keys(req.body).length) { res.status(400).json({ error: "Expected an empty request" }); return; }
    try { res.json({ data: await restart() }); }
    catch { res.status(503).json({ error: "Restart could not be confirmed; inspect private logs and use CLI status before retrying" }); }
  });
  router.use((_req, res) => { res.status(404).end(); });
  router.use(((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status === 413 ? 413 : error.status === 415 ? 415 : 400).json({ error: "Invalid request body" });
  }) satisfies express.ErrorRequestHandler);
  return router;
}
