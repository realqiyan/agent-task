import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, readdirSync, unlinkSync, rmdirSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { dirname, join, resolve, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { controlService } from "../dist/launcher.js";

export const packageRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

export const label = "com.agent-task.service";
export const unit = "agent-task.service";
export const packages = {
  pi: ["@earendil-works/pi-coding-agent@1.3.0", "pi-acp@0.0.34"],
  codex: ["@agentclientprotocol/codex-acp@2.2.2"],
  claude: ["@zed-industries/claude-agent-acp@0.23.1"],
  opencode: ["opencode-ai@1.19.3"],
};
export function argumentsFor(argv) {
  const flags = new Set(["prepare-only", "service", "check", "probe", "resume", "help"]), options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || key in options) throw new Error("Invalid or repeated option");
    if (flags.has(key)) options[key] = true;
    else if (["home", "executors", "cwd", "provider", "model", "port"].includes(key) && argv[i + 1] && !argv[i + 1].startsWith("--")) options[key] = argv[++i];
    else throw new Error("Unknown option or missing value: " + key);
  }
  return options;
}
export function installRoot(options) {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Only Linux and macOS are supported");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error("Node.js 22.19+ is required");
  const path = options.home ?? join(homedir(), process.platform === "darwin" ? "Library/Application Support/agent-task" : ".local/share/agent-task");
  if (!isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Installation home must be an absolute path without control characters");
  let parent = resolve(path);
  const tail = [];
  while (!existsSync(parent)) { tail.unshift(basename(parent)); parent = dirname(parent); }
  return join(realpathSync(parent), ...tail);
}
export function privateFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Expected a private, owned regular file: " + path);
}
export function json(path) {
  privateFile(path);
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error("Cannot read valid JSON from " + path); } // JSON parser diagnostics can quote secrets.
}
export function createFile(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { flag: "wx", mode: 0o600 });
}
export function run(command, args, options = {}) {
  const env = Object.fromEntries(["HOME", "PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 300000, stdio: "pipe", env, ...options });
  if (result.error || result.status !== 0) throw new Error("Command failed (diagnostics withheld; may contain credentials): " + command + " " + args[0]);
  return result.stdout?.trim();
}
export function operationLock(root) {
  const db = new DatabaseSync(join(root, "setup-lock.sqlite"));
  try { db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
  catch { db.close(); throw new Error("Another setup/uninstall operation owns this installation"); }
  return () => db.close();
}
export function readManifest(root) {
  if (realpathSync(root) !== root || lstatSync(root).uid !== process.getuid() || (lstatSync(root).mode & 0o077)) throw new Error("Installation home must be canonical, owned and private");
  const value = json(join(root, "installation.json"));
  if (value.project !== "agent-task" || value.root !== root || value.platform !== process.platform || value.home !== homedir() || typeof value.node !== "string" || !isAbsolute(value.node) || value.app !== packageRoot) throw new Error("Installation ownership does not match this user/platform");
  return value;
}
export function saveManifest(root, manifest) {
  // Preserve the last committed inventory even if a disk-full write fails.
  const temporary = join(root, `installation-${process.pid}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(manifest, null, 2) + "\n"); fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, join(root, "installation.json"));
    const directory = openSync(root, "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function runtimeBaseEnv(manifest) {
  // Capture the OS user environment; the runtime isolates private service values before worker creation.
  return { ...process.env, HOME: manifest.home, PATH: [join(manifest.root, "components/node_modules/.bin"), dirname(manifest.node), process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"), LANG: process.env.LANG ?? "en_US.UTF-8" };
}
const xml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const systemdQuote = value => '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$") + '"';
export function serviceDefinition(manifest) {
  const runner = join(manifest.app, "scripts/service-runner.mjs");
  if (manifest.platform === "linux") return {
    path: join(manifest.home, ".config/systemd/user", unit),
    text: `[Unit]\nDescription=Agent Task (managed by setup)\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${[manifest.node, runner, manifest.root].map(systemdQuote).join(" ")}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=45\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`,
  };
  return { path: join(manifest.home, "Library/LaunchAgents", label + ".plist"), text:
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${[manifest.node, runner, manifest.root].map(value => `<string>${xml(value)}</string>`).join("")}</array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n<key>ThrottleInterval</key><integer>5</integer>\n<key>ExitTimeOut</key><integer>45</integer>\n<key>AbandonProcessGroup</key><false/>\n<key>Umask</key><integer>63</integer>\n</dict></plist>\n` };
}
export function serviceEnv() {
  const keys = ["HOME", "PATH", "LANG", "LC_ALL", "DBUS_SESSION_BUS_ADDRESS"];
  return { ...Object.fromEntries(keys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}` };
}
export async function checkHealth(home, waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  do {
    try { return await controlService(home, "status"); }
    catch { /* The launcher may still be starting; never log credentials. */ }
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error("Authenticated MCP health check failed; inspect private logs and startup files");
}
export function verifyServiceFile(manifest) {
  const definition = serviceDefinition(manifest);
  if (existsSync(definition.path)) {
    privateFile(definition.path);
    if (readFileSync(definition.path, "utf8") !== definition.text) throw new Error("Service file differs; refusing to overwrite or remove it: " + definition.path);
  }
  return definition;
}
export function activate(manifest) {
  const definition = verifyServiceFile(manifest);
  if (!existsSync(definition.path)) createFile(definition.path, definition.text);
  if (manifest.platform === "linux") {
    run("systemctl", ["--user", "daemon-reload"], { env: serviceEnv() });
    run("systemctl", ["--user", "enable", "--now", unit], { env: serviceEnv() });
    run("systemctl", ["--user", "is-active", unit], { env: serviceEnv() });
  } else {
    const domain = `gui/${process.getuid()}`;
    const active = spawnSync("launchctl", ["print", domain + "/" + label], { stdio: "ignore" });
    if (active.status !== 0) run("launchctl", ["bootstrap", domain, definition.path]);
    run("launchctl", ["kickstart", domain + "/" + label]);
    run("launchctl", ["print", domain + "/" + label]);
  }
}
export function deactivate(manifest) {
  const definition = verifyServiceFile(manifest);
  if (!existsSync(definition.path)) {
    if (manifest.serviceInstalled) throw new Error("Managed service file is missing; verify it is unloaded before cleanup");
    return;
  }
  if (manifest.platform === "linux") {
    run("systemctl", ["--user", "disable", "--now", unit], { env: serviceEnv() });
    // Do not remove code while the service is still active or deactivating.
    const state = run("systemctl", ["--user", "show", "--property=ActiveState", "--value", unit], { env: serviceEnv() });
    if (!["inactive", "failed"].includes(state)) throw new Error("Service has not stopped");
  } else {
    const target = `gui/${process.getuid()}/${label}`;
    const active = spawnSync("launchctl", ["print", target], { stdio: "ignore" });
    if (active.status === 0) run("launchctl", ["bootout", target]);
    if (spawnSync("launchctl", ["print", target], { stdio: "ignore" }).status === 0) throw new Error("LaunchAgent is still loaded");
  }
  unlinkSync(definition.path);
  if (manifest.platform === "linux") run("systemctl", ["--user", "daemon-reload"], { env: serviceEnv() });
}
export function inventory(root, relative) {
  const path = join(root, relative), stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return [relative];
  return readdirSync(path).flatMap(name => inventory(root, join(relative, name))).concat(relative);
}
export function removeInventory(root, files) {
  for (const relative of files) {
    if (!/^components(\/|$)/.test(relative) || relative.split("/").includes("..")) throw new Error("Invalid component inventory");
    const path = join(root, relative);
    // Never follow a directory replaced by a symlink outside the installation.
    try {
      if (realpathSync(dirname(path)) !== dirname(path)) throw new Error("Component parent path changed; cleanup stopped");
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        try { rmdirSync(path); } catch (error) { if (error.code !== "ENOTEMPTY") throw error; }
      } else unlinkSync(path);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
