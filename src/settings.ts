import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ADMIN_TOKEN_ENV, configSchema, coordinatorCredentialEnv, validateConfig } from "./config.js";
import type { Config } from "./config.js";
import { parseEnvironment, validateServiceEnvironment } from "./environment.js";
import { checkDataDirectory, FileCommitError, readPrivateText, replacePrivateText } from "./private-files.js";
import { credentialUpdateSchema, settingsConfigSchema } from "./settings-contract.js";

export class SettingsError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "unavailable", message: string) { super(message); }
}
const protectedKeys = new Set(["HOME", "PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_OPTIONS", "NODE_PATH",
  "PI_ACP_PI_COMMAND", "AGENT_TASK_TOKEN", ADMIN_TOKEN_ENV, "__proto__", "constructor", "prototype"]);
const modelKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY"];
type Snapshot = { configText: string; environmentText: string; config: Config; environment: Record<string, string> };
type Edit = { configText: string; environmentText: string; expires: number };
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Field paths only: parser diagnostics and rejected values may contain credentials.
    const fields = result.error.issues.slice(0, 8).map(issue => issue.path.join(".") || "request");
    throw new SettingsError("invalid", "Invalid fields: " + fields.join(", "));
  }
  return result.data;
}
function referenced(config: Config): Set<string> {
  return new Set(config.coordinator ? [coordinatorCredentialEnv(config.coordinator)] : []);
}
function editableKey(key: string, config: Config): boolean {
  return !protectedKeys.has(key) && key !== config.tokenEnv && !/^(NODE_|LD_|DYLD_)/.test(key) &&
    (/(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$/.test(key) || referenced(config).has(key));
}

/** Disk settings are next-start inputs only. This service never mutates live objects or process.env. */
export class Settings {
  private readonly edits = new Map<string, Edit>();
  private readonly initial: Snapshot;
  private readonly running: Config;
  private readonly runningEnvironment: NodeJS.ProcessEnv;
  private readonly base: NodeJS.ProcessEnv;
  private closed = false;
  private uncertain = false;
  readonly startedAt = new Date().toISOString();
  constructor(private readonly configPath: string, private readonly environmentPath: string,
    running: Config, base: NodeJS.ProcessEnv, environment: NodeJS.ProcessEnv) {
    if (configPath === environmentPath) throw new SettingsError("invalid", "Configuration and environment must be separate files");
    this.running = structuredClone(running);
    this.base = { ...base }; this.runningEnvironment = { ...environment };
    this.initial = this.snapshot();
  }
  private snapshot(): Snapshot {
    if (this.closed) throw new SettingsError("unavailable", "Configuration management is closed");
    try {
      const configText = readPrivateText(this.configPath), environmentText = readPrivateText(this.environmentPath);
      return { configText, environmentText, config: configSchema.parse(JSON.parse(configText)), environment: parseEnvironment(environmentText) };
    } catch {
      throw new SettingsError("unavailable", "Cannot read private configuration files; inspect their format, ownership and permissions offline");
    }
  }
  private pending(snapshot: Snapshot): boolean {
    return snapshot.configText !== this.initial.configText || snapshot.environmentText !== this.initial.environmentText;
  }
  status() {
    return { pendingRestart: this.pending(this.snapshot()), writeBlocked: this.uncertain, startedAt: this.startedAt };
  }
  get() {
    const snapshot = this.snapshot(), now = Date.now();
    for (const [key, edit] of this.edits) if (edit.expires <= now) this.edits.delete(key);
    while (this.edits.size >= 32) this.edits.delete(this.edits.keys().next().value!);
    const editToken = randomUUID();
    this.edits.set(editToken, { configText: snapshot.configText, environmentText: snapshot.environmentText, expires: now + 15 * 60_000 });
    const keys = new Set([...modelKeys, ...Object.keys(snapshot.environment), ...referenced(snapshot.config), ...referenced(this.running)]);
    const credentials = [...keys].filter(key => editableKey(key, snapshot.config) && editableKey(key, this.running) && ![snapshot.environment[snapshot.config.tokenEnv], snapshot.environment[ADMIN_TOKEN_ENV]].includes(snapshot.environment[key])).sort().map(key => ({
      key, saved: Boolean(snapshot.environment[key]), running: Boolean(this.runningEnvironment[key]),
      pendingRestart: snapshot.environment[key] !== this.runningEnvironment[key],
      referenced: referenced(snapshot.config).has(key),
    }));
    return { editToken, running: structuredClone(this.running), saved: snapshot.config, credentials,
      pendingRestart: this.pending(snapshot), writeBlocked: this.uncertain };
  }
  private editing(token: string): Snapshot {
    if (this.uncertain) throw new SettingsError("unavailable", "Publication was uncertain; stop the service and inspect configuration files before further saves");
    const snapshot = this.snapshot(), edit = this.edits.get(token);
    if (!edit || edit.expires <= Date.now() || edit.configText !== snapshot.configText || edit.environmentText !== snapshot.environmentText) {
      throw new SettingsError("conflict", "Configuration changed or the edit expired; reload before saving");
    }
    return snapshot;
  }
  private candidate(value: unknown): Config {
    const input = parse(settingsConfigSchema, value), snapshot = this.editing(input.editToken);
    const environment = { ...this.base, ...snapshot.environment };
    let config: Config;
    try {
      config = validateConfig(input.config);
      checkDataDirectory(config.dataDir);
    } catch (error) {
      if (error instanceof z.ZodError) throw new SettingsError("invalid", "Invalid configuration fields");
      throw new SettingsError("invalid", "Local validation failed: check data directory, workspaces and credential isolation");
    }
    const previous = snapshot.config.coordinator, next = config.coordinator;
    const endpoint = (model: NonNullable<Config["coordinator"]>) => model.provider === "openai-compatible" ? model.baseUrl : model.provider;
    if (previous && next && endpoint(previous) !== endpoint(next) && coordinatorCredentialEnv(previous) === coordinatorCredentialEnv(next)) {
      throw new SettingsError("invalid", "Changing the model endpoint requires a new credential reference; save the new key first");
    }
    for (const key of referenced(config)) {
      if (!environment[key]) throw new SettingsError("invalid", "A referenced environment value is missing; prepare credentials or native configuration first");
    }
    const token = environment[config.tokenEnv] ?? environment[snapshot.config.tokenEnv];
    try { validateServiceEnvironment(config, { ...environment, [config.tokenEnv]: token }); }
    catch { throw new SettingsError("invalid", "Service, administrator and model credentials must be valid and distinct"); }
    if (config.tokenEnv !== snapshot.config.tokenEnv && environment[config.tokenEnv] && environment[config.tokenEnv] !== environment[snapshot.config.tokenEnv]) {
      throw new SettingsError("invalid", "tokenEnv already contains another value; use a new environment name");
    }
    return config;
  }
  validate(value: unknown): Config { return this.candidate(value); }
  saveConfig(value: unknown) {
    const config = this.candidate(value);
    const snapshot = this.editing(parse(settingsConfigSchema, value).editToken);
    if (config.tokenEnv !== snapshot.config.tokenEnv) {
      snapshot.environment[config.tokenEnv] = snapshot.environment[snapshot.config.tokenEnv]!;
      // Publish an alias first. Either configuration still uses the same service token.
      this.publish(this.environmentPath, snapshot.environment);
    }
    this.publish(this.configPath, config);
    return this.get();
  }
  saveCredential(value: unknown) {
    const input = parse(credentialUpdateSchema, value), snapshot = this.editing(input.editToken);
    if (!editableKey(input.key, snapshot.config) || !editableKey(input.key, this.running) ||
      [snapshot.environment[snapshot.config.tokenEnv], snapshot.environment[ADMIN_TOKEN_ENV]].includes(snapshot.environment[input.key])) throw new SettingsError("invalid", "This environment key is not console-managed; new credential names must end in _KEY, _TOKEN, _SECRET or _PASSWORD");
    if (input.action === "delete") {
      if (referenced(snapshot.config).has(input.key)) throw new SettingsError("invalid", "The saved configuration still references this credential");
      delete snapshot.environment[input.key];
    } else {
      if ([snapshot.environment[snapshot.config.tokenEnv], snapshot.environment[ADMIN_TOKEN_ENV],
        this.runningEnvironment[this.running.tokenEnv], this.runningEnvironment[ADMIN_TOKEN_ENV]].includes(input.value)) {
        throw new SettingsError("invalid", "Service and administrator tokens cannot be reused as credentials");
      }
      snapshot.environment[input.key] = input.value;
    }
    // Recheck the complete environment format, not only the edited value.
    parseEnvironment(JSON.stringify(snapshot.environment));
    this.publish(this.environmentPath, snapshot.environment);
    return this.get();
  }
  private publish(path: string, value: unknown): void {
    try { replacePrivateText(path, JSON.stringify(value, null, 2) + "\n"); }
    catch (error) {
      if (error instanceof FileCommitError && error.uncertain) this.uncertain = true;
      throw new SettingsError("unavailable", this.uncertain ? "Publication could not be confirmed; stop and inspect the files" : "Save failed; no replacement was published");
    }
    this.edits.clear();
  }
  close(): void { this.closed = true; this.edits.clear(); }
}
