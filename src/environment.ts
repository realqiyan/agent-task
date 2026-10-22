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
/** Explicit file mode never falls back to inherited shell credentials. */
export function baseEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(["HOME", "PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"]
    .filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
