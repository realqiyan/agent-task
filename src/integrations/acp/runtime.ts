import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Executor } from "../../executors/model.js";

const commands = {
  pi: { command: "pi-acp", args: [] },
  codex: { command: "codex-acp", args: [] },
  claude: { command: "claude-agent-acp", args: [] },
  opencode: { command: "opencode", args: ["acp"] },
} as const;

/** Fixed ACP adapters, resolved in the OS user's native PATH. Never a shell command. */
export function executorCommand(type: Executor["type"], environment: NodeJS.ProcessEnv) {
  const find = (name: string): string => {
    for (const directory of (environment.PATH ?? "").split(delimiter).filter(isAbsolute)) {
      try {
        const path = realpathSync(join(directory, name));
        accessSync(path, constants.X_OK);
        if (statSync(path).isFile()) return path;
      } catch { /* Try the next native PATH entry. */ }
    }
    throw new Error("Missing ACP dependency on native PATH: " + name);
  };
  const entry = commands[type];
  if (type === "pi") find("pi");
  return { command: find(entry.command), args: [...entry.args] };
}
