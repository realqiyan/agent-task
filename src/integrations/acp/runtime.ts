import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { checkWorkspace } from "../../infrastructure/workspace.js";
import type { Executor } from "../../executors/model.js";

export function checkExecutable(path: string): void {
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path) || realpathSync(path) !== path || !statSync(path).isFile()) {
    throw new Error("Expected a canonical executable path");
  }
  accessSync(path, constants.X_OK);
}

/** Startup directory validity, not a workspace override or access grant. */
export function checkLaunchDirectory(path: string): void {
  checkWorkspace(path);
  accessSync(path, constants.X_OK);
}

/** Resolve native executables without a shell or service-managed dependencies. */
export function findExecutable(name: string, environment: NodeJS.ProcessEnv, excludedRoot?: string): string | null {
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    try {
      const path = realpathSync(join(directory, name));
      if (excludedRoot && (path === excludedRoot || path.startsWith(excludedRoot + "/"))) continue;
      checkExecutable(path);
      return path;
    } catch { /* Try the next native PATH entry. */ }
  }
  return null;
}

/** A stored launch binds the adapter to the native executable discovered for this Task. */
export function executorLaunch(executor: Executor, environment: NodeJS.ProcessEnv) {
  checkExecutable(executor.nativePath);
  checkExecutable(executor.command);
  if (executor.type !== "custom" && executor.cwd !== undefined) throw new Error("Only custom executors may set a startup directory");
  if (executor.type === "custom") {
    if (executor.cwd !== undefined) checkLaunchDirectory(executor.cwd);
    if (executor.command !== executor.nativePath || executor.adapterVersion !== null || executor.args.some(arg => arg.includes("\0"))) {
      throw new Error("Invalid custom ACP launch");
    }
  } else if (executor.type === "opencode"
    ? executor.command !== executor.nativePath || executor.args.length !== 1 || executor.args[0] !== "acp"
    : executor.args.length !== 0) throw new Error("Invalid ACP launch arguments");
  const env = { ...environment };
  delete env.PI_ACP_PI_COMMAND;
  delete env.CODEX_PATH;
  delete env.CLAUDE_CODE_EXECUTABLE;
  if (executor.type === "pi") env.PI_ACP_PI_COMMAND = executor.nativePath;
  if (executor.type === "codex") env.CODEX_PATH = executor.nativePath;
  if (executor.type === "claude") env.CLAUDE_CODE_EXECUTABLE = executor.nativePath;
  return { command: executor.command, args: [...executor.args], cwd: executor.cwd, env };
}
