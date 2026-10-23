import { request } from "node:http";
import { join } from "node:path";
import { startupPaths } from "../../configuration/files.js";

export type Ready = { instanceId: string; url: string; consoleUrl: string | null; pid: number };
export type Stopped = { stopped: true };

export class ControlError extends Error {
  constructor(readonly kind: "unreachable" | "unavailable" | "timeout" | "invalid", message: string) { super(message); }
}

/** Local administrator capability: the socket lives in the private launcher directory. */
export function controlService(home: string, action: "status" | "restart", timeout?: number): Promise<Ready>;
export function controlService(home: string, action: "stop", timeout?: number): Promise<Stopped>;
export function controlService(home: string, action: "status" | "restart" | "stop", timeout = 60_000): Promise<Ready | Stopped> {
  startupPaths(home);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const req = request({ socketPath: join(home, "control.sock"), path: "/" + action, method: "POST", agent: false }, res => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", chunk => {
        body += chunk;
        if (body.length > 16_384) {
          reject(new ControlError("invalid", "Invalid launcher response")); req.destroy();
        }
      });
      res.on("end", () => {
        if (res.statusCode !== 200) { reject(new ControlError("unavailable", "Service unavailable; inspect private logs and startup files")); return; }
        try {
          const value = JSON.parse(body) as Partial<Ready & Stopped>;
          if (action === "stop") {
            if (value.stopped !== true) throw new Error();
            resolve({ stopped: true });
          } else {
            if (typeof value.instanceId !== "string" || typeof value.url !== "string" || !Number.isInteger(value.pid) ||
              !(value.consoleUrl === null || typeof value.consoleUrl === "string")) throw new Error();
            resolve(value as Ready);
          }
        } catch { reject(new ControlError("invalid", "Invalid launcher response")); }
      });
      res.once("error", () => reject(new ControlError("unavailable", "Launcher response interrupted; check status before another action")));
    });
    req.setTimeout(timeout, () => { timedOut = true; req.destroy(); });
    req.once("error", (error: NodeJS.ErrnoException) => reject(new ControlError(timedOut ? "timeout"
      : ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "") ? "unreachable" : "unavailable", timedOut
      ? "Service control timed out; check status before another action"
      : "Cannot contact launcher; use agent-task mcp or start the service")));
    req.end();
  });
}
