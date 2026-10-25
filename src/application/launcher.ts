import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { acquireLauncherLock } from "../infrastructure/lock.js";
import { version } from "../infrastructure/version.js";
import { prepareStartup } from "./startup.js";
import { startupPaths } from "../configuration/files.js";
import type { Ready } from "../integrations/local-service/control.js";

type Message = { type: string; ready?: Ready; error?: string };
function message(child: ChildProcess, type: string, timeout = 30_000): Promise<Message> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); child.off("message", receive); child.off("exit", exit); child.off("error", fail); };
    const fail = () => { cleanup(); reject(new Error("Service process failed before " + type)); };
    const exit = () => fail();
    const receive = (value: Message) => { if (value.type === type) { cleanup(); resolve(value); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Service timed out before " + type)); }, timeout);
    child.on("message", receive); child.once("exit", exit); child.once("error", fail);
  });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function health(ready: Ready, token: string): Promise<void> {
  const response = await fetch(ready.url, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "service_status", arguments: {} } }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json() as { result?: { structuredContent?: { data?: { running?: boolean } } } };
  if (!response.ok || !body.result?.structuredContent?.data?.running) throw new Error("Authenticated health check failed");
}
function removeSocket(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid!()) throw new Error("Refusing to remove an unowned control socket path");
  unlinkSync(path);
}
function logFile(path: string): number {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) { closeSync(fd); throw new Error("Invalid private log file"); }
  return fd;
}

/** Stable owner for foreground and service managers. Only explicit requests restart a child. */
export async function launch(home: string, nativeEnvironment: NodeJS.ProcessEnv): Promise<void> {
  process.umask(0o077);
  startupPaths(home); // Also checks private ownership of the locator.
  const unlock = await acquireLauncherLock(home);
  const socket = join(home, "control.sock"), children = new Set<ChildProcess>();
  let current: ChildProcess | undefined, ready: { info: Ready; token: string } | undefined, restarting = true, closing = false;
  let shutting: Promise<void> | undefined;
  let release!: () => void;
  const finished = new Promise<void>(resolve => { release = resolve; });
  const control = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || !["/status", "/restart", "/stop"].includes(req.url ?? "")) { res.writeHead(404).end(); return; }
      if (req.url === "/stop") {
        await shutdown(true);
        res.setHeader("Content-Type", "application/json"); res.setHeader("Connection", "close");
        res.end(JSON.stringify({ stopped: true })); return;
      }
      const result = req.url === "/restart" ? await restart() : await status();
      res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(result));
    } catch { res.writeHead(503).end(JSON.stringify({ error: "Service unavailable; inspect private logs and startup files" })); }
  });
  const shutdown = (drain = false): Promise<void> => {
    if (shutting) return shutting;
    closing = true;
    return shutting = (async () => {
      control.close();
      if (!drain) control.closeAllConnections();
      await Promise.all([...children].map(stop));
      try { removeSocket(socket); } finally { unlock(); release(); }
    })();
  };
  const signal = () => { void shutdown(); };
  const hangup = () => {}; // A detached launcher survives the originating terminal closing.
  process.on("SIGINT", signal); process.on("SIGTERM", signal);
  process.on("SIGHUP", hangup);
  const start = async (): Promise<Ready> => {
    const inputs = await prepareStartup(home);
    if (closing) throw new Error("Launcher is closing");
    const log = logFile(join(inputs.dataDir, "service.log"));
    const child = fork(fileURLToPath(new URL("./main.js", import.meta.url)),
      ["--config", inputs.configPath, "--environment", inputs.environmentPath], {
        env: { ...nativeEnvironment, AGENT_TASK_INSTANCE_ID: randomUUID(), AGENT_TASK_INSTALL_HOME: home }, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    children.add(child);
    const output = (chunk: Buffer) => { appendFileSync(log, chunk); process.stdout.write(chunk); };
    child.stdout!.on("data", output); child.stderr!.on("data", output);
    child.once("close", () => {
      closeSync(log); children.delete(child);
      if (current === child && !restarting && !closing) { ready = undefined; process.exitCode = 1; void shutdown(); }
    });
    child.on("message", (value: Message) => {
      if (value.type !== "restart") return;
      if (child !== current || restarting || closing) { child.send({ type: "restarted", error: "Restart already in progress or unavailable" }, () => {}); return; }
      void restart(child).then(value => {
        if (child.connected) child.send({ type: "restarted", ready: value }, () => {});
      }, () => {
        if (child.connected) child.send({ type: "restarted", error: "Restart failed; inspect private logs and use CLI restart after correcting startup files" }, () => {});
      });
    });
    try {
      const value = { ...(await message(child, "ready")).ready!, launcherVersion: version };
      await health(value, inputs.environment[inputs.config.tokenEnv]!);
      current = child; ready = { info: value, token: inputs.environment[inputs.config.tokenEnv]! };
      return value;
    } catch (error) { await stop(child); throw error; }
  };
  const status = async (): Promise<Ready> => {
    if (!ready || restarting || closing) throw new Error("Service unavailable");
    // Saved inputs may need repair. Health belongs to the running instance,
    // including the credential with which that instance actually started.
    const running = ready;
    await health(running.info, running.token);
    return running.info;
  };
  const restart = async (requester?: ChildProcess): Promise<Ready> => {
    if (restarting || closing) throw new Error("Restart already in progress or closed");
    restarting = true;
    const old = current;
    try {
      if (old) {
        const drained = message(old, "drained");
        old.send({ type: "drain" });
        let result: Message;
        try { result = await drained; }
        catch (error) { current = undefined; ready = undefined; await stop(old); throw error; }
        if (result.error) throw new Error(result.error);
        current = undefined; ready = undefined;
        // Keep only the authenticated Web response alive until the new process is verified.
        if (old !== requester) await stop(old);
      }
      const value = await start();
      return value;
    } finally {
      restarting = false;
      if (requester && requester !== current) {
        const timer = setTimeout(() => { void stop(requester); }, 5000);
        requester.once("close", () => clearTimeout(timer));
      }
    }
  };
  try {
    removeSocket(socket); // Stale socket only, under exclusive launcher ownership.
    await new Promise<void>((resolve, reject) => { control.once("error", reject); control.listen(socket, resolve); });
    chmodSync(socket, 0o600);
    await start();
    restarting = false;
    await finished;
  } finally {
    await shutdown();
    process.off("SIGINT", signal); process.off("SIGTERM", signal);
    process.off("SIGHUP", hangup);
  }
}
