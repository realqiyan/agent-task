import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { controlService } from "../dist/integrations/local-service/control.js";

const json = path => JSON.parse(readFileSync(path, "utf8"));
const bundle = resolve("hosts/agent-task");

test("host catalogs resolve one self-contained bundle and the same native MCP entry", () => {
  const claudeCatalog = json(".claude-plugin/marketplace.json");
  const codexCatalog = json(".agents/plugins/marketplace.json");
  assert.equal(resolve(claudeCatalog.plugins[0].source), bundle);
  assert.equal(resolve(codexCatalog.plugins[0].source.path), bundle);
  const claude = json(join(bundle, ".claude-plugin/plugin.json"));
  const codex = json(join(bundle, ".codex-plugin/plugin.json"));
  const pkg = json("package.json");
  for (const manifest of [claude, codex]) {
    assert.equal(manifest.name, "agent-task");
    assert.equal(manifest.version, pkg.version);
  }
  for (const manifest of [claude, codex]) assert.equal(resolve(bundle, manifest.mcpServers), join(bundle, "mcp.json"));
  assert(existsSync(resolve(bundle, codex.extensions["com.openai"].onboardingSkill)));
  for (const path of json(join(bundle, "package.json")).pi.skills) assert(existsSync(resolve(bundle, path)));
  assert.deepEqual(json(join(bundle, "mcp.json")), {
    mcpServers: { "agent-task": { type: "stdio", command: "agent-task", args: ["mcp"] } },
  });
});

test("standalone host tarball installs offline without the service or runtime dependencies", { timeout: 30_000 }, t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-host-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = JSON.parse(execFileSync(process.execPath, [resolve("scripts/pack-hosts.mjs"), root], {
    encoding: "utf8", timeout: 15_000,
  }));
  const prefix = join(root, "install");
  execFileSync("npm", ["install", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", artifact.filename], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: root, npm_config_cache: join(root, "cache") },
  });
  const installed = join(prefix, "node_modules/@realqiyan/agent-task-hosts");
  assert.equal(json(join(installed, "package.json")).version, json("package.json").version);
  assert(!existsSync(join(prefix, "node_modules/@realqiyan/agent-task")));
  assert(!existsSync(join(installed, "node_modules")));
  const manifest = json(join(installed, ".codex-plugin/plugin.json"));
  assert(existsSync(resolve(installed, manifest.extensions["com.openai"].onboardingSkill)));
  assert.deepEqual(json(join(installed, manifest.mcpServers)), json(join(bundle, "mcp.json")));
});

test("bundled stdio command uses setup and calls existing tools without credentials in host config", { timeout: 30_000 }, async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-hosts-"));
  const bin = join(root, "bin"), user = join(root, "user");
  for (const path of [bin, user]) mkdirSync(path, { mode: 0o700 });
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(resolve("bin/agent-task.mjs"), join(bin, "agent-task"));
  // Discovery only: this real failing program is never used for ACP work.
  symlinkSync("/usr/bin/false", join(bin, "opencode"));
  const env = { PATH: bin, HOME: user };
  const home = process.platform === "darwin" ? join(user, "Library/Application Support/agent-task") : join(user, ".local/share/agent-task");
  const client = new Client({ name: "agent-task-host-config-test", version: "1.0.0" });
  let connected = false;
  t.after(async () => {
    await client.close();
    try { await controlService(home, "stop", 8000); }
    catch (error) { if (error.kind !== "unreachable") throw error; }
    if (connected) rmSync(root, { recursive: true, force: true });
    else t.diagnostic("Failed host connection evidence retained at " + root);
  });
  execFileSync(process.execPath, [resolve("bin/agent-task.mjs"), "setup", "--home", home, "--data-dir", join(home, "data"), "--port", "0", "--generate-tokens", "--yes"], {
    cwd: root, env, stdio: "pipe", timeout: 10_000,
  });
  const configPath = join(home, "data/config.json");
  writeFileSync(configPath, JSON.stringify({ ...json(configPath), disabledExecutors: ["pi", "codex", "claude"] }), { mode: 0o600 });
  const { command, args } = json(join(bundle, "mcp.json")).mcpServers["agent-task"];
  const transport = new StdioClientTransport({ command, args, cwd: root, env, stderr: "pipe" });
  await client.connect(transport, { timeout: 15_000 });
  const tools = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ["executor_list", "task_list", "task_create", "task_get", "task_run_list"]) assert(tools.includes(name));
  for (const name of ["executor_list", "task_list"]) {
    const result = await client.callTool({ name, arguments: {} });
    assert.equal(result.isError, false);
    assert(result.structuredContent);
  }
  connected = true;
  await client.close();
  assert((await controlService(home, "status")).instanceId);
});
