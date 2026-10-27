import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { configSchema } from "../configuration/contract.js";
import { readEnvironment, startupPaths } from "../configuration/files.js";
import { readPrivateText } from "../infrastructure/private-files.js";
import { controlService, ControlError } from "../integrations/local-service/control.js";
import type { Ready } from "../integrations/local-service/control.js";
import { serveStdio } from "../protocol/stdio.js";

async function startBackground(home: string): Promise<void> {
  const fd = openSync(join(home, "launcher.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid!() || (stat.mode & 0o077)) throw new Error("Expected a private launcher log");
    const child = spawn(process.execPath, [fileURLToPath(new URL("../../scripts/service-runner.mjs", import.meta.url)), home], {
      cwd: home, env: { ...process.env }, detached: true, stdio: ["ignore", fd, fd],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", () => reject(new Error("Cannot start background service; inspect the private launcher log")));
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  } finally { closeSync(fd); }
}

async function connectBackground(home: string): Promise<Ready> {
  const deadline = Date.now() + 40_000;
  let mayStart = true;
  while (Date.now() < deadline) {
    try { return await controlService(home, "status", 2000); }
    catch (error) {
      if (!(error instanceof ControlError) || error.kind === "invalid") throw error;
      if (error.kind === "unreachable" && mayStart) {
        mayStart = false;
        await startBackground(home);
      } else mayStart = false;
    }
    // Concurrent clients may launch together. The existing launcher lock selects one owner.
    await setTimeout(200);
  }
  throw new Error("Background service did not become ready; inspect the private launcher log and use task-conductor status. No restart was attempted");
}

/** The stdio connection owns neither the shared launcher nor persisted work. */
export async function runMcp(home: string): Promise<void> {
  const workspace = process.cwd();
  if (!existsSync(join(home, "launch.json"))) throw new Error("Task Conductor is not initialized; run task-conductor setup first");
  startupPaths(home);
  const ready = await connectBackground(home);
  const paths = startupPaths(home);
  let config: ReturnType<typeof configSchema.parse>;
  try { config = configSchema.parse(JSON.parse(readPrivateText(paths.configPath))); }
  catch { throw new Error("Cannot read service configuration; inspect the private startup files"); }
  const token = readEnvironment(paths.environmentPath)[config.tokenEnv];
  if (!token) throw new Error("Service credential is unavailable; inspect the private startup files");
  await serveStdio({ url: ready.url, token, workspace });
}
