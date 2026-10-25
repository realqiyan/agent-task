import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { LocalExecutors } from "../dist/integrations/acp/discovery.js";
import { ExecutorRegistry } from "../dist/executors/registry.js";
import { LocalCustomExecutorFiles } from "../dist/executors/files.js";
import { executorLaunch } from "../dist/integrations/acp/runtime.js";
import { spawnSync } from "node:child_process";
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

test("custom stdio registrations persist before admission, remain fixed in task snapshots and need no restart", async t => {
  const f = fixture(t), path = join(f.root, "custom-executors.json");
  const discovery = new LocalExecutors(f.adapters, { PATH: "/missing" });
  const open = () => new ExecutorRegistry([], discovery, [], new LocalCustomExecutorFiles(path));
  let registry = open();
  t.after(() => registry.close());
  const marker = join(f.root, "must-not-start");
  const entry = { id: "my-acp", command: realpathSync("/usr/bin/touch"), args: [marker], cwd: f.root };
  assert.throws(() => registry.register({ ...entry, id: "pi" }));
  assert.throws(() => registry.register({ ...entry, command: "/missing/acp" }));
  assert.throws(() => registry.register({ ...entry, command: "https://example.invalid/acp" }));
  assert.throws(() => registry.register({ ...entry, env: { TOKEN: "not-accepted" } }));
  const alias = join(f.root, "directory-alias"); symlinkSync(f.bin, alias);
  for (const cwd of ["relative", join(f.root, "missing"), entry.command, alias, null]) {
    assert.throws(() => registry.register({ ...entry, cwd }));
  }
  assert.equal(existsSync(path), false, "invalid registration must not be published");
  registry.register(entry);
  assert.equal(existsSync(marker), false, "registration must not launch even a real local command");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), [entry]);
  assert.equal(registry.list().executors.find(item => item.id === entry.id).state, "ready");
  assert.equal(registry.list().executors.find(item => item.id === entry.id).cwd, f.root);
  const snapshot = registry.snapshot([entry.id])[entry.id];
  entry.args.push("changed-by-caller");
  assert.deepEqual(registry.authorize(snapshot).args, [marker]);
  assert.throws(() => registry.register(entry), /already registered/);
  assert.throws(() => registry.upgrade(entry.id), /native installation channel/);
  registry.refresh();
  assert.deepEqual(registry.authorize(snapshot), snapshot);
  await registry.close();
  assert.throws(() => registry.register(entry), /closed/);
  registry = open();
  assert.deepEqual(registry.authorize(snapshot), snapshot);
  registry.unregister(entry.id);
  assert.throws(() => registry.authorize(snapshot), /not ready/);
  registry.register(entry);
  assert.throws(() => registry.authorize(snapshot), /assignment cannot be replaced/);
  assert.deepEqual(snapshot.args, [marker], "registration changes cannot rewrite stored task bindings");
  registry.unregister(entry.id);
  registry.register({ ...entry, args: [marker], cwd: f.bin });
  assert.throws(() => registry.authorize(snapshot), /assignment cannot be replaced/, "cwd alone is part of the task binding");
  registry.unregister(entry.id);
  await registry.close();
  registry = open();
  assert(!registry.list().executors.some(item => item.id === entry.id));

  // A real local process proves literal argv handling, not successful ACP execution.
  const command = realpathSync("/usr/bin/printf");
  registry.register({ id: "literal-argv", command, args: ["%s", "$(touch " + marker + ")"] });
  const launch = executorLaunch(registry.snapshot(["literal-argv"])["literal-argv"], { PATH: "/usr/bin:/bin" });
  const result = spawnSync(launch.command, launch.args, { env: launch.env, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "$(touch " + marker + ")");
  assert.equal(existsSync(marker), false, "arguments must not be interpreted by a shell");
});

test("custom registration storage changes fail closed and missing executables cannot dispatch", async t => {
  const f = fixture(t), path = join(f.root, "custom-executors.json");
  const command = join(f.root, "custom-acp");
  copyFileSync(f.binary, command);
  const registry = new ExecutorRegistry([], new LocalExecutors(f.adapters, { PATH: "/missing" }), [],
    new LocalCustomExecutorFiles(path));
  t.after(() => registry.close());
  const cwd = join(f.root, "startup"); mkdirSync(cwd);
  registry.register({ id: "custom", command, args: [], cwd });
  const snapshot = registry.snapshot(["custom"]).custom;
  rmSync(cwd, { recursive: true });
  assert.throws(() => registry.authorize(snapshot));
  assert.equal(registry.refresh().executors.find(item => item.id === "custom").state, "error");
  mkdirSync(cwd);
  registry.refresh();
  assert.deepEqual(registry.authorize(snapshot), snapshot);
  rmSync(command);
  assert.throws(() => registry.authorize(snapshot));
  assert.equal(registry.refresh().executors.find(item => item.id === "custom").state, "error");
  writeFileSync(path, "{}", { mode: 0o600 });
  assert.throws(() => registry.unregister("custom"), /changed outside/);
  assert.throws(() => registry.snapshot(["custom"]), /storage unavailable/);
  assert.equal(readFileSync(path, "utf8"), "{}", "out-of-band files must not be repaired or overwritten");
  assert.throws(() => new LocalCustomExecutorFiles(path).read(), /Cannot read/);
});

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
