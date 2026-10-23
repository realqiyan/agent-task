import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { LocalExecutors } from "../dist/integrations/acp/discovery.js";
import { ExecutorRegistry } from "../dist/executors/registry.js";
import { acquireLock } from "../dist/infrastructure/lock.js";

function fixture(t, cached = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-discovery-"));
  const bin = join(root, "bin"), adapters = join(root, "adapters");
  mkdirSync(bin, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = realpathSync("/usr/bin/false");
  symlinkSync(binary, join(bin, "pi"));
  const current = join(adapters, "pi", "current.json");
  if (cached) {
    // Stored metadata and a real failing executable exercise file ownership and reuse, not successful ACP execution.
    const directory = "installation-" + randomUUID(), installation = join(adapters, "pi", directory);
    const pkg = join(installation, "node_modules", "pi-acp");
    mkdirSync(pkg, { recursive: true, mode: 0o700 });
    mkdirSync(join(installation, "node_modules/.bin"), { mode: 0o700 });
    copyFileSync(binary, join(pkg, "runner"));
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pi-acp", version: "1.0.0" }), { mode: 0o600 });
    symlinkSync("../pi-acp/runner", join(installation, "node_modules/.bin/pi-acp"));
    writeFileSync(current, JSON.stringify({ version: "1.0.0", directory }), { mode: 0o600 });
  }
  return { root, bin, adapters, current, binary, discovery: new LocalExecutors(adapters, { PATH: bin, HOME: root }) };
}

test("discovery separates a native CLI from its adapter and never installs a missing native CLI", async t => {
  const f = fixture(t);
  const states = f.discovery.discover().states;
  assert.equal(states.find(item => item.type === "pi").nativePath, f.binary);
  assert.equal(states.find(item => item.type === "pi").state, "missing");
  assert.equal(states.find(item => item.type === "codex").nativePath, null);
  assert.equal(existsSync(f.adapters), false);
  await assert.rejects(f.discovery.install("codex", false, new AbortController().signal), /Native CLI is not installed/);
  assert.equal(existsSync(f.adapters), false);
  const disabled = new ExecutorRegistry([], f.discovery, ["pi"]);
  assert.equal(disabled.refresh().executors.find(item => item.type === "pi").state, "disabled");
  await disabled.close();
  assert.equal(existsSync(f.adapters), false);
});

test("cached adapters are reused offline and failed explicit upgrades preserve the published installation", async t => {
  const f = fixture(t, true), before = readFileSync(f.current, "utf8");
  const cached = f.discovery.discover().executors[0];
  assert.deepEqual(await f.discovery.install("pi", false, new AbortController().signal), cached);
  await assert.rejects(f.discovery.install("pi", true, new AbortController().signal), /npm is required/);
  symlinkSync(f.binary, join(f.bin, "npm"));
  await assert.rejects(f.discovery.install("pi", true, new AbortController().signal), /installation failed/);
  assert.equal(readFileSync(f.current, "utf8"), before);
  assert.deepEqual(f.discovery.discover().executors[0], cached);
  f.discovery.check(cached);
});

test("closing discovery consumers cancels concurrent lock waiters without releasing another owner's lock", async t => {
  const f = fixture(t, true), typeRoot = join(f.adapters, "pi");
  const unlock = await acquireLock(typeRoot);
  const registry = new ExecutorRegistry([], f.discovery), controller = new AbortController();
  try {
    registry.upgrade("pi");
    const other = new LocalExecutors(f.adapters, { PATH: f.bin, HOME: f.root });
    const pending = other.install("pi", true, controller.signal);
    const rejected = assert.rejects(pending);
    await delay(30);
    assert.equal(registry.list().executors.find(item => item.type === "pi").state, "installing");
    controller.abort(); await rejected;
    await registry.close();
    await assert.rejects(acquireLock(typeRoot), /locked/);
    assert.throws(() => registry.refresh(), /closed/);
  } finally { controller.abort(); await registry.close(); await unlock(); }
  const release = await acquireLock(typeRoot); await release();
  assert.equal(f.discovery.discover().states.find(item => item.type === "pi").state, "ready");
});
