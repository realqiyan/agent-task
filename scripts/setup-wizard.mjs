import { createInterface } from "node:readline/promises";

export async function setupWizard(options, root) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive setup requires a terminal; use --executors none|pi,codex,claude,opencode and --cwd ABSOLUTE_DIR for noninteractive setup");
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  input.on("SIGINT", () => abort.abort());
  const ask = async (question, fallback) => (await input.question(`${question}${fallback ? " [" + fallback + "]" : ""}: `, { signal: abort.signal })).trim() || fallback;
  try {
    console.log(`Private installation: ${root}`);
    options.executors ??= await ask("Executors to install (none or comma-separated pi,codex,claude,opencode)", "none");
    options.cwd ??= await ask("Existing absolute workspace (outside installation and npm package)", process.cwd());
    if (!options.provider) {
      const provider = await ask("Coordinator provider (none/openai/anthropic/deepseek; configurable later in Web)", "none");
      if (provider !== "none") options.provider = provider;
    }
    if (options.provider) options.model ??= await ask("Coordinator model ID", "");
    options.port ??= await ask("Loopback HTTP port", "8765");
    if (await ask("Write private configuration and install selected components? (yes/no)", "no") !== "yes") throw new Error("Setup cancelled; no configuration written");
  } catch (error) {
    if (abort.signal.aborted) throw new Error("Setup cancelled; no configuration written");
    throw error;
  } finally { input.close(); }
}
