import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** flock owns an OS lock; stdin EOF releases it after supervisor death, without PID-file stale detection. */
export async function acquireLock(directory: string, onLost: () => void): Promise<() => Promise<void>> {
  if (process.platform !== "linux") throw new Error("MVP requires Linux and util-linux flock");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const child = spawn("flock", ["--exclusive", "--nonblock", "--conflict-exit-code", "73",
    join(directory, "service.lock"), process.execPath, "-e",
    'process.stdout.write("locked\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0));'],
  { stdio: ["pipe", "pipe", "ignore"] });
  let releasing = false, acquired = false;
  const closed = new Promise<void>(resolve => child.once("close", () => { if (acquired && !releasing) onLost(); resolve(); }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Process lock timed out")); }, 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); if (!acquired) reject(new Error("State directory is locked or flock is unavailable")); });
    child.stdout.once("data", chunk => {
      clearTimeout(timer);
      if (String(chunk).trim() !== "locked") { reject(new Error("Invalid process lock response")); child.stdin.end(); return; }
      acquired = true; resolve();
    });
  });
  return async () => { releasing = true; child.stdin.end(); await closed; };
}
