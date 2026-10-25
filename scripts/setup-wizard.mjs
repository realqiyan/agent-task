import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { join } from "node:path";

async function secret(question) {
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stderr.write(chunk); callback(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  try {
    process.stderr.write(question + ": "); muted = true;
    return (await input.question("")).trim();
  } finally { muted = false; process.stderr.write("\n"); input.close(); output.end(); }
}

/** Terminal collection only; setup validates and publishes the settings. */
export async function setupWizard(options, root) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("初始化需要终端，或显式提供 --home --data-dir --port --generate-tokens/--credentials-file 和 --yes");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  input.on("SIGINT", () => abort.abort());
  const ask = async (question, fallback = "") => (await input.question(`${question}${fallback ? " [" + fallback + "]" : ""}: `, { signal: abort.signal })).trim() || fallback;
  let needsKey = false;
  try {
    options.home = await ask("私有安装目录", options.home ?? root);
    options["data-dir"] = await ask("私有数据目录", options["data-dir"] ?? join(options.home, "data"));
    options.port = await ask("回环 HTTP 端口（0 表示自动分配）", options.port ?? "8765");
    options["token-env"] = await ask("MCP 令牌变量名", options["token-env"] ?? "AGENT_TASK_TOKEN");
    const tokens = await ask("服务与管理员令牌（generate/file）", options["credentials-file"] ? "file" : "generate");
    if (tokens === "generate") options["generate-tokens"] = true;
    else if (tokens === "file") options["credentials-file"] = await ask("私有凭据 JSON 文件", options["credentials-file"]);
    else throw new Error("令牌来源须选择 generate 或 file");
    options.provider = await ask("协调 provider（none/openai/anthropic/deepseek/openai-compatible）", options.provider ?? "none");
    if (options.provider !== "none") {
      options.model = await ask("协调模型 ID", options.model);
      if (options.provider === "openai-compatible") {
        options["base-url"] = await ask("模型端点 URL", options["base-url"]);
        options.api = await ask("API 类型（openai-completions/openai-responses）", options.api ?? "openai-completions");
        options["api-key-env"] = await ask("协调凭据变量名", options["api-key-env"] ?? "COORDINATOR_API_KEY");
        options["context-window"] = await ask("模型上下文窗口", options["context-window"]);
        options["max-tokens"] = await ask("最大输出 token 数", options["max-tokens"]);
      }
      needsKey = !options["credentials-file"];
    }
    if (await ask("确认目录、端口、令牌配置与协调模型？（yes/no）", "no") !== "yes") throw new Error("已取消初始化，未写入配置");
    options.yes = true;
  } catch (error) {
    if (abort.signal.aborted) throw new Error("已取消初始化，未写入配置");
    throw error;
  } finally { input.close(); }
  if (needsKey) options.coordinatorKey = await secret("协调 API 密钥（隐藏输入）");
}
