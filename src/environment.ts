import { ADMIN_TOKEN_ENV, coordinatorCredentialEnv } from "./config.js";
import type { Config } from "./config.js";
import { readPrivateText } from "./private-files.js";

export function parseEnvironment(text: string): Record<string, string> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid environment file JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.entries(value).some(([key, item]) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key) ||
    typeof item !== "string" || item.includes("\0"))) throw new Error("Invalid environment file");
  return value as Record<string, string>;
}
export function readEnvironment(path: string): Record<string, string> {
  return parseEnvironment(readPrivateText(path));
}
/** Credential names and values must stay separate, including historical token aliases. */
export function validateServiceEnvironment(config: Config, environment: NodeJS.ProcessEnv) {
  const token = environment[config.tokenEnv], adminToken = environment[ADMIN_TOKEN_ENV];
  if (!token || !/^[!-~]{32,256}$/.test(token)) throw new Error("A private service token of 32–256 visible ASCII characters is required");
  if (adminToken !== undefined && (!/^[!-~]{32,256}$/.test(adminToken) || adminToken === token)) throw new Error("Invalid or reused administrator token");
  const credential = config.coordinator ? environment[coordinatorCredentialEnv(config.coordinator)] : undefined;
  if (credential && (credential === token || credential === adminToken)) throw new Error("Model credentials must be distinct from service and administrator tokens");
  return { token, adminToken };
}
/** Explicit file mode never falls back to inherited shell credentials. */
export function baseEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(["HOME", "PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"]
    .filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
