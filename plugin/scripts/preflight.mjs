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
  "command-unavailable": "agent-task 命令无法启动，可能未安装、不在宿主 PATH 中或缺少 Node 解释器。",
  "setup-missing": "Agent Task 已安装，但所检查 home 尚未初始化。",
  "setup-incomplete": "Agent Task 初始化未完成。先核查再明确续接，不重置或重新安装。",
  "setup-invalid": "无法验证 Agent Task 安装或私有配置。请核查所选 home 和现有文件，不自动重装。",
  "coordinator-missing": "Agent Task 缺少完整协调配置。MCP 查询可能可用，但执行任务前须完成协调配置。",
  "unsupported-runtime": "Agent Task 要求 Linux/macOS 和 Node.js 22.19 或更高版本。",
  "check-failed": "Agent Task 只读检查失败、不受当前服务支持或已超时。这不证明未安装，请核查命令、Node 版本和所选 home。",
};

export function onboardingNotice(state, host) {
  const entry = { pi: "/skill:using-agent-task", claude: "/agent-task:using-agent-task", codex: "$using-agent-task" }[host];
  if (!entry || !reasons[state]) return null;
  const message = reasons[state] + " 请运行 " + entry + " 查看引导。本次未尝试安装、修复或启动服务。";
  return {
    systemMessage: message,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: "Agent Task 启动检查：" + reasons[state] +
        " 用户要使用 Agent Task 时，先读取已安装的 using-agent-task 技能，再尝试 MCP 操作。核查所配置命令与 home；本检查不是实时 MCP 健康测试。安装或改配置前须确认，不重放工作。",
    },
  };
}
