import { request } from "node:http";
import { join } from "node:path";
import { startupPaths } from "../../configuration/files.js";

export type Ready = { instanceId: string; url: string; consoleUrl: string | null; pid: number };

/** Local administrator capability: the socket lives in the private launcher directory. */
export function controlService(home: string, action: "status" | "restart"): Promise<Ready> {
  startupPaths(home);
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const req = request({ socketPath: join(home, "control.sock"), path: "/" + action, method: "POST" }, res => {
      let body = "";
      res.setEncoding("utf8"); res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) { reject(new Error("Service unavailable; inspect private logs and startup files")); return; }
        try { resolve(JSON.parse(body) as Ready); } catch { reject(new Error("Invalid launcher response")); }
      });
    });
    req.setTimeout(60_000, () => { timedOut = true; req.destroy(); });
    req.once("error", () => reject(new Error(timedOut
      ? "Service control timed out; outcome is unknown, check status before another restart"
      : "Cannot contact launcher; start the foreground or managed service first")));
    req.end();
  });
}
