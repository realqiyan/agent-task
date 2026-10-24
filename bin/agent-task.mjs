#!/usr/bin/env node
import { readFileSync } from "node:fs";

const help = `Usage: agent-task <command>
  setup [options]           Interactive configuration (setup --help for flags)
  mcp [--home PATH]          MCP stdio connection; start or reuse the shared background service
  start [--home PATH]        Foreground service using the private installation
  stop [--home PATH]         Stop the shared service
  restart [--home PATH]      Restart runtime; verify readiness
  status [--home PATH]       Health, active work and pending configuration
  config                    Show, edit, validate and apply configuration
  executor                  Discover executors, upgrade adapters and configure enable/disable
  coordinator               Configure the coordination model
  credential                List, replace or delete private credentials
  task                      Inspect tasks and control future triggers
  run                       Inspect run history and deliveries
  <command> --help           Command usage; management supports --json
  --version | --help
Node.js 22.19+; Linux or macOS.`;
try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error("Node.js 22.19+ is required");
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    console.log(help);
  } else if (command === "--version") {
    console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  } else if (command === "setup") {
    process.argv = [process.execPath, command, ...args];
    await import(`../scripts/${command}.mjs`);
  } else {
    const lib = await import("../scripts/install-lib.mjs");
    if (["start", "mcp", "stop"].includes(command)) {
      if (args.includes("--help")) { console.log("Usage: agent-task " + command + " [--home ABSOLUTE_DIR]" + (command === "stop" ? " [--json]" : "")); }
      else {
        const json = command === "stop" && args.includes("--json");
        if (args.filter(arg => arg === "--json").length > 1) throw new Error("Repeated option: --json");
        const options = lib.argumentsFor(json ? args.filter(arg => arg !== "--json") : args);
        if (Object.keys(options).some(key => key !== "home")) throw new Error("Only --home is accepted here");
        const root = lib.installRoot(options);
        if (command === "mcp") {
          const { runMcp } = await import("../dist/application/mcp-entry.js");
          await runMcp(root);
        } else if (command === "stop") {
          const { controlService } = await import("../dist/integrations/local-service/control.js");
          console.log(JSON.stringify({ event: "stopped", ...await controlService(root, "stop") }, null, json ? undefined : 2));
        } else {
          process.argv = [process.execPath, "service-runner", root];
          await import("../scripts/service-runner.mjs");
        }
      }
    } else {
      const { runCli } = await import("../dist/protocol/cli/commands.js");
      await runCli(command, args, home => lib.installRoot({ home }));
    }
  }
} catch (error) {
  const message = process.argv[2] === "mcp"
    ? error.message + "\nFor installation, setup or connection troubleshooting, use using-agent-task: Pi /skill:using-agent-task; Claude Code /agent-task:using-agent-task; Codex $using-agent-task. Do not reinstall or replay work without checking the cause."
    : error.message;
  console.error(process.argv.includes("--json") ? JSON.stringify({ error: message }) : message);
  process.exitCode = 1;
}
