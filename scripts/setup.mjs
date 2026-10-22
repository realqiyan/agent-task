#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { argumentsFor, installRoot, packages, createFile, json, run, operationLock, readManifest, saveManifest,
  runtimeEnv, activate, inventory, verifyServiceFile } from "./install-lib.mjs";

process.umask(0o077);
const options = argumentsFor(process.argv.slice(2));
if (options.help) {
  console.log("Usage: node scripts/setup.mjs [--home ABSOLUTE_PRIVATE_DIR] --executors pi,codex,opencode|none --cwd ABSOLUTE_DIR [--provider openai|anthropic|deepseek --model ID] [--port 8765] [--prepare-only]\nExisting installation: --check [--probe] | --resume | no options to enable the background service. No credentials accepted on the command line. Existing configuration is never replaced.");
  process.exit(0);
}
let unlock;
try {
  const root = installRoot(options), manifestPath = join(root, "installation.json");
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
    if (!options.executors || !options.cwd) throw new Error("Select --executors pi,codex,opencode|none and --cwd ABSOLUTE_DIR");
    const selected = options.executors === "none" ? [] : options.executors.split(",");
    if (selected.some(id => !Object.hasOwn(packages, id)) || new Set(selected).size !== selected.length) throw new Error("Invalid executor selection");
    if (!options.cwd.startsWith("/") || !lstatSync(realpathSync(options.cwd)).isDirectory()) throw new Error("cwd must be an existing absolute directory");
    const cwd = realpathSync(options.cwd);
    if (cwd === root || cwd.startsWith(root + "/")) throw new Error("Workspace must be outside the installation home");
    if (Boolean(options.provider) !== Boolean(options.model) || (options.provider && !["openai", "anthropic", "deepseek"].includes(options.provider))) throw new Error("Specify a supported --provider together with --model");
    const port = Number(options.port ?? 8765);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
    // Reject unowned artifacts. This script never adopts or clears an existing installation.
    for (const name of ["app", "components", "config.json", "environment.json", "data"]) {
      if (existsSync(join(root, name))) throw new Error("Existing unowned installation artifact: " + name);
    }
    manifest = { project: "agent-task", root, home: homedir(), platform: process.platform, node: process.execPath,
      selected, cwd, port, coordinator: options.provider ? { provider: options.provider, model: options.model } : undefined,
      phase: "installing", serviceInstalled: false, files: [] };
    createFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }
  verifyServiceFile(manifest);
  const app = join(root, "app"), components = join(root, "components");
  if (manifest.phase !== "ready") {
    if (manifest.serviceInstalled) throw new Error("Stop/uninstall the existing service before rebuilding components");
    for (const name of ["app", "components"]) {
      if (!existsSync(join(root, name))) continue;
      const known = new Set(manifest.files);
      if (inventory(root, name).some(file => !known.has(file))) throw new Error("Uninventoried component files exist; refusing to overwrite them during resume");
    }
    const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    if (source === app) throw new Error("Resume from a separate source checkout");
    try {
      console.log("Installing project dependencies and compiling (no lifecycle scripts).");
      mkdirSync(app, { recursive: true, mode: 0o700 });
      for (const name of ["package.json", "package-lock.json", "tsconfig.json", "src", "scripts"]) cpSync(join(source, name), join(app, name), { recursive: true });
      run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: app });
      run("npm", ["run", "build"], { cwd: app });
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
      if (!existsSync(join(root, "environment.json"))) createFile(join(root, "environment.json"), JSON.stringify({ AGENT_TASK_TOKEN: randomBytes(32).toString("hex"), AGENT_TASK_ADMIN_TOKEN: randomBytes(32).toString("hex") }, null, 2) + "\n");
      if (!existsSync(join(root, "config.json"))) createFile(join(root, "config.json"), JSON.stringify({ dataDir: join(root, "data"), port: manifest.port,
        tokenEnv: "AGENT_TASK_TOKEN", coordinator: manifest.coordinator,
        executors: manifest.selected.map(id => ({ id, command: join(components, "node_modules/.bin", id === "pi" ? "pi-acp" : id === "codex" ? "codex-acp" : "opencode"),
          args: id === "opencode" ? ["acp"] : [], cwd: manifest.cwd, envKeys: ["HOME"],
          permissionAllowlist: [], unattendedApproved: false, resultReadRoots: [] })) }, null, 2) + "\n");
      manifest.phase = "ready";
    } finally {
      manifest.files = ["app", "components"].filter(name => existsSync(join(root, name))).flatMap(name => inventory(root, name));
      saveManifest(root, manifest);
    }
  }
  const env = runtimeEnv(manifest);
  // Config validation and probes run in the SAME explicit environment as the background service.
  run(manifest.node, ["--input-type=module", "-e", `import {loadConfig} from ${JSON.stringify(pathToFileURL(join(app, "dist/config.js")).href)}; loadConfig(process.argv[1]);`, join(root, "config.json")], { env });
  const config = json(join(root, "config.json"));
  const { executorEnv } = await import(pathToFileURL(join(app, "dist/config.js")).href);
  for (const id of manifest.selected) {
    const binary = id === "pi" ? "pi" : id;
    const cliEnv = executorEnv(config.executors.find(executor => executor.id === id)?.envKeys ?? [], env);
    run(join(components, "node_modules/.bin", binary), ["--version"], { env: cliEnv, timeout: 20000 });
  }
  const report = { platform: process.platform, dependencies: "ready", configuration: "valid", background: "not-checked",
    coordinator: config.coordinator ? "configured; authentication not verified" : "not configured; task admission disabled",
    executors: config.executors.map(executor => ({ id: executor.id, authorized: executor.unattendedApproved,
      handshake: "not checked", execution: "not verified by setup" })) };
  if (options.probe) {
    for (const entry of report.executors) {
      try { run(manifest.node, [join(app, "scripts/probe-agent.mjs"), join(root, "config.json"), entry.id], { env, timeout: 20000 }); entry.handshake = "passed (initialize only)"; }
      catch { entry.handshake = "failed; inspect native dependencies/configuration separately"; process.exitCode = 1; }
    }
  }
  if (!options["prepare-only"] && !options.check) {
    // Record intent before activating so a failed service start is still owned by uninstall.
    manifest.serviceInstalled = true; saveManifest(root, manifest);
    activate(manifest);
    await new Promise(resolve => setTimeout(resolve, 1500));
    report.background = "service manager registered";
  }
  if (manifest.serviceInstalled) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/mcp`, {
        method: "POST", headers: { Authorization: "Bearer " + env[config.tokenEnv], "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "service_status", arguments: {} } }), signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      if (!response.ok || !body.result?.structuredContent?.data?.running) throw new Error("Not healthy");
      report.background = "authenticated MCP health check passed";
    } catch { report.background = "not ready; run --check after startup and inspect the service manager"; process.exitCode = 1; }
  }
  console.log(JSON.stringify(report, null, 2));
  console.log(`Config: ${join(root, "config.json")}\nSecrets (never printed): ${join(root, "environment.json")}\nNative login: use ${join(components, "node_modules/.bin")} executables: pi then /login; codex login; opencode auth login. No login is performed by setup.\nConsole: http://127.0.0.1:${config.port}/admin/ (use the separate AGENT_TASK_ADMIN_TOKEN from the private environment file; never place it in a URL). Configure coordinator credentials there or in environment.json, and audit native executor permissions before setting unattendedApproved=true. No permissions are granted by setup. Restart the service manually after changes.\nLinux: user service requires lingering for logout survival (administrator decision). macOS: LaunchAgent survives terminal close, not user logout; log in again to restart. Neither platform executes during sleep/shutdown.`);
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally { unlock?.(); }
