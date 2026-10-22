// Explicit, billable acceptance runner. Uses only the caller-approved DeepSeek test key.
import { realpathSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";

process.umask(0o077);
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!["--repeat", "--quantity", "--answer-file"].includes(args[i]) || !args[i + 1]) {
    throw new Error("Usage: npm run test:e2e:human -- [--repeat 1..5] [--quantity 1..9 | --answer-file NEW_PATH]");
  }
  options[args[i]] = args[i + 1];
}
const repeat = Number(options["--repeat"] ?? 1), quantity = Number(options["--quantity"] ?? 3);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5 || !Number.isInteger(quantity) || quantity < 1 || quantity > 9) throw new Error("Invalid repeat/quantity");
if (options["--answer-file"] && (repeat !== 1 || options["--quantity"])) throw new Error("Manual input requires one run and no fixture quantity");
if (!process.env.DEEPSEEK_API_KEY) throw new Error("Load DEEPSEEK_API_KEY in this shell first; never paste it into logs");
const locate = command => {
  try { return execFileSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new Error(`Missing ${command}. Install Pi and npm install -g pi-acp@0.0.34 --ignore-scripts before E2E`); }
};
const pi = locate("pi"), acp = locate("pi-acp");
const dir = mkdtempSync(join(realpathSync(tmpdir()), "agent-task-pi-human-"));
const home = join(dir, "home"), agent = join(home, ".pi", "agent");
mkdirSync(agent, { recursive: true, mode: 0o700 });
const settings = { defaultProvider: "deepseek", defaultModel: process.env.AGENT_TASK_E2E_MODEL || "deepseek-flash",
  defaultThinkingLevel: "off", defaultTools: ["read"], quietStartup: true, enableInstallTelemetry: false,
  retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false } };
writeFileSync(join(agent, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const nativeBin = join(dir, "native-bin"); mkdirSync(nativeBin, { mode: 0o700 });
symlinkSync(acp, join(nativeBin, "pi-acp"));
const wrapper = join(nativeBin, "pi");
writeFileSync(wrapper, `#!/bin/sh\nunset DEEPSEEK_API_KEY AGENT_TASK_E2E_TOKEN\nexec ${quote(pi)} --tools read --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-approve --offline "$@"\n`, { mode: 0o700 });
const profile = join(dir, "profile.json");
writeFileSync(profile, JSON.stringify({ id: "pi-e2e", type: "pi", note: "read-only acceptance", cwd: dir, unattendedApproved: true }), { mode: 0o600 });
console.log(`Private acceptance logs: ${dir}`);
console.log("Real models; billable. Native Pi read tool only (not an OS sandbox). Shared approved test key, not independent-account isolation.");
console.log(options["--answer-file"] ? `Manual answer file: ${resolve(options["--answer-file"])}` : `Human-role input source: declared fixture quantity=${quantity}`);
let child, killTimer, stopped = false;
const signalGroup = signal => {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
};
const stop = signal => {
  stopped = true; process.exitCode = 1;
  signalGroup(signal);
  killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 8000);
};
const onInt = () => stop("SIGINT"), onTerm = () => stop("SIGTERM");
process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
try {
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ deepseek: { type: "api_key", key: process.env.DEEPSEEK_API_KEY } }), { mode: 0o600 });
  for (let attempt = 1; attempt <= repeat; attempt++) {
    const fd = openSync(join(dir, `test-${attempt}.log`), "wx", 0o600);
    try {
      child = spawn(process.execPath, ["--test", "--test-concurrency=1", "tests/e2e/human-dag.test.mjs"], {
        detached: true,
        env: { PATH: nativeBin + ":" + process.env.PATH, LANG: process.env.LANG, HOME: home, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
          PI_CODING_AGENT_DIR: agent, PI_TELEMETRY: "0",
          AGENT_TASK_E2E_EXECUTOR: profile, AGENT_TASK_E2E_ALLOW_RESULT_READ: "1", AGENT_TASK_E2E_MODEL: settings.defaultModel,
          AGENT_TASK_E2E_QUANTITY: String(quantity),
          ...(options["--answer-file"] ? { AGENT_TASK_E2E_ANSWER_FILE: resolve(options["--answer-file"]) } : {}),
        }, stdio: ["ignore", fd, fd],
      });
      console.log(`Run ${attempt}/${repeat}: ${join(dir, `test-${attempt}.log`)}`);
      const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", code => resolve(code)); });
      child = undefined;
      clearTimeout(killTimer); killTimer = undefined;
      console.log(`Run ${attempt}: ${code === 0 && !stopped ? "PASS" : "FAIL"}`);
      if (code !== 0 || stopped) { process.exitCode = 1; break; } // No automatic retry of failed or uncertain work.
    } finally { closeSync(fd); }
  }
} finally {
  clearTimeout(killTimer);
  writeFileSync(join(agent, "auth.json"), "{}\n", { mode: 0o600 });
  process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
  console.log("Temporary native credential cleared; all run/session evidence retained.");
}
