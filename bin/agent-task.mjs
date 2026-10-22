#!/usr/bin/env node
import { readFileSync } from "node:fs";

const help = `Usage: agent-task <command>
  setup [options]           Interactive configuration (setup --help for flags)
  start [--home PATH]        Foreground service using the private installation
  restart [--home PATH]      Restart foreground or managed runtime; verify readiness
  status [--home PATH]       Authenticated MCP health check; no token printed
  service install [--home PATH]
                            Install/start systemd user service or LaunchAgent
  service remove [--home PATH]
                            Stop/remove only the owned service
  uninstall [--home PATH]    Remove service and owned executor components;
                            preserve configuration, credentials and task data
  --version | --help
Node.js 22.19+; Linux or macOS. Setup never grants executor permissions.`;
try {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error("Node.js 22.19+ is required");
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    console.log(help);
  } else if (command === "--version") {
    console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  } else if (command === "setup" || command === "uninstall") {
    process.argv = [process.execPath, command, ...args];
    await import(`../scripts/${command}.mjs`);
  } else {
    const lib = await import("../scripts/install-lib.mjs");
    const action = command === "service" ? args.shift() : undefined;
    if (!["start", "status", "restart", "service"].includes(command) || (command === "service" && !["install", "remove"].includes(action))) throw new Error(help);
    const options = lib.argumentsFor(args);
    if (Object.keys(options).some(key => key !== "home")) throw new Error("Only --home is accepted here");
    const root = lib.installRoot(options);
    if (action === "install") {
      process.argv = [process.execPath, "setup", "--home", root, "--service"];
      await import("../scripts/setup.mjs");
    } else if (action === "remove") {
      lib.readManifest(root);
      const unlock = lib.operationLock(root);
      try {
        const manifest = lib.readManifest(root);
        await lib.deactivate(manifest);
        manifest.serviceInstalled = false;
        lib.saveManifest(root, manifest);
        console.log("Owned service removed; configuration, credentials, components and data preserved.");
      } finally { unlock(); }
    } else if (command === "start") {
      if (lib.readManifest(root).serviceInstalled) throw new Error("Remove the managed service before starting a foreground instance");
      process.argv = [process.execPath, "service-runner", root];
      await import("../scripts/service-runner.mjs");
    } else {
      const { controlService } = await import("../dist/launcher.js");
      const ready = await controlService(root, command);
      console.log(JSON.stringify({ event: command === "restart" ? "restarted" : "healthy", ...ready }));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
