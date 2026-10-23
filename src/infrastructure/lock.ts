import { DatabaseSync } from "./sqlite.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** The stable installation lock prevents two launchers during a directory switch. */
export async function acquireLauncherLock(home: string): Promise<() => void> {
  const deadline = Date.now() + 1500;
  for (;;) {
    const db = new DatabaseSync(join(home, "launcher-lock.sqlite"));
    try { db.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE"); }
    catch (error) {
      db.close();
      const code = (error as { errcode?: number }).errcode;
      if (code !== 5 && code !== 6) throw new Error("Cannot acquire launcher ownership; inspect the installation filesystem", { cause: error });
      if (Date.now() >= deadline) throw new Error("Another launcher owns this installation", { cause: error });
      // On a new SQLite file, concurrent readers can all lose the first exclusive-lock attempt.
      // Release each failed connection and stagger retries before any service work starts.
      await delay(25 + Math.floor(Math.random() * 25));
      continue;
    }
    let released = false;
    return () => { if (!released) { db.close(); released = true; } };
  }
}

/** A dedicated SQLite transaction owns an OS lock until close or process death.
 * Local filesystems only. Never unlink this file: that would create a second lock identity.
 */
export async function acquireLock(directory: string): Promise<() => Promise<void>> {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Supported platforms: Linux and macOS");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "service-lock.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    throw new Error("State directory is locked or its filesystem does not support SQLite locking", { cause: error });
  }
  let released = false;
  return async () => {
    if (released) return;
    db.close(); released = true;
  };
}
