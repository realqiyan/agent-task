import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { connectAdmin } from "./admin-client.js";
import { controlService, ControlError } from "../../integrations/local-service/control.js";
import { version, versionStatus } from "../../infrastructure/version.js";
import type { Settings } from "../../configuration/settings.js";
import type { previewSettings } from "../../configuration/management.js";
import type { ExecutorStatus } from "../../executors/model.js";

const common = "通用参数：--home 绝对目录、--json、--help。非交互写操作须用 --yes 确认。";
const help: Record<string, string> = {
  config: `config show [--saved | --running]
config diff
config edit [--editor 程序路径] [--yes]
config export --output 文件路径
config validate --file 文件路径
config apply --file 文件路径 [--yes]
草稿包含 {editToken, config}，不包含凭据值。
编辑令牌在 15 分钟后、保存或重启后失效。
保存的配置在下次启动时生效，不会自动重启服务。`,
  executor: `executor list
executor show ID
executor register --file 文件路径 [--yes]
executor unregister ID [--yes]
executor refresh
executor upgrade pi|codex|claude [--yes]
executor enable pi|codex|claude|opencode [--yes]
executor disable pi|codex|claude|opencode [--yes]
register 读取 {id, command, args, cwd?}：唯一 ID、规范绝对程序路径、参数数组和可选启动目录，不含秘密。
注册和注销立即持久化并生效，无须重启，不探测 ACP 或模型。
程序直接启动，不经 shell 展开，继承过滤后的原生环境。
cwd 须为已有的规范绝对目录；省略时使用任务工作目录。
cwd 只设置进程启动目录；ACP 会话仍使用任务工作目录。
unregister 阻止新派发，不停止活动进程、不改写任务或删除历史。
list/show 显示发现与适配器准备状态，不验证原生认证。
refresh 重新发现已安装的 CLI，并在后台准备缺失的适配器。
upgrade 更新托管 ACP 适配器，不改变已有任务的执行端指派。
enable/disable 在下次启动时生效。CLI 认证与权限仍由原生配置管理。`,
  coordinator: `coordinator show [--saved | --running]
coordinator set --provider openai|anthropic|deepseek|openai-compatible --model ID [--yes]
  兼容 provider 还需要： --base-url URL --api-key-env NAME
  --context-window 整数 --max-tokens 整数 [--api openai-completions|openai-responses] [--reasoning true|false]
coordinator clear [--yes]
先保存所需凭据。配置在下次启动时生效。`,
  credential: `credential list
credential set NAME [--stdin] [--yes]
credential delete NAME [--yes]
set 从终端隐藏输入或 stdin 读取凭据，并移除末尾的一个换行。
凭据值不通过命令参数传入，也不回显；保存后在下次启动时生效。
此处不管理服务令牌、管理员令牌或执行端原生认证。`,
  task: `task list [--after 整数] [--limit 整数]
task show ID
task schedule pause 任务ID [--yes]
task schedule resume 任务ID [--yes]
task schedule cancel 任务ID [--yes]
仅修改未来触发，当前运行继续。恢复不补跑错过的触发；取消不可撤销。`,
  run: `run list [--task ID] [--after 整数] [--limit 整数]
run show ID
show 显示节点、turn、已验收交付、错误、问题及已有回复。`,
  status: "status\n认证健康、活动工作、待生效配置及安装/launcher/服务版本；restartRequired=null 表示版本未知。",
  restart: "restart\n应用已保存配置并验证新实例。活动 ACP 会话会关闭；不重放结果不明的工作。",
};
type Options = Record<string, string | true>;
type View = ReturnType<Settings["get"]>;
type Draft = ReturnType<Settings["prepareChange"]>;
type Preview = ReturnType<typeof previewSettings>;
const flags = new Set(["json", "yes", "help", "saved", "running", "stdin"]);
function parse(args: string[]) {
  const options: Options = {}, positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const key = arg.slice(2);
    if (Object.hasOwn(options, key)) throw new Error("重复选项：--" + key);
    if (flags.has(key)) options[key] = true;
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("选项缺少值：--" + key);
      options[key] = value;
    }
  }
  return { options, positionals };
}
function text(options: Options, name: string, required = false): string | undefined {
  const value = options[name];
  if (typeof value === "string") return value;
  if (required) throw new Error("缺少必需选项：--" + name);
  return undefined;
}
function number(options: Options, name: string, required = false): number | undefined {
  const value = text(options, name, required);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("选项须为整数：--" + name);
  return Number(value);
}
function readJson(path: string): unknown {
  try {
    const value = readFileSync(path, "utf8");
    if (Buffer.byteLength(value) > 512 * 1024) throw new Error();
    return JSON.parse(value);
  } catch { throw new Error("无法读取 JSON 输入；大小上限为 512 KiB"); }
}
function writeDraft(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
async function confirm(options: Options, message: string): Promise<void> {
  if (options.yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("非交互写操作需要 --yes 确认");
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (!/^(y|yes)$/i.test((await terminal.question(message + " [y/N] ")).trim())) throw new Error("已取消，未保存变更");
  } finally { terminal.close(); }
}
async function credentialValue(options: Options): Promise<string> {
  if (options.stdin) {
    if (process.stdin.isTTY) throw new Error("--stdin 需要管道输入");
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > 65538) throw new Error("凭据输入过大");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("没有终端时请通过 --stdin 提供凭据");
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const terminal = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write("新凭据（隐藏输入）: ");
  try { return await terminal.question(""); }
  finally { terminal.close(); muted.end(); process.stderr.write("\n"); }
}

export async function runCli(command: string, args: string[], resolveHome: (home?: string) => string): Promise<void> {
  if (!help[command]) throw new Error("未知命令；请查看 agent-task --help");
  const { options, positionals } = parse(args);
  if (options.help || (positionals.length === 0 && !["status", "restart"].includes(command))) {
    console.log("用法：agent-task " + help[command] + "\n" + common); return;
  }
  const schedule = command === "task" && positionals[0] === "schedule"; const [action, id] = schedule ? positionals.slice(1) : positionals;
  let allowed: string[] = [], count = 1;
  switch (command) {
    case "status": case "restart": count = 0; break;
    case "config":
      if (action === "show") allowed = ["saved", "running"];
      else if (action === "diff") allowed = [];
      else if (action === "edit") allowed = ["editor", "yes"];
      else if (action === "export") allowed = ["output"];
      else if (action === "validate" || action === "apply") allowed = ["file", ...(action === "apply" ? ["yes"] : [])];
      else throw new Error("未知配置操作");
      break;
    case "executor":
      if (action === "list" || action === "refresh") allowed = [];
      else if (action === "show") count = 2;
      else if (action === "register") allowed = ["file", "yes"];
      else if (["enable", "disable", "upgrade", "unregister"].includes(action!)) { count = 2; allowed = ["yes"]; }
      else throw new Error("未知执行端操作");
      break;
    case "coordinator":
      if (action === "show") allowed = ["saved", "running"];
      else if (action === "set") allowed = ["provider", "model", "base-url", "api-key-env", "api", "context-window", "max-tokens", "reasoning", "yes"];
      else if (action === "clear") allowed = ["yes"];
      else throw new Error("未知协调模型操作");
      break;
    case "credential":
      if (action === "list") break;
      if (action !== "set" && action !== "delete") throw new Error("未知凭据操作");
      count = 2; allowed = action === "set" ? ["stdin", "yes"] : ["yes"]; break;
    case "task": case "run":
      if (!schedule && action === "list") allowed = ["after", "limit", ...(command === "run" ? ["task"] : [])];
      else if (!schedule && action === "show") count = 2;
      else if (schedule && ["pause", "resume", "cancel"].includes(action!)) { count = 3; allowed = ["yes"]; }
      else throw new Error("未知 " + command + " 操作");
  }
  if (positionals.length !== count) throw new Error("参数多余或缺失；请查看 " + command + " --help");
  for (const key of Object.keys(options)) {
    if (!["home", "json", ...allowed].includes(key)) throw new Error("不支持的选项：--" + key);
  }
  if (options.saved && options.running) throw new Error("--saved 与 --running 只能选择一个");
  const home = resolveHome(text(options, "home"));
  const output = (value: unknown) => console.log(JSON.stringify(value, null, options.json ? undefined : 2));
  if (command === "restart") { output({ event: "restarted", ...await controlService(home, "restart") }); return; }
  if (command === "status") {
    try {
      const ready = await controlService(home, "status");
      if (!ready.consoleUrl) { output({ event: "healthy", ...ready, adminEnabled: false, ...versionStatus(ready) }); return; }
    } catch (error) {
      if (!(error instanceof ControlError) || error.kind !== "unreachable" || !options.json) throw error;
      output({ event: "unreachable", installedVersion: version });
      process.exitCode = 1;
      return;
    }
  }
  const client = await connectAdmin(home);
  if (command === "status") {
    output({ event: "healthy", ...client.ready, ...await client.request<object>("/status"), ...versionStatus(client.ready) }); return;
  }
  if (command === "executor" && ["register", "unregister"].includes(action!)) {
    const input = action === "register" ? readJson(text(options, "file", true)!) : { id };
    process.stderr.write("自定义 ACP 注册允许启动本机程序。启动参数不得含秘密。注册立即生效，不改变已有任务指派或活动进程。\n");
    await confirm(options, action === "register" ? "注册此文件中指定的本机 ACP 程序？" : "注销 " + id + " 并阻止新派发？");
    output(await client.request("/executors/" + action, input)); return;
  }
  if (command === "executor" && ["list", "show", "refresh", "upgrade"].includes(action!)) {
    if (action === "refresh") { output(await client.request("/executors/refresh", {})); return; }
    if (action === "upgrade") {
      await confirm(options, "升级 " + id + " 的托管 ACP 适配器？");
      output(await client.request("/executors/upgrade", { id })); return;
    }
    const result = await client.request<{ executors: ExecutorStatus[] }>("/executors");
    if (action === "list") output(result);
    else {
      const executor = result.executors.find(item => item.id === id);
      if (!executor) throw new Error("未找到执行端");
      output(executor);
    }
    return;
  }
  if (command === "task" || command === "run") {
    if (action === "list") {
      const query = new URLSearchParams();
      for (const key of ["after", "limit"]) { const value = number(options, key); if (value !== undefined) query.set(key, String(value)); }
      if (text(options, "task")) query.set("taskId", text(options, "task")!);
      output(await client.request("/" + command + "s?" + query));
    } else if (action === "show") output(await client.request("/" + command + "s/" + encodeURIComponent(id!)));
    else {
      const task = await client.request("/tasks/" + encodeURIComponent(id!));
      process.stderr.write(JSON.stringify({ action, task }) + "\n仅修改未来触发，当前运行继续。恢复不补跑错过的触发；取消不可撤销。\n");
      await confirm(options, "修改未来触发？");
      output(await client.request("/task-schedule-control", { taskId: id, action }));
    }
    return;
  }
  const previewAndSave = async (input: unknown) => {
    const preview = await client.request<Preview>("/settings/validate", input);
    process.stderr.write(JSON.stringify(preview, null, 2) + "\n本地校验不验证模型认证或 ACP 执行。保存的配置在下次启动时生效。\n");
    await confirm(options, "保存配置？");
    output(await client.request("/settings/config", input));
  };
  if (command === "config") {
    if (action === "diff") { output(await client.request("/settings/diff")); return; }
    if (action === "validate" || action === "apply") {
      const input = readJson(text(options, "file", true)!);
      if (action === "validate") output(await client.request("/settings/validate", input));
      else await previewAndSave(input);
      return;
    }
    const view = await client.request<View>("/settings");
    if (action === "show") { output(options.running ? view.running : view.saved); return; }
    const draft = { editToken: view.editToken, config: view.saved };
    if (action === "export") {
      const path = text(options, "output", true)!; writeDraft(path, draft); output({ file: path }); return;
    }
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("config edit 需要终端；非交互编辑使用 export 和 apply");
    const editor = text(options, "editor") ?? process.env.VISUAL ?? process.env.EDITOR;
    if (!editor) throw new Error("请将 EDITOR、VISUAL 或 --editor 设置为可执行程序路径，不附加 shell 参数");
    const directory = mkdtempSync(join(tmpdir(), "agent-task-edit-")), file = join(directory, "draft.json");
    try {
      writeDraft(file, draft);
      const result = spawnSync(editor, [file], { stdio: "inherit" });
      if (result.error || result.status !== 0) throw new Error("编辑器运行失败，未保存配置");
      await previewAndSave(readJson(file));
    } finally { rmSync(directory, { recursive: true, force: true }); }
    return;
  }
  const view = await client.request<View>("/settings");
  if (command === "credential") {
    if (action === "list") { output(view.credentials); return; }
    process.stderr.write("凭据操作 " + action + ": " + id + "；下次启动时生效。\n");
    await confirm(options, "保存凭据变更？");
    const input = { editToken: view.editToken, key: id, action: action === "set" ? "replace" : "delete",
      ...(action === "set" ? { value: await credentialValue(options) } : {}) };
    output(await client.request("/settings/credential", input)); return;
  }
  const selected = options.running ? view.running : view.saved;
  if (action === "show") {
    output(selected.coordinator ?? null);
    return;
  }
  let change: object;
  if (command === "executor") {
    change = { action: "executor-" + action, id };
  } else if (action === "clear") change = { action: "coordinator-clear" };
  else {
    const provider = text(options, "provider", true), model = text(options, "model", true);
    const coordinator: Record<string, unknown> = { provider, model };
    const compatible = provider === "openai-compatible";
    for (const [flag, field] of [["base-url", "baseUrl"], ["api-key-env", "apiKeyEnv"], ["api", "api"]] as const) {
      const value = text(options, flag, compatible && flag !== "api");
      if (value !== undefined) coordinator[field] = value;
    }
    for (const [flag, field] of [["context-window", "contextWindow"], ["max-tokens", "maxTokens"]] as const) {
      const value = number(options, flag, compatible); if (value !== undefined) coordinator[field] = value;
    }
    const reasoning = text(options, "reasoning");
    if (reasoning !== undefined) {
      if (!["true", "false"].includes(reasoning)) throw new Error("--reasoning 必须为 true 或 false");
      coordinator.reasoning = reasoning === "true";
    }
    change = { action: "coordinator-set", coordinator };
  }
  const draft = await client.request<Draft>("/settings/prepare", { editToken: view.editToken, change });
  await previewAndSave(draft);
}
