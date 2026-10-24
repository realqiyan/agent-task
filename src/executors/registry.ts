import { errorText, TaskError } from "../shared/errors.js";
import type { Executor, ExecutorStatus, ExecutorType } from "./model.js";
import type { ExecutorDiscovery } from "./ports.js";

export function sameExecutor(a: Executor, b: Executor): boolean {
  return a.id === b.id && a.type === b.type && a.nativePath === b.nativePath;
}
export function authorizedProfile(snapshot: Executor | undefined, current: Executor | undefined): boolean {
  return Boolean(snapshot && current && sameExecutor(snapshot, current));
}
function status(executor: Executor, state: ExecutorStatus["state"] = "ready"): ExecutorStatus {
  return { id: executor.id, type: executor.type, nativePath: executor.nativePath,
    state, adapterVersion: executor.adapterVersion, error: null };
}

/** Owns the ready executor set and adapter installation lifetime, not native tool permissions. */
export class ExecutorRegistry {
  private profiles: Executor[];
  private states: ExecutorStatus[];
  private readonly disabled: ReadonlySet<ExecutorType>;
  private readonly installing = new Map<ExecutorType, { controller: AbortController; done: Promise<void> }>();
  private closed = false;
  private closing: Promise<void> | undefined;
  constructor(profiles: readonly Executor[], private readonly discovery?: ExecutorDiscovery,
    disabled: readonly ExecutorType[] = []) {
    this.disabled = new Set(disabled);
    const found = discovery?.discover();
    this.profiles = structuredClone((found?.executors ?? profiles).filter(profile => !this.disabled.has(profile.type)));
    this.states = found ? found.states.map(entry => this.disabled.has(entry.type)
      ? { ...entry, state: "disabled", error: null } : { ...entry })
      : profiles.map(profile => status(profile, this.disabled.has(profile.type) ? "disabled" : "ready"));
  }
  private checkOpen(): void { if (this.closed) throw new TaskError("unavailable", "Executor registry closed"); }
  list() { this.checkOpen(); return { executors: structuredClone(this.states) }; }
  refresh() {
    this.checkOpen();
    if (!this.discovery) return this.list();
    const found = this.discovery.discover();
    this.profiles = structuredClone(found.executors.filter(profile => !this.disabled.has(profile.type) && !this.installing.has(profile.type)));
    this.states = found.states.map(entry => {
      if (this.disabled.has(entry.type)) return { ...entry, state: "disabled" as const, error: null };
      if (this.installing.has(entry.type)) return { ...entry, state: "installing" as const, error: null };
      return { ...entry };
    });
    for (const entry of this.states) {
      if (entry.state === "missing" && entry.nativePath !== null) this.install(entry, false);
    }
    return this.list();
  }
  upgrade(id: string) {
    this.checkOpen();
    const entry = this.states.find(item => item.id === id);
    if (!this.discovery || !entry || !entry.nativePath) throw new TaskError("not_found", "Executor is not installed: " + id);
    if (this.disabled.has(entry.type)) throw new TaskError("precondition", "Executor is disabled: " + id);
    if (entry.type === "opencode") throw new TaskError("precondition", "OpenCode uses its native ACP command; update the native CLI directly");
    this.install(entry, true);
    return this.list();
  }
  private install(entry: ExecutorStatus, upgrade: boolean): void {
    const discovery = this.discovery;
    if (!discovery || this.installing.has(entry.type)) return;
    const controller = new AbortController(), expectedPath = entry.nativePath;
    this.profiles = this.profiles.filter(profile => profile.type !== entry.type);
    Object.assign(entry, { state: "installing", error: null });
    const done = Promise.resolve().then(async () => {
      try {
        if (this.closed || controller.signal.aborted) return;
        const executor = await discovery.install(entry.type, upgrade, controller.signal);
        if (this.closed) return;
        if (executor.type !== entry.type || executor.id !== entry.id || executor.nativePath !== expectedPath) {
          throw new TaskError("conflict", "Native executor changed during adapter installation; refresh discovery");
        }
        discovery.check(executor);
        this.profiles = [...this.profiles.filter(profile => profile.type !== entry.type), structuredClone(executor)];
        this.states = this.states.map(item => item.type === entry.type ? status(executor) : item);
      } catch (error) {
        if (!this.closed) this.states = this.states.map(item => item.type === entry.type ?
          { ...item, state: "error", error: errorText(error) } : item);
      } finally { this.installing.delete(entry.type); }
    });
    this.installing.set(entry.type, { controller, done });
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
    if (!authorizedProfile(snapshot, current)) throw new TaskError("conflict", "Native executor changed; existing task assignment cannot be replaced");
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
