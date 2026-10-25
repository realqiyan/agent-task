import { DatabaseSync } from "../dist/infrastructure/sqlite.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, unlinkSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { dirname, join, resolve, isAbsolute, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const packageRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

export function argumentsFor(argv) {
  const flags = new Set(["check", "json", "resume", "help", "yes", "generate-tokens"]), options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || key in options) throw new Error("Invalid or repeated option");
    if (flags.has(key)) options[key] = true;
    else if (["home", "data-dir", "provider", "model", "port", "token-env", "credentials-file", "base-url", "api", "api-key-env", "context-window", "max-tokens", "backup"].includes(key) && argv[i + 1] && !argv[i + 1].startsWith("--")) options[key] = argv[++i];
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
export function operationLock(root) {
  const db = new DatabaseSync(join(root, "setup-lock.sqlite"));
  try { db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
  catch { db.close(); throw new Error("Another setup operation owns this installation"); }
  return () => db.close();
}
export function readManifest(root, allowMigration = false) {
  if (realpathSync(root) !== root || lstatSync(root).uid !== process.getuid() || (lstatSync(root).mode & 0o077)) throw new Error("Installation home must be canonical, owned and private");
  const value = json(join(root, "installation.json"));
  if (value.project !== "agent-task" || value.root !== root || value.platform !== process.platform || value.home !== homedir() || typeof value.node !== "string" || !isAbsolute(value.node) || value.app !== packageRoot) throw new Error("Installation ownership does not match this user/platform");
  if (!allowMigration && existsSync(join(root, "migration.json")) && json(join(root, "migration.json")).phase !== "completed") {
    throw new Error("数据迁移未完成；请保持停服，核查备份后运行 agent-task migrate --resume --yes（使用相同 --home）");
  }
  return value;
}
export function saveManifest(root, manifest) {
  // Preserve the last committed initialization record if a write fails.
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
  return { ...process.env, HOME: manifest.home, PATH: [process.env.PATH ?? "", dirname(manifest.node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(":"), LANG: process.env.LANG ?? "en_US.UTF-8" };
}
