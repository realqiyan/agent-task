#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, lstatSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { argumentsFor, installRoot, createFile, json, operationLock, readManifest, saveManifest, packageRoot } from "./install-lib.mjs";
import { setupWizard } from "./setup-wizard.mjs";
import { startupPaths, loadConfig, readEnvironment } from "../dist/configuration/files.js";
import { configSchema } from "../dist/configuration/contract.js";
import { validateConfig, coordinatorCredentialEnv } from "../dist/configuration/policy.js";
import { validateServiceEnvironment, parseEnvironment } from "../dist/configuration/environment.js";
import { checkDataDirectory } from "../dist/infrastructure/private-files.js";

process.umask(0o077);
let unlock;
try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: agent-task setup [--home ABSOLUTE_PRIVATE_DIR]\nNew installation: confirm directories, port, tokens and coordinator in the terminal.\nNoninteractive: --home DIR --data-dir DIR --port NUMBER --generate-tokens|--credentials-file PRIVATE_JSON --yes [--provider openai|anthropic|deepseek|openai-compatible --model ID]\nCompatible provider: --base-url URL --api openai-completions|openai-responses --api-key-env NAME --context-window NUMBER --max-tokens NUMBER\nExisting installation: --check | --resume. Secrets are read from a private JSON file or hidden terminal input, never command arguments. No executor installation during setup.");
    process.exit(0);
  }
  let root = installRoot(options);
  if (!existsSync(join(root, "installation.json")) && !options.check && !options.resume && !options.yes) {
    await setupWizard(options, root); root = installRoot(options);
  }
  let manifest, initialEnvironment;
  if (existsSync(join(root, "installation.json"))) {
    manifest = readManifest(root);
    if (Object.keys(options).some(key => !["home", "check", "resume"].includes(key))) throw new Error("Installation exists; use configuration commands instead of initialization flags");
    if (manifest.phase !== "ready" && !options.resume) throw new Error("Incomplete initialization; inspect private files and use --resume explicitly");
  } else {
    if (options.check || options.resume) throw new Error("No installation to check/resume");
    if (!options.yes || !options.home || !options["data-dir"] || options.port === undefined ||
      (!options["generate-tokens"] && !options["credentials-file"])) throw new Error("Confirm initialization with --home, --data-dir, --port, --generate-tokens/--credentials-file and --yes");
    const dataDir = installRoot({ home: options["data-dir"] });
    if (dataDir === root || dataDir === packageRoot || dataDir.startsWith(packageRoot + "/")) throw new Error("Data directory must be separate from the installation root and npm package");
    const coordinator = !options.provider || options.provider === "none" ? undefined : {
      provider: options.provider, model: options.model,
      ...(options.provider === "openai-compatible" ? { baseUrl: options["base-url"], api: options.api,
        apiKeyEnv: options["api-key-env"], contextWindow: Number(options["context-window"]), maxTokens: Number(options["max-tokens"]), reasoning: false } : {}),
    };
    const config = validateConfig(configSchema.parse({ dataDir, port: Number(options.port), tokenEnv: options["token-env"] ?? "AGENT_TASK_TOKEN", coordinator, disabledExecutors: [] }));
    initialEnvironment = options["credentials-file"] ? parseEnvironment(JSON.stringify(json(options["credentials-file"]))) : {};
    if (options["generate-tokens"]) {
      if (initialEnvironment[config.tokenEnv] || initialEnvironment.AGENT_TASK_ADMIN_TOKEN) throw new Error("Choose either supplied service/admin tokens or generated tokens");
      initialEnvironment[config.tokenEnv] = randomBytes(32).toString("hex");
      initialEnvironment.AGENT_TASK_ADMIN_TOKEN = randomBytes(32).toString("hex");
    }
    if (coordinator && options.coordinatorKey) initialEnvironment[coordinatorCredentialEnv(config.coordinator)] = options.coordinatorKey;
    validateServiceEnvironment(config, initialEnvironment);
    if (!initialEnvironment.AGENT_TASK_ADMIN_TOKEN) throw new Error("An independent administrator token is required for initialization");
    if (coordinator && !initialEnvironment[coordinatorCredentialEnv(config.coordinator)]) throw new Error("Coordinator credential is missing; supply it through the private credentials file");
    for (const path of [join(root, "launch.json"), join(dataDir, "config.json"), join(dataDir, "environment.json")]) {
      if (existsSync(path)) throw new Error("Existing unowned initialization file; refusing to overwrite: " + path);
    }
    checkDataDirectory(root); checkDataDirectory(dataDir);
    manifest = { project: "agent-task", root, home: homedir(), platform: process.platform, node: process.execPath,
      app: packageRoot, phase: "initializing", dataDir, config };
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root || lstatSync(root).uid !== process.getuid() || (lstatSync(root).mode & 0o077)) throw new Error("Installation home must be canonical, owned and private");
  unlock = operationLock(root);
  if (!existsSync(join(root, "installation.json"))) createFile(join(root, "installation.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (!existsSync(join(packageRoot, "dist/application/main.js"))) throw new Error("Prebuilt runtime missing; reinstall the package");
  if (manifest.phase !== "ready") {
    if (!isAbsolute(manifest.dataDir) || !manifest.config) throw new Error("Incomplete installation record; no repair performed");
    const dataDir = manifest.dataDir;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 }); checkDataDirectory(dataDir);
    const environmentPath = join(dataDir, "environment.json"), configPath = join(dataDir, "config.json");
    if (!existsSync(environmentPath)) {
      if (!initialEnvironment) throw new Error("Initialization has no saved credentials; inspect the private directory before resuming");
      createFile(environmentPath, JSON.stringify(initialEnvironment, null, 2) + "\n");
    }
    if (!existsSync(configPath)) createFile(configPath, JSON.stringify(manifest.config, null, 2) + "\n");
    const config = loadConfig(configPath), environment = readEnvironment(environmentPath);
    if (JSON.stringify(config) !== JSON.stringify(manifest.config)) throw new Error("Saved initialization configuration differs; no repair performed");
    validateServiceEnvironment(config, environment);
    if (!existsSync(join(root, "launch.json"))) createFile(join(root, "launch.json"), JSON.stringify({ dataDir }) + "\n");
    if (startupPaths(root).dataDir !== dataDir) throw new Error("Launch locator differs from initialization");
    manifest.phase = "ready"; delete manifest.config; delete manifest.dataDir;
    saveManifest(root, manifest);
  }
  const paths = startupPaths(root), config = loadConfig(paths.configPath);
  validateServiceEnvironment(config, readEnvironment(paths.environmentPath));
  console.log(JSON.stringify({ configuration: "valid", coordinator: config.coordinator ? "configured; authentication not verified" : "not configured",
    configPath: paths.configPath, credentialsPath: paths.environmentPath, executorDiscovery: "on MCP connection" }, null, 2));
  if (!options.check) console.log("Add agent-task with args [mcp] to your MCP client (include --home for a custom installation). Token values are not printed. Use agent-task start for foreground management.");
} catch (error) {
  console.error(error.name === "ZodError" ? "Invalid initialization configuration; check provider, model, directories and port" : error.message);
  process.exitCode = 1;
} finally { unlock?.(); }
