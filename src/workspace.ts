import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

/** Path validity only; native executor policy owns directory and tool access. */
export function resolveWorkspace(path: string): string {
  if (!path || path.includes("\0") || !isAbsolute(path)) throw new Error("Workspace must be an absolute directory path");
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error("Workspace must be an existing directory");
  return canonical;
}

export function checkWorkspace(path: string): void {
  if (resolveWorkspace(path) !== path) throw new Error("Workspace path changed since admission");
}
