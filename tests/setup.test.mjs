import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";

test("real terminal setup requires confirmation, confirms directories and port, creates private tokens and defers executor discovery", { timeout: 20000 }, async t => {
  if (!["linux", "darwin"].includes(process.platform)) { t.skip(`PTY validation is unavailable on ${process.platform}`); return; }
  const env = Object.fromEntries(["PATH", "HOME", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const probe = spawnSync("script", process.platform === "linux" ? ["-q", "-e", "-c", "true", "/dev/null"]
    : ["-q", "/dev/null", "/usr/bin/true"], { env, encoding: "utf8", timeout: 5000 });
  if (probe.error || probe.status !== 0) { t.skip("The script utility cannot open a PTY in this environment"); return; }
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-wizard-")), cli = resolve("bin/agent-task.mjs");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "private");
  const noninteractive = spawnSync(process.execPath, [cli, "setup", "--home", home], { cwd: root, env, encoding: "utf8", timeout: 5000 });
  assert.notEqual(noninteractive.status, 0);
  assert(!existsSync(home), "Missing noninteractive inputs must not create configuration");
  async function wizard(confirm, target = home, key) {
    const command = [process.execPath, cli, "setup", "--home", target];
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const args = process.platform === "linux" ? ["-q", "-e", "-c", command.map(quote).join(" "), "/dev/null"]
      : ["-q", "/dev/null", ...command];
    const child = spawn("script", args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", pending = "";
    const answers = [target, join(target, "data"), "8765", "AGENT_TASK_TOKEN", "generate",
      ...(key ? ["openai", "not-a-real-model"] : ["none"]), confirm, ...(key ? [key] : [])];
    child.stdout.on("data", data => {
      output += data; pending += data;
      if ((/: \x1b\[\d+G/.test(pending) || stripVTControlCharacters(pending).endsWith(": ")) && answers.length) {
        pending = ""; child.stdin.write(answers.shift() + "\n");
      }
    });
    child.stderr.on("data", data => { output += data; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 8000);
    try {
      const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
      assert.equal(answers.length, 0, "All terminal inputs must be consumed");
      return { code, output };
    } finally { clearTimeout(timeout); child.stdin.destroy(); }
  }
  await wizard("no");
  assert(!existsSync(home), "Declining confirmation must not write configuration");
  const result = await wizard("yes");
  assert.equal(result.code, 0);
  assert(!result.output.includes("SQLite is an experimental feature"));
  const config = JSON.parse(readFileSync(join(home, "data/config.json"), "utf8"));
  assert.deepEqual(config.disabledExecutors, []);
  const credentials = JSON.parse(readFileSync(join(home, "data/environment.json"), "utf8"));
  const values = Object.values(credentials);
  assert(values.length === 2 && values[0] !== values[1] && values.every(value => value.length >= 32));
  for (const value of values) assert(!result.output.includes(value), "Setup must not print credentials");
  const withProvider = join(root, "configured"), key = "setup-only-unused-coordinator-key";
  const configured = await wizard("yes", withProvider, key);
  assert.equal(configured.code, 0);
  const saved = JSON.parse(readFileSync(join(withProvider, "data/environment.json"), "utf8"));
  assert.equal(saved.OPENAI_API_KEY, key);
  for (const value of Object.values(saved)) assert(!configured.output.includes(value), "Hidden input and generated credentials must not echo");
});
