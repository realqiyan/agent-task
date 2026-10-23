import { controlService } from "../../integrations/local-service/control.js";
import { startupPaths } from "../../configuration/files.js";
import { readEnvironment } from "../../configuration/files.js";
import { ADMIN_TOKEN_ENV } from "../../configuration/policy.js";

/** Local CLI transport. Credentials never enter arguments, URLs or diagnostics. */
export async function connectAdmin(home: string) {
  const ready = await controlService(home, "status");
  if (!ready.consoleUrl) throw new Error("Administrator API is disabled; configure an administrator token while stopped");
  const url = new URL(ready.consoleUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("Invalid local administrator address");
  }
  const token = readEnvironment(startupPaths(home).environmentPath)[ADMIN_TOKEN_ENV];
  if (!token) throw new Error("Administrator credential is unavailable");
  return {
    ready,
    async request<T>(path: string, input?: unknown): Promise<T> {
      let response: Response;
      try {
        response = await fetch(url.origin + "/admin/api" + path, {
          method: input === undefined ? "GET" : "POST", redirect: "error",
          headers: { Authorization: "Bearer " + token,
            ...(input === undefined ? {} : { Origin: url.origin, "Content-Type": "application/json" }) },
          body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(60_000),
        });
      } catch {
        throw new Error("Administrator request could not be confirmed; inspect current state before retrying. No offline write was attempted");
      }
      let body: { data?: T; error?: string };
      try { body = await response.json() as typeof body; }
      catch { throw new Error("Invalid administrator response"); }
      if (!response.ok) throw new Error(body.error ?? "Administrator request rejected (HTTP " + response.status + ")");
      return body.data as T;
    },
  };
}
