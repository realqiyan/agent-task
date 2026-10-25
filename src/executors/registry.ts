import { errorText, StorageError, TaskError } from "../shared/errors.js";
import type { CustomExecutor, Executor, ExecutorStatus, ExecutorType } from "./model.js";
import type { CustomExecutorFiles, ExecutorDiscovery } from "./ports.js";
import { customExecutorId, customExecutorSchema, customExecutorsSchema } from "./validation.js";

export function sameExecutor(a: Executor, b: Executor): boolean {
  return a.id === b.id && a.type === b.type && a.nativePath === b.nativePath &&
    (a.type !== "custom" || (a.command === b.command && a.cwd === b.cwd && JSON.stringify(a.args) === JSON.stringify(b.args)));
}
export function authorizedProfile(snapshot: Executor | undefined, current: Executor | undefined): boolean {
  return Boolean(snapshot && current && sameExecutor(snapshot, current));
}
function status(executor: Executor, state: ExecutorStatus["state"] = "ready"): ExecutorStatus {
  return { id: executor.id, type: executor.type, nativePath: executor.nativePath,
    ...(executor.cwd === undefined ? {} : { cwd: executor.cwd }),
    state, adapterVersion: executor.adapterVersion, error: null };
}
function customProfile(entry: CustomExecutor): Executor {
  return { ...entry, type: "custom", nativePath: entry.command, adapterVersion: null };
}

/** Owns admission, durable custom registrations and adapter installation lifetime, not native permissions. */
export class ExecutorRegistry {
  private profiles: Executor[];
  private states: ExecutorStatus[];
  private custom: CustomExecutor[];
  private readonly disabled: ReadonlySet<ExecutorType>;
  private readonly installing = new Map<ExecutorType, { controller: AbortController; done: Promise<void> }>();
  private closed = false;
  private storageFailed = false;
  private closing: Promise<void> | undefined;
  constructor(profiles: readonly Executor[], private readonly discovery?: ExecutorDiscovery,
    disabled: readonly ExecutorType[] = [], private readonly customFiles?: CustomExecutorFiles) {
    this.disabled = new Set(disabled);
    this.custom = customFiles?.read() ?? [];
    const found = discovery?.discover();
    this.profiles = structuredClone((found?.executors ?? profiles).filter(profile => !this.isDisabled(profile.type)));
    this.states = found ? found.states.map(entry => this.isDisabled(entry.type)
      ? { ...entry, state: "disabled", error: null } : { ...entry })
      : profiles.map(profile => status(profile, this.isDisabled(profile.type) ? "disabled" : "ready"));
    this.refreshCustom();
  }
  private isDisabled(type: Executor["type"]): boolean { return type !== "custom" && this.disabled.has(type); }
  private checkOpen(): void {
    if (this.closed) throw new TaskError("unavailable", "Executor registry closed");
    if (this.storageFailed) throw new StorageError("Custom executor storage unavailable; stop and inspect");
  }
  list() { this.checkOpen(); return { executors: structuredClone(this.states) }; }
  register(value: CustomExecutor) {
    this.checkOpen();
    const entry = customExecutorSchema.parse(value);
    if (!this.customFiles || !this.discovery) throw new TaskError("unavailable", "Custom registration unavailable");
    if (this.states.some(item => item.id === entry.id)) throw new TaskError("conflict", "Executor ID already registered; existing launches are never overwritten");
    try { this.discovery.check(customProfile(entry)); }
    catch { throw new TaskError("validation", "Custom ACP command must be an existing canonical absolute executable; cwd, when set, must be an accessible canonical absolute directory"); }
    this.publishCustom([...this.custom, entry]);
    return this.list();
  }
  unregister(id: string) {
    this.checkOpen();
    customExecutorId.parse(id);
    if (!this.custom.some(entry => entry.id === id)) throw new TaskError("not_found", "Custom executor not found");
    this.publishCustom(this.custom.filter(entry => entry.id !== id));
    return this.list();
  }
  private publishCustom(entries: CustomExecutor[]): void {
    if (!this.customFiles) throw new TaskError("unavailable", "Custom registration unavailable");
    const checked = customExecutorsSchema.parse(entries);
    try { this.customFiles.publish(checked); }
    catch (error) {
      if (error instanceof StorageError) this.storageFailed = true;
      throw error;
    }
    // Durable publication precedes admission. This synchronous section cannot interleave with dispatch.
    this.custom = checked;
    this.refreshCustom();
  }
  private refreshCustom(): void {
    if (!this.customFiles) return;
    this.profiles = this.profiles.filter(entry => entry.type !== "custom");
    this.states = this.states.filter(entry => entry.type !== "custom");
    for (const entry of this.custom) {
      const profile = customProfile(entry), state = status(profile);
      try {
        if (!this.discovery) throw new Error("Discovery unavailable");
        this.discovery.check(profile);
        this.profiles.push(profile);
      } catch {
        state.state = "error";
        state.error = "Custom ACP executable or startup directory is missing, inaccessible or no longer canonical";
      }
      this.states.push(state);
    }
  }
  refresh() {
    this.checkOpen();
    if (!this.discovery) return this.list();
    const found = this.discovery.discover();
    this.profiles = structuredClone(found.executors.filter(profile => !this.isDisabled(profile.type) &&
      (profile.type === "custom" || !this.installing.has(profile.type))));
    this.states = found.states.map(entry => {
      if (this.isDisabled(entry.type)) return { ...entry, state: "disabled" as const, error: null };
      if (entry.type !== "custom" && this.installing.has(entry.type)) return { ...entry, state: "installing" as const, error: null };
      return { ...entry };
    });
    for (const entry of this.states) {
      if (entry.state === "missing" && entry.nativePath !== null) this.install(entry, false);
    }
    this.refreshCustom();
    return this.list();
  }
  upgrade(id: string) {
    this.checkOpen();
    const entry = this.states.find(item => item.id === id);
    if (!this.discovery || !entry || !entry.nativePath) throw new TaskError("not_found", "Executor is not installed: " + id);
    if (this.isDisabled(entry.type)) throw new TaskError("precondition", "Executor is disabled: " + id);
    if (entry.type === "custom" || entry.type === "opencode") throw new TaskError("precondition", "Update this ACP executable through its native installation channel");
    this.install(entry, true);
    return this.list();
  }
  private install(entry: ExecutorStatus, upgrade: boolean): void {
    const discovery = this.discovery, type = entry.type;
    if (!discovery || type === "custom" || this.installing.has(type)) return;
    const controller = new AbortController(), expectedPath = entry.nativePath;
    this.profiles = this.profiles.filter(profile => profile.type !== type);
    Object.assign(entry, { state: "installing", error: null });
    const done = Promise.resolve().then(async () => {
      try {
        if (this.closed || controller.signal.aborted) return;
        const executor = await discovery.install(type, upgrade, controller.signal);
        if (this.closed) return;
        if (executor.type !== type || executor.id !== entry.id || executor.nativePath !== expectedPath) {
          throw new TaskError("conflict", "Native executor changed during adapter installation; refresh discovery");
        }
        discovery.check(executor);
        this.profiles = [...this.profiles.filter(profile => profile.type !== type), structuredClone(executor)];
        this.states = this.states.map(item => item.type === type ? status(executor) : item);
      } catch (error) {
        if (!this.closed) this.states = this.states.map(item => item.type === type ?
          { ...item, state: "error", error: errorText(error) } : item);
      } finally { this.installing.delete(type); }
    });
    this.installing.set(type, { controller, done });
  }
  private ready(id: string): Executor {
    const profile = this.profiles.find(item => item.id === id);
    if (!profile) {
      const entry = this.states.find(item => item.id === id);
      throw new TaskError("precondition", "Executor is not ready: " + id + (entry ? " (" + entry.state + ")" : ""));
    }
    this.discovery?.check(profile);
    return profile;
  }
  snapshot(ids: readonly string[]): Record<string, Executor> {
    this.checkOpen();
    const result: Record<string, Executor> = Object.create(null) as Record<string, Executor>;
    for (const id of ids) result[id] = structuredClone(this.ready(id));
    return result;
  }
  authorize(snapshot: Executor | undefined): Executor {
    this.checkOpen();
    if (!snapshot) throw new TaskError("precondition", "Executor snapshot is missing");
    const current = this.ready(snapshot.id);
    if (!authorizedProfile(snapshot, current)) throw new TaskError("conflict", "Executor launch changed; existing task assignment cannot be replaced");
    return structuredClone(current);
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const entry of this.installing.values()) entry.controller.abort();
    this.closing = Promise.all([...this.installing.values()].map(entry => entry.done)).then(() => undefined);
    return this.closing;
  }
}
