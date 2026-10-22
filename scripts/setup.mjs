#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { argumentsFor, installRoot, packages, createFile, json, run, operationLock, readManifest, saveManifest,
  runtimeBaseEnv, activate, inventory, verifyServiceFile, packageRoot, checkHealth } from "./install-lib.mjs";
import { setupWizard } from "./setup-wizard.mjs";
import { startupPaths } from "../dist/startup.js";
import { readEnvironment } from "../dist/environment.js";
import { executorCommand, executorEnvironment } from "../dist/executor-runtime.js";
import { acquireLauncherLock } from "../dist/lock.js";

process.umask(0o077);
let unlock;
try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: agent-task setup [--home ABSOLUTE_PRIVATE_DIR]\nInteractive on a terminal for a new installation. Noninteractive: --executors pi,codex,claude,opencode|none --cwd ABSOLUTE_DIR [--provider openai|anthropic|deepseek --model ID] [--port 8765]\nDefault: --prepare-only (no background service). --service explicitly installs/starts the background service.\nExisting installation: --check [--probe] | --resume. No credentials accepted on the command line. Existing configuration is never replaced.");
    process.exit(0);
  }
  if (options.service && (options["prepare-only"] || options.check)) throw new Error("--service cannot be combined with --prepare-only or --check");
  if (options.probe && !options.check) throw new Error("--probe requires --check");
  const root = installRoot(options), manifestPath = join(root, "installation.json");
  if (!existsSync(manifestPath) && !options.check && !options.resume && (!options.executors || !options.cwd)) await setupWizard(options, root);
  if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root || lstatSync(root).uid !== process.getuid() || (lstatSync(root).mode & 0o077)) throw new Error("Installation home must be canonical, owned and private");
  unlock = operationLock(root);
  let manifest;
  if (existsSync(manifestPath)) {
    manifest = readManifest(root);
    if (["executors", "cwd", "provider", "model", "port"].some(key => options[key] !== undefined)) throw new Error("Installation already exists; initialization options cannot replace existing configuration");
    if (manifest.phase !== "ready" && !options.resume) throw new Error("Incomplete or uninstalled components; use --resume explicitly (configuration will be preserved)");
  } else {
    if (options.check || options.probe || options.resume) throw new Error("No installation to check/resume");
    if (!options.executors || !options.cwd) throw new Error("Select --executors pi,codex,claude,opencode|none and --cwd ABSOLUTE_DIR");
    const selected = options.executors === "none" ? [] : options.executors.split(",");
    if (selected.some(id => !Object.hasOwn(packages, id)) || new Set(selected).size !== selected.length) throw new Error("Invalid executor selection");
    if (!options.cwd.startsWith("/") || !lstatSync(realpathSync(options.cwd)).isDirectory()) throw new Error("cwd must be an existing absolute directory");
    const cwd = realpathSync(options.cwd);
    if ([root, packageRoot].some(path => cwd === path || cwd.startsWith(path + "/"))) throw new Error("Workspace must be outside the installation home and npm package");
    if (Boolean(options.provider) !== Boolean(options.model) || (options.provider && !["openai", "anthropic", "deepseek"].includes(options.provider))) throw new Error("Specify a supported --provider together with --model");
    const port = Number(options.port ?? 8765);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
    // Reject unowned artifacts. This script never adopts or clears an existing installation.
    for (const name of ["components", "launch.json", "data"]) {
      if (existsSync(join(root, name))) throw new Error("Existing unowned installation artifact: " + name);
    }
    manifest = { project: "agent-task", root, home: homedir(), platform: process.platform, node: process.execPath, app: packageRoot,
      selected, cwd, port, coordinator: options.provider ? { provider: options.provider, model: options.model } : undefined,
      phase: "installing", serviceInstalled: false, files: [] };
    createFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  verifyServiceFile(manifest);
  const app = manifest.app, components = join(root, "components");
  if (!existsSync(join(app, "dist/main.js"))) throw new Error("Prebuilt runtime is missing; reinstall the npm package (source contributors: npm run build)");
  if (manifest.phase !== "ready") {
    if (manifest.serviceInstalled) throw new Error("Stop/uninstall the existing service before rebuilding components");
    for (const name of ["components"]) {
      if (!existsSync(join(root, name))) continue;
      const known = new Set(manifest.files);
      if (inventory(root, name).some(file => !known.has(file))) throw new Error("Uninventoried component files exist; refusing to overwrite them during resume");
    }
    try {
      console.log("Using the prebuilt npm runtime. No source checkout or compilation required.");
      mkdirSync(components, { recursive: true, mode: 0o700 });
      if (!existsSync(join(components, "package.json"))) createFile(join(components, "package.json"), JSON.stringify({ private: true }));
      const dependencies = manifest.selected.flatMap(id => packages[id]);
      if (dependencies.length) {
        console.log("Installing selected ACP executors into private components (not global executables).");
        const installArgs = existsSync(join(components, "package-lock.json"))
          ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]
          : ["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", ...dependencies];
        run("npm", installArgs, { cwd: components });
        if (manifest.selected.includes("opencode")) {
          // This pinned package requires copying its platform binary. No other lifecycle scripts run.
          run(manifest.node, [join(components, "node_modules/opencode-ai/postinstall.mjs")], { cwd: components });
        }
      }
      mkdirSync(join(root, "data/results"), { recursive: true, mode: 0o700 });
      const dataDir = join(root, "data");
      if (!existsSync(join(root, "launch.json"))) createFile(join(root, "launch.json"), JSON.stringify({ dataDir }) + "\n");
      if (!existsSync(join(dataDir, "environment.json"))) createFile(join(dataDir, "environment.json"), JSON.stringify({ AGENT_TASK_TOKEN: randomBytes(32).toString("hex"), AGENT_TASK_ADMIN_TOKEN: randomBytes(32).toString("hex") }, null, 2) + "\n");
      if (!existsSync(join(dataDir, "config.json"))) createFile(join(dataDir, "config.json"), JSON.stringify({ dataDir, port: manifest.port,
        tokenEnv: "AGENT_TASK_TOKEN", coordinator: manifest.coordinator,
        executors: manifest.selected.map(id => ({ id, type: id, note: "", cwd: manifest.cwd, unattendedApproved: false })) }, null, 2) + "\n");
      manifest.phase = "ready";
      delete manifest.port; delete manifest.cwd; delete manifest.coordinator;
    } finally {
      manifest.files = ["components"].filter(name => existsSync(join(root, name))).flatMap(name => inventory(root, name));
      saveManifest(root, manifest);
    }
  }
  const paths = startupPaths(root), env = runtimeBaseEnv(manifest);
  // Use the same native launch environment; private values are read separately, never passed to probes.
  run(manifest.node, ["--input-type=module", "-e", `import {loadConfig} from ${JSON.stringify(pathToFileURL(join(app, "dist/config.js")).href)}; loadConfig(process.argv[1]);`, paths.configPath], { env });
  const config = json(paths.configPath);
  for (const id of manifest.selected) {
    const cliEnv = executorEnvironment(env, readEnvironment(paths.environmentPath), config);
    executorCommand(id, cliEnv); // No native process is launched without an explicit --probe.
  }
  const report = { platform: process.platform, dependencies: "ready", configuration: "valid", background: "not-checked",
    coordinator: config.coordinator ? "configured; authentication not verified" : "not configured; task admission disabled",
    executors: config.executors.map(executor => ({ id: executor.id, authorized: executor.unattendedApproved,
      handshake: "not checked", execution: "not verified by setup" })) };
  if (options.probe) {
    for (const entry of report.executors) {
      try { run(manifest.node, [join(app, "scripts/probe-agent.mjs"), paths.configPath, entry.id], { env, timeout: 20000 }); entry.handshake = "passed (initialize only)"; }
      catch { entry.handshake = "failed; inspect native dependencies/configuration separately"; process.exitCode = 1; }
    }
  }
  if (options.service) {
    if (!manifest.serviceInstalled) acquireLauncherLock(root)(); // Refuse a live foreground owner.
    // Record intent before activating so a failed service start is still owned by uninstall.
    manifest.serviceInstalled = true; saveManifest(root, manifest);
    activate(manifest);
    report.background = "service manager registered";
  }
  if (manifest.serviceInstalled) {
    try {
      await checkHealth(root, 15000);
      report.background = "authenticated MCP health check passed";
    } catch { report.background = "not ready; run --check after startup and inspect the service manager"; process.exitCode = 1; }
  }
  console.log(JSON.stringify(report, null, 2));
  console.log(`Config: ${paths.configPath}\nSecrets (never printed): ${paths.environmentPath}\nInstalled ACP adapters: ${join(components, "node_modules/.bin")}. Prepare authentication with each executor\'s official native tools under the service OS user. No login is performed by setup.\nConsole: http://127.0.0.1:${config.port}/admin/ (use the separate AGENT_TASK_ADMIN_TOKEN from the private environment file; never place it in a URL). Configure coordinator credentials there or in environment.json, and audit native executor permissions before setting unattendedApproved=true. No permissions are granted by setup. Use Web restart or agent-task restart after changes.\nLinux: user service requires lingering for logout survival (administrator decision). macOS: LaunchAgent survives terminal close, not user logout; log in again to restart. Neither platform executes during sleep/shutdown.`);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { unlock?.(); }
