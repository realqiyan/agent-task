#!/usr/bin/env node
import { readFileSync } from "node:fs";

const help = `Usage: agent-task <command>
  setup [options]           Interactive configuration (setup --help for flags)
  start [--home PATH]        Foreground service using the private installation
  restart [--home PATH]      Restart runtime; verify readiness
  status [--home PATH]       Health, active work and pending configuration
  config                    Show, edit, validate and apply configuration
  executor                  Manage registrations and unattended authorization
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
    if (command === "start") {
      if (args.includes("--help")) { console.log("Usage: agent-task start [--home ABSOLUTE_DIR]"); }
      else {
        const options = lib.argumentsFor(args);
        if (Object.keys(options).some(key => key !== "home")) throw new Error("Only --home is accepted here");
        const root = lib.installRoot(options);
        process.argv = [process.execPath, "service-runner", root];
        await import("../scripts/service-runner.mjs");
      }
    } else {
      const { runCli } = await import("../dist/protocol/cli/commands.js");
      await runCli(command, args, home => lib.installRoot({ home }));
    }
  }
} catch (error) {
  console.error(process.argv.includes("--json") ? JSON.stringify({ error: error.message }) : error.message);
  process.exitCode = 1;
}
