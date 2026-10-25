import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLauncherLock } from "../dist/infrastructure/lock.js";

test("SQLite loads quietly while other runtime warnings remain visible", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    const original = process.emitWarning;
    const { openCoordinatorStorage } = await import("./dist/integrations/coordinator/storage.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "agent-task-sqlite-notice-"));
    try {
      const storage = await openCoordinatorStorage(root, "00000000-0000-4000-8000-000000000001");
      await storage.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
    const { DatabaseSync } = await import("./dist/infrastructure/sqlite.js");
    assert.equal(process.emitWarning, original);
    const db = new DatabaseSync(":memory:");
    assert.equal(db.prepare("SELECT 1 AS value").get().value, 1);
    db.close();
    process.emitWarning("unrelated experimental notice", "ExperimentalWarning");
    process.emitWarning("unrelated runtime notice");
  `], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_NO_WARNINGS: "" } });
  assert.equal(result.status, 0, result.stderr);
  assert(!result.stderr.includes("SQLite is an experimental feature"));
  assert.match(result.stderr, /ExperimentalWarning: unrelated experimental notice/);
  assert.match(result.stderr, /Warning: unrelated runtime notice/);
});

test("simultaneous launchers elect one owner of a new SQLite lock and release ownership on death", { timeout: 10_000 }, async t => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-launcher-lock-")), peers = [];
  t.after(async () => {
    for (const peer of peers) peer.child.kill("SIGKILL");
    await Promise.all(peers.map(peer => peer.closed));
    rmSync(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < 4; i++) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { acquireLauncherLock } from "./dist/infrastructure/lock.js";
      process.once("message", async () => {
        try {
          const release = await acquireLauncherLock(process.argv[1]);
          process.once("disconnect", release); process.send({ locked: true });
        }
        catch { process.send({ locked: false }); }
      });
      process.send({ ready: true });
    `, directory], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const closed = new Promise(resolve => child.once("close", resolve));
    const ready = new Promise((resolve, reject) => {
      child.once("message", resolve); child.once("error", reject);
      child.once("exit", () => reject(new Error("Launcher exited before the start barrier")));
    });
    peers.push({ child, closed, ready });
  }
  await Promise.all(peers.map(peer => peer.ready));
  const results = peers.map(peer => new Promise(resolve => peer.child.once("message", resolve)));
  for (const peer of peers) peer.child.send("start");
  const owners = (await Promise.all(results)).map((result, index) => result.locked ? index : -1).filter(index => index >= 0);
  assert.equal(owners.length, 1);
  await assert.rejects(acquireLauncherLock(directory), /Another launcher/);
  peers[owners[0]].child.kill("SIGKILL"); await peers[owners[0]].closed;
  const release = await acquireLauncherLock(directory); release(); release();
});
