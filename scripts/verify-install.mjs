// Real source-free npm install and local HTTP/service-manager acceptance. No model calls.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

process.umask(0o077);
const args = process.argv.slice(2), background = args.includes("--service"), registry = args.includes("--registry");
const positional = args.filter(arg => !["--service", "--registry"].includes(arg));
if ((registry && positional.length) || (!registry && positional.length !== 1)) throw new Error("Usage: node scripts/verify-install.mjs TARBALL [--service] | --registry [--service]");
const packageName = "@realqiyan/agent-task";
const spec = registry ? packageName : resolve(positional[0]);
const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-npm-"));
const prefix = join(root, "prefix"), workspace = join(root, "workspace"), home = join(root, "private");
const isolatedHome = join(root, "native-home"), userConfig = join(root, "npmrc");
for (const path of [prefix, workspace, isolatedHome]) mkdirSync(path, { mode: 0o700 });
writeFileSync(userConfig, "", { mode: 0o600 });
console.log("Installation validation directory: " + root);
const env = { PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(":"), HOME: background ? homedir() : isolatedHome, LANG: "en_US.UTF-8",
  npm_config_userconfig: userConfig, npm_config_cache: process.env.npm_config_cache ?? join(root, "npm-cache"), npm_config_registry: registry ? "https://registry.npmjs.org/" : (process.env.npm_config_registry ?? "https://registry.npmjs.org/"),
  XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
  ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) };
let logs = "", child, closed, serviceAttempted = false, secrets = [];
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
    Authorization: "Bearer " + credentials.AGENT_TASK_TOKEN, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
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
  if (background) {
    const serviceFile = process.platform === "linux" ? join(homedir(), ".config/systemd/user/agent-task.service")
      : join(homedir(), "Library/LaunchAgents/com.agent-task.service.plist");
    assert(!existsSync(serviceFile), "Refusing to touch an existing user service");
    if (process.platform === "linux") run("systemctl", ["--user", "show", "--property=Version"]);
    else run("launchctl", ["print-disabled", `gui/${process.getuid()}`]);
  }
  run("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline", spec]);
  const installed = join(prefix, "lib/node_modules", packageName);
  const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(pkg.name, packageName);
  assert.equal(pkg.version, "0.0.1-rc.1");
  assert.equal(pkg.license, "MIT");
  assert(!existsSync(join(installed, "src")) && !existsSync(join(installed, "node_modules/typescript")), "Source/compiler must not be required");
  assert.equal(invoke("--version").trim(), pkg.version);
  const port = await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  invoke("setup", "--home", home, "--executors", "none", "--cwd", workspace, "--port", String(port), "--prepare-only");
  const environmentPath = join(home, "environment.json"), configPath = join(home, "config.json");
  config = JSON.parse(readFileSync(configPath, "utf8"));
  credentials = JSON.parse(readFileSync(environmentPath, "utf8"));
  secrets = Object.values(credentials);
  assert(secrets.length === 2 && secrets[0] !== secrets[1] && secrets.every(secret => secret.length >= 32), "Distinct strong tokens required");
  assert.equal(statSync(home).mode & 0o777, 0o700);
  for (const file of [configPath, environmentPath]) assert.equal(statSync(file).mode & 0o777, 0o600);
  assert(config.executors.every(executor => !executor.unattendedApproved), "Setup must not authorize executors");
  const originalEnvironment = readFileSync(environmentPath, "utf8");
  invoke("setup", "--home", home, "--prepare-only");
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
  // A real local executable registered but NOT approved; no ACP invocation or model request.
  const executor = { id: "unapproved", command: process.execPath, args: [], cwd: workspace, envKeys: [],
    permissionAllowlist: [], unattendedApproved: false, resultReadRoots: [] };
  await admin("/settings/config", { editToken: settings.editToken, config: { executors: [executor] } });
  assert((await admin("/settings")).pendingRestart);
  await stop();
  await start();
  settings = await admin("/settings");
  assert(!settings.pendingRestart && settings.running.executors.length === 1 && !settings.running.executors[0].unattendedApproved);
  assert(settings.credentials.some(credential => credential.key === "INSTALL_CHECK_SECRET" && credential.running));
  await stop();
  const savedConfig = readFileSync(configPath, "utf8"), savedEnvironment = readFileSync(environmentPath, "utf8");
  writeFileSync(join(home, "data/operator-note.txt"), "retain installation validation data", { mode: 0o600 });
  if (background) {
    const since = "@" + Math.floor(Date.now() / 1000);
    serviceAttempted = true;
    invoke("service", "install", "--home", home);
    invoke("status", "--home", home);
    await health();
    assert((await admin("/settings")).running.executors[0].unattendedApproved === false);
    invoke("service", "remove", "--home", home);
    serviceAttempted = false;
    if (process.platform === "linux") run("journalctl", ["--user", "-u", "agent-task.service", "--since", since, "--no-pager"]);
    else for (const name of ["service.log", "service-error.log"]) if (existsSync(join(home, name))) logs += readFileSync(join(home, name), "utf8");
  }
  invoke("uninstall", "--home", home);
  invoke("uninstall", "--home", home);
  assert(readFileSync(configPath, "utf8") === savedConfig && readFileSync(environmentPath, "utf8") === savedEnvironment, "Uninstall must preserve private files");
  assert(existsSync(join(home, "data/tasks.sqlite")) && existsSync(join(home, "data/operator-note.txt")) && existsSync(workspace), "Uninstall must preserve data and workspace");
  assert(existsSync(cli), "Only npm may remove the npm package");
  for (const secret of secrets) assert(!logs.includes(secret), "Credentials appeared in command/service output");
  const report = { name: pkg.name, version: pkg.version, platform: process.platform, arch: process.arch, node: process.version,
    source: registry ? "npm latest (default install)" : "local npm tarball", dependencyRegistry: env.npm_config_registry, foreground: "passed",
    webConfiguration: "passed (HTTP, not browser)", background: background ? "passed (real service manager)" : "not tested",
    authenticatedHealth: "passed", credentialsInOutput: false, uninstallPreservedData: true,
    modelAndExecutorExecution: "not tested", evidenceDirectory: root };
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stop();
  if (serviceAttempted) invoke("service", "remove", "--home", home);
}
