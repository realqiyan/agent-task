import { ADMIN_TOKEN_ENV, coordinatorCredentialEnv } from "../configuration/policy.js";
import type { Config, Environment } from "../configuration/model.js";

/** Private service inputs never enter workers, even through an alias with the same value. */
export function executorEnvironment(native: Environment, privateValues: Environment, config: Config): Environment {
  const blocked = new Set([...Object.keys(privateValues), config.tokenEnv, ADMIN_TOKEN_ENV,
    ...(config.coordinator ? [coordinatorCredentialEnv(config.coordinator)] : [])]);
  const secrets = new Set([...Object.values(privateValues), ...[...blocked].map(key => native[key])].filter(Boolean));
  return Object.fromEntries(Object.entries(native).filter(([key, value]) =>
    value !== undefined && !blocked.has(key) && !secrets.has(value) &&
    !/^(AGENT_TASK_|NODE_|LD_|DYLD_)/.test(key) && key !== "PI_ACP_PI_COMMAND"));
}
