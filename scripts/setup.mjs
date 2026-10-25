#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, lstatSync, writeSync } from "node:fs";
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
    console.log("用法：agent-task setup [--home 私有绝对目录]\n新安装：在终端确认目录、端口、令牌及协调模型。\n非交互初始化：--home 目录 --data-dir 目录 --port 端口 --generate-tokens|--credentials-file 私有JSON文件 --yes [--provider openai|anthropic|deepseek|openai-compatible --model 模型ID]\n兼容 provider：--base-url URL --api openai-completions|openai-responses --api-key-env 变量名 --context-window 整数 --max-tokens 整数\n已有安装：--check [--json] 只读检查；--resume 续接初始化。凭据从私有 JSON 文件或终端隐藏输入读取，不通过命令参数传入。初始化不安装执行端。");
    process.exit(0);
  }
  if (options.json && !options.check) throw new Error("--json 仅用于 setup --check");
  let root = installRoot(options);
  if (options.check) {
    if (Object.keys(options).some(key => !["home", "check", "json"].includes(key))) throw new Error("setup --check 只接受附加选项 --json 和 --home");
    // This branch never creates a directory, opens SQLite, starts a service or repairs files.
    let report;
    try {
      let present = true;
      try { lstatSync(join(root, "installation.json")); }
      catch (error) { if (error.code === "ENOENT") present = false; else throw error; }
      if (!present) {
        report = { configuration: existsSync(join(root, "launch.json")) ? "invalid" : "missing" };
      } else {
        const manifest = readManifest(root);
        if (manifest.phase === "initializing") report = { configuration: "incomplete" };
        else {
          if (manifest.phase !== "ready" || !existsSync(join(packageRoot, "dist/application/main.js"))) throw new Error("安装无效");
          const paths = startupPaths(root), config = loadConfig(paths.configPath), environment = readEnvironment(paths.environmentPath);
          validateServiceEnvironment(config, environment);
          report = { configuration: "valid", coordinatorConfigured: Boolean(config.coordinator && environment[coordinatorCredentialEnv(config.coordinator)]) };
        }
      }
    } catch {
      // Do not serialize exceptions: schema/parser errors can include private values.
      report = { configuration: "invalid" };
    }
    writeSync(1, JSON.stringify(report) + "\n");
    process.exit(report.configuration === "valid" ? 0 : 1);
  }
  if (!existsSync(join(root, "installation.json")) && !options.resume && !options.yes) {
    await setupWizard(options, root); root = installRoot(options);
  }
  let manifest, initialEnvironment;
  if (existsSync(join(root, "installation.json"))) {
    manifest = readManifest(root);
    if (Object.keys(options).some(key => !["home", "resume"].includes(key))) throw new Error("安装已存在，请使用配置命令，不再传入初始化选项");
    if (manifest.phase !== "ready" && !options.resume) throw new Error("初始化未完成；请检查私有文件后显式使用 --resume");
  } else {
    if (options.resume) throw new Error("没有可续接的初始化");
    if (!options.yes || !options.home || !options["data-dir"] || options.port === undefined ||
      (!options["generate-tokens"] && !options["credentials-file"])) throw new Error("请提供 --home、--data-dir、--port、--generate-tokens/--credentials-file，并用 --yes 确认初始化");
    const dataDir = installRoot({ home: options["data-dir"] });
    if (dataDir === root || dataDir === packageRoot || dataDir.startsWith(packageRoot + "/")) throw new Error("数据目录必须独立于安装根目录和 npm 包目录");
    const coordinator = !options.provider || options.provider === "none" ? undefined : {
      provider: options.provider, model: options.model,
      ...(options.provider === "openai-compatible" ? { baseUrl: options["base-url"], api: options.api,
        apiKeyEnv: options["api-key-env"], contextWindow: Number(options["context-window"]), maxTokens: Number(options["max-tokens"]), reasoning: false } : {}),
    };
    const config = validateConfig(configSchema.parse({ dataDir, port: Number(options.port), tokenEnv: options["token-env"] ?? "AGENT_TASK_TOKEN", coordinator, disabledExecutors: [] }));
    initialEnvironment = options["credentials-file"] ? parseEnvironment(JSON.stringify(json(options["credentials-file"]))) : {};
    if (options["generate-tokens"]) {
      if (initialEnvironment[config.tokenEnv] || initialEnvironment.AGENT_TASK_ADMIN_TOKEN) throw new Error("提供已有令牌与生成新令牌只能选择一种");
      initialEnvironment[config.tokenEnv] = randomBytes(32).toString("hex");
      initialEnvironment.AGENT_TASK_ADMIN_TOKEN = randomBytes(32).toString("hex");
    }
    if (coordinator && options.coordinatorKey) initialEnvironment[coordinatorCredentialEnv(config.coordinator)] = options.coordinatorKey;
    validateServiceEnvironment(config, initialEnvironment);
    if (!initialEnvironment.AGENT_TASK_ADMIN_TOKEN) throw new Error("初始化需要独立的管理员令牌");
    if (coordinator && !initialEnvironment[coordinatorCredentialEnv(config.coordinator)]) throw new Error("缺少协调凭据，请通过私有凭据文件提供");
    for (const path of [join(root, "launch.json"), join(dataDir, "config.json"), join(dataDir, "environment.json")]) {
      if (existsSync(path)) throw new Error("初始化文件已存在且未归属当前安装，拒绝覆盖：" + path);
    }
    checkDataDirectory(root); checkDataDirectory(dataDir);
    manifest = { project: "agent-task", root, home: homedir(), platform: process.platform, node: process.execPath,
      app: packageRoot, phase: "initializing", dataDir, config };
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root || lstatSync(root).uid !== process.getuid() || (lstatSync(root).mode & 0o077)) throw new Error("安装目录必须是当前用户所有的规范私有目录");
  unlock = operationLock(root);
  if (!existsSync(join(root, "installation.json"))) createFile(join(root, "installation.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (!existsSync(join(packageRoot, "dist/application/main.js"))) throw new Error("缺少预编译运行文件，请核查安装包");
  if (manifest.phase !== "ready") {
    if (!isAbsolute(manifest.dataDir) || !manifest.config) throw new Error("安装记录不完整，未修复");
    const dataDir = manifest.dataDir;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 }); checkDataDirectory(dataDir);
    const environmentPath = join(dataDir, "environment.json"), configPath = join(dataDir, "config.json");
    if (!existsSync(environmentPath)) {
      if (!initialEnvironment) throw new Error("初始化没有已保存的凭据，请先检查私有目录再续接");
      createFile(environmentPath, JSON.stringify(initialEnvironment, null, 2) + "\n");
    }
    if (!existsSync(configPath)) createFile(configPath, JSON.stringify(manifest.config, null, 2) + "\n");
    const config = loadConfig(configPath), environment = readEnvironment(environmentPath);
    if (JSON.stringify(config) !== JSON.stringify(manifest.config)) throw new Error("已保存配置与初始化记录不一致，未修复");
    validateServiceEnvironment(config, environment);
    if (!existsSync(join(root, "launch.json"))) createFile(join(root, "launch.json"), JSON.stringify({ dataDir }) + "\n");
    if (startupPaths(root).dataDir !== dataDir) throw new Error("启动定位与初始化记录不一致");
    manifest.phase = "ready"; delete manifest.config; delete manifest.dataDir;
    saveManifest(root, manifest);
  }
  const paths = startupPaths(root), config = loadConfig(paths.configPath);
  validateServiceEnvironment(config, readEnvironment(paths.environmentPath));
  console.log(JSON.stringify({ configuration: "valid", coordinator: config.coordinator ? "已配置；未验证认证" : "未配置",
    configPath: paths.configPath, credentialsPath: paths.environmentPath, executorDiscovery: "建立 MCP 连接时发现" }, null, 2));
  console.log("在 MCP 宿主中配置 command: agent-task、args: [mcp]；自定义安装附加相同 --home。令牌不回显。需要前台管理时运行 agent-task start。");
} catch (error) {
  console.error(error.name === "ZodError" ? "初始化配置无效，请检查 provider、模型、目录和端口" : error.message);
  process.exitCode = 1;
} finally { unlock?.(); }
