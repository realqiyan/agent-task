// Real ACP initialization only: no session/new, prompt, login, or model request.
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { loadConfig, startupPaths } from "../dist/configuration/files.js";
import { executorEnvironment } from "../dist/executors/environment.js";
import { executorLaunch } from "../dist/integrations/acp/runtime.js";
import { LocalExecutors } from "../dist/integrations/acp/discovery.js";
import { readEnvironment } from "../dist/configuration/files.js";
import { join } from "node:path";
import { terminateGroup } from "../dist/integrations/acp/connection.js";
import { version } from "../dist/infrastructure/version.js";
const [home, id] = process.argv.slice(2);
if (!home || !id) { console.error("Usage: node scripts/probe-agent.mjs <installation-home> <pi|codex|claude|opencode>"); process.exit(2); }
const config = loadConfig(startupPaths(home).configPath);
const env = executorEnvironment(process.env, readEnvironment(join(config.dataDir, "environment.json")), config);
const executor = new LocalExecutors(join(home, "adapters"), env).discover().executors.find(value => value.id === id);
if (!executor || config.disabledExecutors.includes(executor.type)) throw new Error("Executor unavailable; connect MCP to prepare its adapter first");
const launch = executorLaunch(executor, env);
const child = spawn(launch.command, launch.args, {
  cwd: process.cwd(), env: launch.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.resume();
let connection;
const closed = new Promise(resolve => child.once("close", resolve));
child.once("error", error => { console.error("ACP executable could not start"); connection?.close(error); });
const timer = setTimeout(() => {
  connection?.close(new Error("ACP initialization timed out"));
  void terminateGroup(child);
}, 10000);
try {
  connection = await acp.client({ name: "agent-task-probe" }).connect(acp.ndJsonStream(
    Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: 1048576 }));
  const result = await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {},
    clientInfo: { name: "agent-task-probe", version },
  });
  if (result.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error("Incompatible ACP protocol version");
  console.log(JSON.stringify(result, null, 2));
} catch { console.error("ACP initialize failed; inspect native configuration in a private terminal. No task was sent."); process.exitCode = 1; }
finally { clearTimeout(timer); connection?.close(); await terminateGroup(child); await closed; }
