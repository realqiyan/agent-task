import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Executor } from "./model.js";
import { ADMIN_TOKEN_ENV, coordinatorCredentialEnv } from "./config.js";
import type { Config } from "./config.js";

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

/** Private service inputs never enter workers, even through an alias with the same value. */
export function executorEnvironment(native: NodeJS.ProcessEnv, privateValues: NodeJS.ProcessEnv, config: Config): NodeJS.ProcessEnv {
  const blocked = new Set([...Object.keys(privateValues), config.tokenEnv, ADMIN_TOKEN_ENV,
    ...(config.coordinator ? [coordinatorCredentialEnv(config.coordinator)] : [])]);
  const secrets = new Set([...Object.values(privateValues), ...[...blocked].map(key => native[key])].filter(Boolean));
  return Object.fromEntries(Object.entries(native).filter(([key, value]) =>
    value !== undefined && !blocked.has(key) && !secrets.has(value) &&
    !/^(AGENT_TASK_|NODE_|LD_|DYLD_)/.test(key) && key !== "PI_ACP_PI_COMMAND"));
}
