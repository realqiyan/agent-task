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
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Setup requires a terminal or explicit --home --data-dir --port --generate-tokens/--credentials-file and --yes");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  input.on("SIGINT", () => abort.abort());
  const ask = async (question, fallback = "") => (await input.question(`${question}${fallback ? " [" + fallback + "]" : ""}: `, { signal: abort.signal })).trim() || fallback;
  let needsKey = false;
  try {
    options.home = await ask("Private installation directory", options.home ?? root);
    options["data-dir"] = await ask("Private data directory", options["data-dir"] ?? join(options.home, "data"));
    options.port = await ask("Loopback HTTP port (0 assigns an available port)", options.port ?? "8765");
    options["token-env"] = await ask("MCP token variable name", options["token-env"] ?? "AGENT_TASK_TOKEN");
    const tokens = await ask("Service/admin tokens (generate/file)", options["credentials-file"] ? "file" : "generate");
    if (tokens === "generate") options["generate-tokens"] = true;
    else if (tokens === "file") options["credentials-file"] = await ask("Private credentials JSON file", options["credentials-file"]);
    else throw new Error("Choose generate or file for tokens");
    options.provider = await ask("Coordinator provider (none/openai/anthropic/deepseek/openai-compatible)", options.provider ?? "none");
    if (options.provider !== "none") {
      options.model = await ask("Coordinator model ID", options.model);
      if (options.provider === "openai-compatible") {
        options["base-url"] = await ask("Model endpoint URL", options["base-url"]);
        options.api = await ask("API (openai-completions/openai-responses)", options.api ?? "openai-completions");
        options["api-key-env"] = await ask("Coordinator credential name", options["api-key-env"] ?? "COORDINATOR_API_KEY");
        options["context-window"] = await ask("Model context window", options["context-window"]);
        options["max-tokens"] = await ask("Maximum output tokens", options["max-tokens"]);
      }
      needsKey = !options["credentials-file"];
    }
    if (await ask("Confirm directories, port, token configuration and coordinator? (yes/no)", "no") !== "yes") throw new Error("Setup cancelled; no configuration written");
    options.yes = true;
  } catch (error) {
    if (abort.signal.aborted) throw new Error("Setup cancelled; no configuration written");
    throw error;
  } finally { input.close(); }
  if (needsKey) options.coordinatorKey = await secret("Coordinator API key (hidden)");
}
