import { spawnSync } from "node:child_process";
import { DatabaseSync } from "../dist/infrastructure/sqlite.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, readdirSync, unlinkSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { dirname, join, resolve, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const packageRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

export const packages = {
  pi: ["@earendil-works/pi-coding-agent@1.3.0", "pi-acp@0.0.34"],
  codex: ["@agentclientprotocol/codex-acp@2.2.2"],
  claude: ["@zed-industries/claude-agent-acp@0.23.1"],
  opencode: ["opencode-ai@1.19.3"],
};
export function argumentsFor(argv) {
  const flags = new Set(["check", "probe", "resume", "help"]), options = {};
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
  catch { db.close(); throw new Error("Another setup operation owns this installation"); }
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
export function inventory(root, relative) {
  const path = join(root, relative), stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return [relative];
  return readdirSync(path).flatMap(name => inventory(root, join(relative, name))).concat(relative);
}
