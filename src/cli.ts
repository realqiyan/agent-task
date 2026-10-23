import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { connectAdmin } from "./admin-client.js";
import { controlService } from "./launcher.js";
import type { Settings } from "./settings.js";
import type { previewSettings } from "./settings-management.js";

const common = "Common: --home ABSOLUTE_DIR --json --help. Writes: --yes for noninteractive confirmation.";
const help: Record<string, string> = {
  config: `config show [--saved | --running]
config diff
config edit [--editor EXECUTABLE] [--yes]
config export --output FILE
config validate --file FILE
config apply --file FILE [--yes]
Drafts contain {editToken, config, approveExecutors}; no credential values.
Edit tokens expire after 15 minutes or a save/restart. Explicit approvals name executor IDs in the candidate configuration.
Saving applies on next start; it does not restart the service.`,
  executor: `executor list [--saved | --running]
executor show ID [--saved | --running]
executor add --id ID --type pi|codex|claude|opencode --cwd ABSOLUTE_DIR [--note TEXT] [--yes]
executor update ID [--id NEW_ID] [--type TYPE] [--cwd ABSOLUTE_DIR] [--note TEXT] [--yes]
executor remove ID [--yes]
executor approve ID [--yes]
executor revoke ID [--yes]
Changes apply on next start. New registrations are unapproved; changing ID, type or workspace clears approval.
approve records the administrator's review of native authorization; --yes alone does not grant it.`,
  coordinator: `coordinator show [--saved | --running]
coordinator set --provider openai|anthropic|deepseek|openai-compatible --model ID [--yes]
  Compatible provider also requires: --base-url URL --api-key-env NAME
  --context-window NUMBER --max-tokens NUMBER [--api openai-completions|openai-responses] [--reasoning true|false]
coordinator clear [--yes]
Save the required credential first. Changes apply on next start.`,
  credential: `credential list
credential set NAME [--stdin] [--yes]
credential delete NAME [--yes]
set reads a hidden terminal prompt or stdin (one trailing newline is removed).
Values are never accepted as command arguments or printed. Saves apply on next start.
Service/admin tokens and executor native authentication are not managed here.`,
  task: `task list [--after NUMBER] [--limit NUMBER]
task show ID
task pause ID [--yes]
task resume ID [--yes]
task cancel ID [--yes]
Only future triggers change; current runs continue. Resume does not catch up. Cancel is irreversible for future triggers.`,
  run: `run list [--task ID] [--after NUMBER] [--limit NUMBER]
run show ID
show includes nodes, turns, accepted deliveries, errors, questions and existing replies.`,
  status: "status\nAuthenticated health, active runs/sessions and pending configuration changes.",
  restart: "restart\nApply saved settings and verify the new instance. Active ACP sessions close; uncertain work is not replayed.",
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
    if (Object.hasOwn(options, key)) throw new Error("Repeated option: --" + key);
    if (flags.has(key)) options[key] = true;
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new Error("Missing option value: --" + key);
      options[key] = value;
    }
  }
  return { options, positionals };
}
function text(options: Options, name: string, required = false): string | undefined {
  const value = options[name];
  if (typeof value === "string") return value;
  if (required) throw new Error("Required option: --" + name);
  return undefined;
}
function number(options: Options, name: string, required = false): number | undefined {
  const value = text(options, name, required);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("Expected integer: --" + name);
  return Number(value);
}
function readJson(path: string): unknown {
  try {
    const value = readFileSync(path, "utf8");
    if (Buffer.byteLength(value) > 512 * 1024) throw new Error();
    return JSON.parse(value);
  } catch { throw new Error("Cannot read JSON input (maximum 512 KiB)"); }
}
function writeDraft(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}
async function confirm(options: Options, message: string): Promise<void> {
  if (options.yes) return;
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Noninteractive writes require --yes");
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    if (!/^(y|yes)$/i.test((await terminal.question(message + " [y/N] ")).trim())) throw new Error("Cancelled; no change saved");
  } finally { terminal.close(); }
}
async function credentialValue(options: Options): Promise<string> {
  if (options.stdin) {
    if (process.stdin.isTTY) throw new Error("--stdin requires piped input");
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); length += bytes.length;
      if (length > 65538) throw new Error("Credential input is too large");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Use --stdin to provide a credential without a terminal");
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const terminal = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write("New credential (hidden): ");
  try { return await terminal.question(""); }
  finally { terminal.close(); muted.end(); process.stderr.write("\n"); }
}

export async function runCli(command: string, args: string[], resolveHome: (home?: string) => string): Promise<void> {
  if (!help[command]) throw new Error("Unknown command; use agent-task --help");
  const { options, positionals } = parse(args);
  if (options.help || (positionals.length === 0 && !["status", "restart"].includes(command))) {
    console.log("Usage: agent-task " + help[command] + "\n" + common); return;
  }
  const [action, id] = positionals;
  let allowed: string[] = [], count = 1;
  switch (command) {
    case "status": case "restart": count = 0; break;
    case "config":
      if (action === "show") allowed = ["saved", "running"];
      else if (action === "diff") allowed = [];
      else if (action === "edit") allowed = ["editor", "yes"];
      else if (action === "export") allowed = ["output"];
      else if (action === "validate" || action === "apply") allowed = ["file", ...(action === "apply" ? ["yes"] : [])];
      else throw new Error("Unknown config action");
      break;
    case "executor":
      if (action === "list" || action === "show") { allowed = ["saved", "running"]; count = action === "show" ? 2 : 1; }
      else if (action === "add" || action === "update") { allowed = ["id", "type", "cwd", "note", "yes"]; count = action === "update" ? 2 : 1; }
      else if (["remove", "approve", "revoke"].includes(action!)) { count = 2; allowed = ["yes"]; }
      else throw new Error("Unknown executor action");
      break;
    case "coordinator":
      if (action === "show") allowed = ["saved", "running"];
      else if (action === "set") allowed = ["provider", "model", "base-url", "api-key-env", "api", "context-window", "max-tokens", "reasoning", "yes"];
      else if (action === "clear") allowed = ["yes"];
      else throw new Error("Unknown coordinator action");
      break;
    case "credential":
      if (action === "list") break;
      if (action !== "set" && action !== "delete") throw new Error("Unknown credential action");
      count = 2; allowed = action === "set" ? ["stdin", "yes"] : ["yes"]; break;
    case "task": case "run":
      if (action === "list") allowed = ["after", "limit", ...(command === "run" ? ["task"] : [])];
      else if (action === "show") count = 2;
      else if (command === "task" && ["pause", "resume", "cancel"].includes(action!)) { count = 2; allowed = ["yes"]; }
      else throw new Error("Unknown " + command + " action");
  }
  if (positionals.length !== count) throw new Error("Unexpected or missing arguments; use " + command + " --help");
  for (const key of Object.keys(options)) {
    if (!["home", "json", ...allowed].includes(key)) throw new Error("Unsupported option: --" + key);
  }
  if (options.saved && options.running) throw new Error("Choose either --saved or --running");
  const home = resolveHome(text(options, "home"));
  const output = (value: unknown) => console.log(JSON.stringify(value, null, options.json ? undefined : 2));
  if (command === "restart") { output({ event: "restarted", ...await controlService(home, "restart") }); return; }
  if (command === "status") {
    const ready = await controlService(home, "status");
    if (!ready.consoleUrl) { output({ event: "healthy", ...ready, adminEnabled: false }); return; }
  }
  const client = await connectAdmin(home);
  if (command === "status") { output({ event: "healthy", ...client.ready, ...await client.request<object>("/status") }); return; }
  if (command === "task" || command === "run") {
    if (action === "list") {
      const query = new URLSearchParams();
      for (const key of ["after", "limit"]) { const value = number(options, key); if (value !== undefined) query.set(key, String(value)); }
      if (text(options, "task")) query.set("taskId", text(options, "task")!);
      output(await client.request("/" + command + "s?" + query));
    } else if (action === "show") output(await client.request("/" + command + "s/" + encodeURIComponent(id!)));
    else {
      const task = await client.request("/tasks/" + encodeURIComponent(id!));
      process.stderr.write(JSON.stringify({ action, task }) + "\nOnly future triggers change; current runs continue. Resume does not catch up; cancel cannot be undone.\n");
      await confirm(options, "Change future triggers?");
      output(await client.request("/task-update", { id, action }));
    }
    return;
  }
  const previewAndSave = async (input: unknown) => {
    const preview = await client.request<Preview>("/settings/validate", input);
    process.stderr.write(JSON.stringify(preview, null, 2) + "\nLocal validation does not verify model authentication or ACP execution. Saved changes apply on next start.\n");
    await confirm(options, "Save configuration?");
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
    const draft = { editToken: view.editToken, config: view.saved, approveExecutors: [] };
    if (action === "export") {
      const path = text(options, "output", true)!; writeDraft(path, draft); output({ file: path }); return;
    }
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("config edit requires a terminal; use export and apply for noninteractive edits");
    const editor = text(options, "editor") ?? process.env.VISUAL ?? process.env.EDITOR;
    if (!editor) throw new Error("Set EDITOR/VISUAL or --editor to an executable path (no shell arguments)");
    const directory = mkdtempSync(join(tmpdir(), "agent-task-edit-")), file = join(directory, "draft.json");
    try {
      writeDraft(file, draft);
      const result = spawnSync(editor, [file], { stdio: "inherit" });
      if (result.error || result.status !== 0) throw new Error("Editor failed; no configuration saved");
      await previewAndSave(readJson(file));
    } finally { rmSync(directory, { recursive: true, force: true }); }
    return;
  }
  const view = await client.request<View>("/settings");
  if (command === "credential") {
    if (action === "list") { output(view.credentials); return; }
    process.stderr.write("Credential " + action + ": " + id + "; applies on next start.\n");
    await confirm(options, "Save credential change?");
    const input = { editToken: view.editToken, key: id, action: action === "set" ? "replace" : "delete",
      ...(action === "set" ? { value: await credentialValue(options) } : {}) };
    output(await client.request("/settings/credential", input)); return;
  }
  const selected = options.running ? view.running : view.saved;
  if (action === "list") { output(selected.executors); return; }
  if (action === "show") {
    if (command === "coordinator") output(selected.coordinator ?? null);
    else {
      const executor = selected.executors.find(item => item.id === id);
      if (!executor) throw new Error("Executor not found");
      output(executor);
    }
    return;
  }
  let change: object;
  if (command === "executor") {
    if (action === "add" || action === "update") {
      const fields: Record<string, string> = {};
      for (const key of ["id", "type", "cwd", "note"]) {
        const value = text(options, key, action === "add" && key !== "note");
        if (value !== undefined) fields[key] = value;
      }
      if (!Object.keys(fields).length) throw new Error("Specify at least one executor field to update");
      change = action === "add" ? { action: "executor-add", executor: fields } : { action: "executor-update", id, patch: fields };
    } else change = { action: "executor-" + action, id };
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
      if (!["true", "false"].includes(reasoning)) throw new Error("--reasoning must be true or false");
      coordinator.reasoning = reasoning === "true";
    }
    change = { action: "coordinator-set", coordinator };
  }
  const draft = await client.request<Draft>("/settings/prepare", { editToken: view.editToken, change });
  await previewAndSave(draft);
}
