// Real source-free npm install and local HTTP acceptance. No model calls.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, existsSync, statSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

process.umask(0o077);
const args = process.argv.slice(2), registry = args.includes("--registry");
const positional = args.filter(arg => arg !== "--registry");
if ((registry && positional.length) || (!registry && positional.length !== 1)) throw new Error("Usage: node scripts/verify-install.mjs TARBALL | --registry");
if (!["linux", "darwin"].includes(process.platform)) throw new Error(`Installation validation is unavailable on ${process.platform}; use Linux or macOS`);
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 19)) throw new Error(`Installation validation requires Node.js 22.19+; current version is ${process.version}`);
const packageName = "@realqiyan/agent-task";
const spec = registry ? packageName : resolve(positional[0]);
const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-npm-"));
const prefix = join(root, "prefix"), workspace = join(root, "workspace"), home = join(root, "private");
const isolatedHome = join(root, "native-home"), userConfig = join(root, "npmrc");
for (const path of [prefix, workspace, isolatedHome]) mkdirSync(path, { mode: 0o700 });
writeFileSync(userConfig, "", { mode: 0o600 });
console.log("Installation validation directory: " + root);
const env = { PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(":"), HOME: isolatedHome, LANG: "en_US.UTF-8",
  npm_config_userconfig: userConfig, npm_config_cache: process.env.npm_config_cache ?? join(root, "npm-cache"), npm_config_registry: registry ? "https://registry.npmjs.org/" : (process.env.npm_config_registry ?? "https://registry.npmjs.org/") };
let logs = "", child, closed, mcpClient, backgroundStarted = false, secrets = [];
function run(command, argv) {
  const result = spawnSync(command, argv, { cwd: workspace, env, encoding: "utf8", timeout: 1800000 });
  logs += (result.stdout ?? "") + (result.stderr ?? "");
  assert(!result.error && result.status === 0, "Validation command failed (output withheld): " + command + " " + argv[0]);
  return result.stdout;
}
const cli = join(prefix, "bin/agent-task");
const invoke = (...argv) => run(cli, argv);
async function stop() {
  if (!child) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  try { await closed; } finally { clearTimeout(timer); child = undefined; }
}
let origin, config, credentials;
async function health() {
  const response = await fetch(origin + "/mcp", { method: "POST", headers: {
    Authorization: "Bearer " + credentials[config.tokenEnv], "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "service_status", arguments: {} } }),
  signal: AbortSignal.timeout(1000) });
  const body = await response.json();
  assert(response.ok && body.result?.structuredContent?.data?.running, "MCP health check failed");
}
async function start() {
  child = spawn(cli, ["start", "--home", home], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { logs += data; });
  child.stderr.on("data", data => { logs += data; });
  closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  for (let i = 0; i < 100; i++) {
    try { await health(); return; } catch { /* Wait only for this newly started local service. */ }
    if (child.exitCode !== null) break;
    await delay(100);
  }
  throw new Error("Foreground startup failed (output withheld)");
}
async function admin(path, body) {
  const response = await fetch(origin + "/admin/api" + path, { method: body ? "POST" : "GET", headers: {
    Authorization: "Bearer " + credentials.AGENT_TASK_ADMIN_TOKEN,
    ...(body ? { Origin: origin, "Content-Type": "application/json" } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  assert(response.ok && !result.error, "Authenticated Web configuration request failed");
  return result.data;
}
try {
  run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", spec]);
  const installed = join(prefix, "lib/node_modules", packageName);
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(pkg.name, packageName);
  assert.equal(pkg.version, "0.1.0-rc.1");
  assert.equal(pkg.license, "MIT");
  assert(!existsSync(join(installed, "src")) && !existsSync(join(installed, "node_modules/typescript")), "Source/compiler must not be required");
  assert.equal(invoke("--version").trim(), pkg.version);
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  invoke("setup", "--home", home, "--data-dir", join(home, "data"), "--port", String(port), "--generate-tokens", "--yes");
  const environmentPath = join(home, "data/environment.json"), configPath = join(home, "data/config.json");
  config = JSON.parse(readFileSync(configPath, "utf8"));
  credentials = JSON.parse(readFileSync(environmentPath, "utf8"));
  secrets = Object.values(credentials);
  assert(secrets.length === 2 && secrets[0] !== secrets[1] && secrets.every(secret => secret.length >= 32), "Distinct strong tokens required");
  assert.equal(statSync(home).mode & 0o777, 0o700);
  for (const file of [configPath, environmentPath]) assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(config.disabledExecutors, [], "Native discovery is enabled by default");
  const originalEnvironment = readFileSync(environmentPath, "utf8");
  invoke("setup", "--home", home);
  assert(readFileSync(environmentPath, "utf8") === originalEnvironment, "Repeated setup must preserve credentials");
  origin = "http://127.0.0.1:" + port;
  await start();
  invoke("status", "--home", home);
  assert.equal((await fetch(origin + "/mcp", { method: "POST" })).status, 401);
  assert.equal((await fetch(origin + "/admin/api/settings")).status, 401);
  for (const path of ["/admin/", "/admin/app.js", "/admin/style.css"]) assert.equal((await fetch(origin + path)).status, 200);
  let settings = await admin("/settings");
  const testSecret = randomBytes(32).toString("hex");
  secrets.push(testSecret);
  settings = await admin("/settings/credential", { editToken: settings.editToken, key: "INSTALL_CHECK_SECRET", action: "replace", value: testSecret });
  // Exercise advanced discovery policy without launching ACP or a model.
  await admin("/settings/config", { editToken: settings.editToken, config: { ...settings.saved, disabledExecutors: ["claude"] } });
  assert((await admin("/settings")).pendingRestart);
  const before = JSON.parse(invoke("status", "--home", home));
  const webRestart = await admin("/restart", {});
  assert.notEqual(webRestart.pid, before.pid);
  assert.notEqual(JSON.parse(invoke("restart", "--home", home)).pid, webRestart.pid);
  settings = await admin("/settings");
  assert(!settings.pendingRestart && settings.running.disabledExecutors.length === 1 && settings.running.disabledExecutors[0] === "claude");
  assert(settings.credentials.some(credential => credential.key === "INSTALL_CHECK_SECRET" && credential.running));
  await admin("/settings/config", { editToken: settings.editToken,
    config: { ...settings.saved, disabledExecutors: ["pi", "codex", "claude"] } });
  await stop();
  // Exercise the installed stdio entry without native ACP or model work.
  const nativeBin = join(root, "native-bin");
  mkdirSync(nativeBin, { mode: 0o700 }); symlinkSync("/usr/bin/false", join(nativeBin, "opencode"));
  const require = createRequire(join(installed, "package.json"));
  const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
  const { StdioClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
  mcpClient = new Client({ name: "agent-task-install-check", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--home", home],
    cwd: workspace, env: { ...env, PATH: nativeBin + ":" + env.PATH }, stderr: "pipe" });
  transport.stderr.on("data", data => { logs += data; });
  backgroundStarted = true;
  await mcpClient.connect(transport, { timeout: 20_000 });
  assert((await mcpClient.listTools()).tools.some(tool => tool.name === "task_create"));
  const discovered = await mcpClient.callTool({ name: "executor_list", arguments: {} });
  assert(discovered.structuredContent?.data?.executors.some(executor => executor.id === "opencode" && executor.state === "ready"));
  const background = JSON.parse(invoke("status", "--home", home));
  await mcpClient.close(); mcpClient = undefined;
  assert.equal(JSON.parse(invoke("status", "--home", home)).pid, background.pid, "Background must outlive the MCP process");
  assert.equal(JSON.parse(invoke("stop", "--home", home)).stopped, true);
  backgroundStarted = false;
  for (const secret of secrets) assert(!logs.includes(secret), "Credentials appeared in command/service output");
  const report = { name: pkg.name, version: pkg.version, platform: process.platform, arch: process.arch, node: process.version,
    platformValidation: Object.fromEntries(["linux", "darwin"].map(platform => [platform,
      platform === process.platform ? "passed" : `not run (host is ${process.platform})`])),
    source: registry ? "npm latest (default install)" : "local npm tarball", dependencyRegistry: env.npm_config_registry, foreground: "passed",
    webConfiguration: "passed (HTTP, not browser)", stdioBackground: "passed (startup, discovery, disconnect and stop)",
    authenticatedHealth: "passed", credentialsInOutput: false,
    modelAndExecutorExecution: "not tested", evidenceDirectory: root };
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await mcpClient?.close().catch(() => {});
  if (backgroundStarted) { try { invoke("stop", "--home", home); } catch {} }
  await stop();
}
