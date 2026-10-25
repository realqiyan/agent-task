import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, openSync, closeSync, mkdirSync, readFileSync, realpathSync,
  writeFileSync, fsyncSync, renameSync, unlinkSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Executor, ExecutorStatus, ExecutorType } from "../../executors/model.js";
import type { ExecutorDiscovery } from "../../executors/ports.js";
import { acquireLock } from "../../infrastructure/lock.js";
import { checkDataDirectory, readPrivateText } from "../../infrastructure/private-files.js";
import { FileCommitError } from "../../shared/errors.js";
import { checkExecutable, checkLaunchDirectory, findExecutable } from "./runtime.js";

const types: ExecutorType[] = ["pi", "codex", "claude", "opencode"];
const adapters = {
  pi: { package: "pi-acp", bin: "pi-acp" },
  codex: { package: "@agentclientprotocol/codex-acp", bin: "codex-acp" },
  claude: { package: "@agentclientprotocol/claude-agent-acp", bin: "claude-agent-acp" },
} as const;
type AdapterType = keyof typeof adapters;
type Installation = { version: string; directory: string };
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const directoryPattern = /^installation-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

/** Owns managed adapter files. Discovery never installs a native CLI or starts an agent. */
export class LocalExecutors implements ExecutorDiscovery {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly installing = new Map<ExecutorType, Promise<Executor>>();

  constructor(private readonly adaptersRoot: string, nativeEnvironment: NodeJS.ProcessEnv) {
    checkDataDirectory(adaptersRoot);
    this.environment = { ...nativeEnvironment };
  }

  discover(): { executors: Executor[]; states: ExecutorStatus[] } {
    const executors: Executor[] = [], states: ExecutorStatus[] = [];
    for (const type of types) {
      const nativePath = this.nativePath(type);
      const state: ExecutorStatus = { id: type, type, nativePath, state: "missing", adapterVersion: null, error: null };
      try {
        const executor = nativePath ? this.installed(type, nativePath) : null;
        if (executor) {
          executors.push(executor);
          state.state = "ready";
          state.adapterVersion = executor.adapterVersion;
        }
      } catch {
        state.state = "error";
        state.error = "Managed ACP adapter is invalid; explicitly upgrade this executor to replace it";
      }
      if (this.installing.has(type)) state.state = "installing";
      states.push(state);
    }
    return { executors, states };
  }

  install(type: ExecutorType, upgrade: boolean, signal: AbortSignal): Promise<Executor> {
    const pending = this.installing.get(type);
    if (pending) return pending;
    const installation = this.prepare(type, upgrade, signal).finally(() => { this.installing.delete(type); });
    this.installing.set(type, installation);
    return installation;
  }

  check(executor: Executor): void {
    if (executor.type === "custom") {
      if (executor.command !== executor.nativePath || executor.adapterVersion !== null) throw new Error("Invalid custom ACP launch");
      checkExecutable(executor.command);
      if (executor.cwd !== undefined) checkLaunchDirectory(executor.cwd);
      return;
    }
    if (executor.id !== executor.type || !types.includes(executor.type) || this.nativePath(executor.type) !== executor.nativePath) {
      throw new Error("Native executor is missing or changed");
    }
    checkExecutable(executor.nativePath);
    if (executor.type === "opencode") {
      if (executor.command !== executor.nativePath || executor.adapterVersion !== null ||
        executor.args.length !== 1 || executor.args[0] !== "acp") throw new Error("Invalid OpenCode launch");
    } else {
      const typeRoot = join(this.adaptersRoot, executor.type);
      const directory = relative(typeRoot, executor.command).split("/")[0];
      if (!directory || !directoryPattern.test(directory) || !executor.adapterVersion || executor.args.length) {
        throw new Error("Invalid managed ACP launch");
      }
      const expected = this.adapter(executor.type, executor.nativePath, { directory, version: executor.adapterVersion });
      if (expected.command !== executor.command) throw new Error("Managed ACP executable changed");
    }
    checkExecutable(executor.command);
  }

  private nativePath(type: ExecutorType): string | null {
    return findExecutable(type, this.environment, this.adaptersRoot);
  }

  private installed(type: ExecutorType, nativePath: string): Executor | null {
    if (type === "opencode") return { id: type, type, nativePath, command: nativePath, args: ["acp"], adapterVersion: null };
    const path = join(this.adaptersRoot, type, "current.json");
    if (!lstatSync(path, { throwIfNoEntry: false })) return null;
    let value: unknown;
    try { value = JSON.parse(readPrivateText(path)); }
    catch { throw new Error("Invalid adapter installation record"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid adapter installation record");
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.version !== "string" || typeof record.directory !== "string" ||
      !versionPattern.test(record.version) || !directoryPattern.test(record.directory)) throw new Error("Invalid adapter installation record");
    return this.adapter(type, nativePath, { version: record.version, directory: record.directory });
  }

  private adapter(type: AdapterType, nativePath: string, installation: Installation): Executor {
    const root = join(this.adaptersRoot, type, installation.directory);
    checkDataDirectory(root);
    const entry = adapters[type];
    const packageRoot = join(root, "node_modules", entry.package);
    if (realpathSync(packageRoot) !== packageRoot) throw new Error("Invalid managed ACP package directory");
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (metadata.name !== entry.package || metadata.version !== installation.version) throw new Error("Managed ACP package version changed");
    const command = realpathSync(join(root, "node_modules/.bin", entry.bin));
    if (!command.startsWith(packageRoot + "/")) throw new Error("Managed ACP executable is outside its package");
    checkExecutable(command);
    return { id: type, type, nativePath, command, args: [], adapterVersion: installation.version };
  }

  private async prepare(type: ExecutorType, upgrade: boolean, requestedSignal: AbortSignal): Promise<Executor> {
    const signal = AbortSignal.any([requestedSignal, AbortSignal.timeout(300_000)]);
    signal.throwIfAborted();
    const nativePath = this.nativePath(type);
    if (!nativePath) throw new Error("Native CLI is not installed: " + type);
    if (type === "opencode") return this.installed(type, nativePath)!;
    if (!upgrade) {
      const existing = this.installed(type, nativePath);
      if (existing) return existing;
    }
    checkDataDirectory(this.adaptersRoot);
    mkdirSync(this.adaptersRoot, { recursive: true, mode: 0o700 });
    const root = join(this.adaptersRoot, type);
    checkDataDirectory(root);
    mkdirSync(root, { mode: 0o700, recursive: true });
    const unlock = await this.lock(root, signal);
    try {
      if (!upgrade) {
        const existing = this.installed(type, nativePath);
        if (existing) return existing;
      }
      const npm = findExecutable("npm", this.environment);
      if (!npm) throw new Error("npm is required to install ACP adapters");
      const entry = adapters[type];
      const versionText = await this.npm(npm, ["view", entry.package + "@latest", "version", "--json"], root, signal, true);
      let version: unknown;
      try { version = JSON.parse(versionText); } catch { throw new Error("Registry did not return an ACP adapter version"); }
      if (typeof version !== "string" || version.length > 100 || !versionPattern.test(version)) throw new Error("Registry returned an invalid ACP adapter version");
      const installation = { version, directory: "installation-" + randomUUID() };
      const directory = join(root, installation.directory);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true }) + "\n", { flag: "wx", mode: 0o600 });
      await this.npm(npm, ["install", "--global=false", "--prefix", directory, "--save-prod", "--save-exact",
        "--package-lock=true", "--ignore-scripts", "--no-audit", "--no-fund", entry.package + "@" + version], directory, signal);
      signal.throwIfAborted();
      const executor = this.adapter(type, nativePath, installation);
      this.check(executor);
      signal.throwIfAborted();
      this.publish(join(root, "current.json"), installation);
      return executor;
    } catch (error) {
      if (signal.aborted) throw new Error("ACP adapter installation was cancelled or timed out");
      if (error instanceof FileCommitError && error.uncertain) {
        throw new Error("ACP adapter publication could not be confirmed; inspect executor status before retrying");
      }
      // Never include npm diagnostics or parser excerpts in an API response.
      if (error instanceof Error && /^(npm is required|Registry (did not return|returned)|Native executor is missing)/.test(error.message)) throw error;
      throw new Error("ACP adapter installation failed; previous installed adapter was preserved");
    } finally { await unlock(); }
  }

  private async lock(root: string, signal: AbortSignal): Promise<() => Promise<void>> {
    for (;;) {
      signal.throwIfAborted();
      try { return await acquireLock(root); }
      catch (error) {
        const code = (error as { cause?: { errcode?: number } }).cause?.errcode;
        if (code !== 5 && code !== 6) throw new Error("Could not acquire ACP adapter installation ownership");
        await delay(100, undefined, { signal });
      }
    }
  }

  private npm(command: string, args: string[], cwd: string, signal: AbortSignal, capture = false): Promise<string> {
    signal.throwIfAborted();
    const env = Object.fromEntries(["HOME", "PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"].flatMap(key =>
      this.environment[key] === undefined ? [] : [[key, this.environment[key]]])) as NodeJS.ProcessEnv;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", bytes = 0, failed = false;
      const stop = () => {
        failed = true;
        if (child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* Wait for process close before releasing installation ownership. */ }
        }
      };
      const receive = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.length;
        if (bytes > 1_048_576) stop();
        else if (capture && stdout) output += chunk.toString("utf8");
      };
      child.stdout.on("data", (chunk: Buffer) => receive(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => receive(chunk, false));
      child.once("error", () => { failed = true; });
      signal.addEventListener("abort", stop, { once: true });
      child.once("close", code => {
        signal.removeEventListener("abort", stop);
        if (failed || signal.aborted || code !== 0) reject(new Error("npm operation failed"));
        else resolve(output.trim());
      });
      if (signal.aborted) stop();
    });
  }

  private publish(path: string, installation: Installation): void {
    const temporary = join(dirname(path), ".current-" + randomUUID() + ".tmp");
    let fd: number | undefined, published = false;
    try {
      if (lstatSync(path, { throwIfNoEntry: false })) readPrivateText(path);
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify(installation) + "\n"); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path); published = true;
      const directory = openSync(dirname(path), constants.O_RDONLY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch { throw new FileCommitError(published); }
    finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
