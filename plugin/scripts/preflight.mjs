import { spawn } from "node:child_process";

// No shell, network, MCP connection, config writes or raw diagnostic output.
// The service CLI owns private installation validation. The plugin sees only its summary.
export async function inspectInstallation({ env = process.env, cwd = process.cwd(), signal } = {}) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!["linux", "darwin"].includes(process.platform) || major < 22 || (major === 22 && minor < 19)) return "unsupported-runtime";
  if (signal?.aborted) return "cancelled";
  const command = env.AGENT_TASK_PREFLIGHT_COMMAND ?? "agent-task";
  const home = env.AGENT_TASK_PREFLIGHT_HOME;
  // The explicit machine-output flag makes older CLIs reject before their setup path.
  const args = ["setup", "--check", "--json", ...(home === undefined ? [] : ["--home", home])];
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve("check-failed"); return; }
    let stdout = "", bytes = 0, failure;
    const stop = state => {
      failure ??= state;
      child.kill("SIGKILL");
      child.stdout.destroy();
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("check-failed"), 3000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", error => { failure ??= error.code === "ENOENT" ? "command-unavailable" : "check-failed"; });
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 4096) stop("check-failed");
      else stdout += chunk.toString("utf8");
    });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (failure) { resolve(failure); return; }
      try {
        const report = JSON.parse(stdout);
        if (code === 0 && report.configuration === "valid" && typeof report.coordinatorConfigured === "boolean") {
          resolve(report.coordinatorConfigured ? "ready" : "coordinator-missing");
        } else if (code === 1 && ["missing", "incomplete", "invalid"].includes(report.configuration)) {
          resolve({ missing: "setup-missing", incomplete: "setup-incomplete", invalid: "setup-invalid" }[report.configuration]);
        } else resolve("check-failed");
      } catch { resolve("check-failed"); }
    });
  });
}

const reasons = {
  "command-unavailable": "The agent-task command could not start. It may be uninstalled, outside this host's PATH, or missing its Node interpreter.",
  "setup-missing": "Agent Task is installed but setup is missing for the checked home.",
  "setup-incomplete": "Agent Task initialization is incomplete. Inspect it before explicitly resuming; do not reset or reinstall it.",
  "setup-invalid": "Agent Task installation or private configuration could not be validated. Check the selected home and existing files; do not automatically reinstall.",
  "coordinator-missing": "Agent Task has no complete coordinator configuration. MCP inspection may work, but executable tasks need coordinator setup.",
  "unsupported-runtime": "Agent Task needs Linux/macOS and Node.js 22.19 or later.",
  "check-failed": "The Agent Task read-only check failed, is unsupported by this service build, or timed out. This does not prove the service is uninstalled. Inspect the command, Node version and selected home.",
};

export function onboardingNotice(state, host) {
  const entry = { pi: "/skill:using-agent-task", claude: "/agent-task:using-agent-task", codex: "$using-agent-task" }[host];
  if (!entry || !reasons[state]) return null;
  const message = reasons[state] + " Run " + entry + " for guidance. No installation, repair or service start was attempted.";
  return {
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "Agent Task startup check: " + reasons[state] +
        " If the user wants Agent Task, read the installed using-agent-task skill before attempting MCP operations. Verify the configured command/home; the check is not a live MCP health test. Obtain confirmation before installation or configuration changes. Do not replay work.",
    },
  };
}
