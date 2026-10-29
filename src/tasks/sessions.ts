import type { ExecutionSession, OpenExecution } from "./ports.js";

type OwnedSession = { runId: string; handle: ExecutionSession; readsInputFiles: boolean } & (
  { state: "open"; timer: ReturnType<typeof setTimeout> } | { state: "closing"; completion: Promise<void> }
);

/** Owns every opened handle and its lifetime timer, including sessions retained while waiting for facts. */
export class NodeSessions {
  private readonly sessions = new Map<string, OwnedSession>();
  private closing?: Promise<void>;
  constructor(private readonly openExecution: OpenExecution, private readonly fatal: (error: unknown) => void) {}
  get size(): number { return this.sessions.size; }
  has(id: string): boolean { return !this.closing && this.sessions.get(id)?.state === "open"; }
  async retireWithoutInputFiles(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (session && !session.readsInputFiles) await this.closeSession(id);
  }
  closingSession(id: string): Promise<void> | undefined {
    const session = this.sessions.get(id);
    return session?.state === "closing" ? session.completion : undefined;
  }
  runIds(): string[] { return [...new Set([...this.sessions.values()].map(value => value.runId))]; }
  nodeIds(): string[] { return [...this.sessions.keys()]; }
  get(id: string): ExecutionSession {
    const active = this.sessions.get(id);
    if (this.closing || active?.state !== "open") throw new Error("ACP session unavailable or closing");
    return active.handle;
  }
  open(id: string, runId: string, input: Parameters<OpenExecution>[0], seconds: number,
    event: Parameters<OpenExecution>[1], beforeStart: () => void, expired: () => void, disconnected: () => void): ExecutionSession {
    if (this.closing) throw new Error("Node sessions closed");
    if (this.sessions.has(id)) throw new Error("Node session already exists");
    const handle = this.openExecution(input, event, beforeStart);
    const timer = setTimeout(expired, seconds * 1000);
    this.sessions.set(id, { runId, handle, readsInputFiles: input.inputFiles.length > 0, state: "open", timer });
    void handle.closed.then(() => {
      if (this.sessions.get(id)?.state === "open" && !this.closing) disconnected();
    }).catch(this.fatal);
    return handle;
  }
  closeSession(id: string): Promise<void> {
    const owned = this.sessions.get(id);
    if (!owned) return Promise.resolve();
    if (owned.state === "closing") return owned.completion;
    clearTimeout(owned.timer);
    // Mark closing before the handle can report a disconnect; concurrent close calls share completion.
    const completion = Promise.resolve().then(() => owned.handle.close()).then(() => { this.sessions.delete(id); });
    this.sessions.set(id, { runId: owned.runId, handle: owned.handle, readsInputFiles: owned.readsInputFiles, state: "closing", completion });
    return completion;
  }
  async closeRun(id: string): Promise<void> {
    const results = await Promise.allSettled([...this.sessions].filter(([, value]) => value.runId === id).map(([key]) => this.closeSession(key)));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.closeSession(id)));
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
  }
}
