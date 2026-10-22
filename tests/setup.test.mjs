import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";

test("real terminal setup requires confirmation, creates private tokens and leaves executors unauthorized", { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-wizard-")), cli = resolve("bin/agent-task.mjs");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(["PATH", "HOME", "LANG"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const home = join(root, "private");
  const noninteractive = spawnSync(process.execPath, [cli, "setup", "--home", home], { cwd: root, env, encoding: "utf8", timeout: 5000 });
  assert.notEqual(noninteractive.status, 0);
  assert(!existsSync(home), "Missing noninteractive inputs must not create configuration");
  async function wizard(confirm) {
    const command = [process.execPath, cli, "setup", "--home", home];
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const args = process.platform === "linux" ? ["-q", "-e", "-c", command.map(quote).join(" "), "/dev/null"]
      : ["-q", "/dev/null", ...command];
    const child = spawn("script", args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", pending = "";
    const answers = ["none", root, "none", "8765", "no", confirm];
    child.stdout.on("data", data => {
      output += data; pending += data;
      // Node 22 may append its asynchronous SQLite warning after the first prompt.
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
  const config = JSON.parse(readFileSync(join(home, "data/config.json"), "utf8"));
  assert.deepEqual(config.executors, []);
  const manifest = JSON.parse(readFileSync(join(home, "installation.json"), "utf8"));
  assert.equal(manifest.serviceInstalled, false);
  const credentials = JSON.parse(readFileSync(join(home, "data/environment.json"), "utf8"));
  const values = Object.values(credentials);
  assert(values.length === 2 && values[0] !== values[1] && values.every(value => value.length >= 32));
  for (const value of values) assert(!result.output.includes(value), "Setup must not print credentials");
});
