import { errorText, StorageError } from "../shared/errors.js";
import { coordinatorInput } from "./human-input.js";
import type { EndStatus, InputReply, NodeRun } from "./model.js";
import type { Coordinate, CoordinatorActions, OpenExecution } from "./ports.js";
import type { TaskRuns } from "./runs.js";
import { NodeSessions } from "./sessions.js";

/** Owns coordinator generations, the calendar clock and NodeSessions. All persisted decisions go through TaskRuns. */
export class RunSupervisor {
  private closed = false;
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, { controller: AbortController; completion: Promise<void>; timer: ReturnType<typeof setTimeout> }>();
  private readonly turns = new Set<Promise<NodeRun>>();
  private readonly sessions: NodeSessions;
  constructor(private readonly runs: TaskRuns, openExecution: OpenExecution,
    private readonly coordinate: Coordinate | undefined, private readonly fatal: (error: unknown) => void) {
    this.sessions = new NodeSessions(openExecution, fatal);
  }
  private check(): void { if (this.closed) throw new Error("Run supervisor closed"); }
  status() {
    return { running: !this.closed && this.timer !== undefined && this.runs.healthy,
      activeTaskRunIds: [...this.active.keys()], activeNodeRunIds: this.sessions.nodeIds(), storageHealthy: this.runs.healthy };
  }
  actions(id: string, requestId = coordinatorInput(this.runs.get(id)).requestId): CoordinatorActions {
    this.check();
    const current = () => { this.check(); return this.runs.current(id, requestId); };
    return {
      inspect: () => { current(); return this.runs.inspect(id, requestId); },
      step: () => { current(); try { this.runs.step(id); } finally { this.reconcile(id); } },
      converse: (node, message) => { current(); return this.converse(id, node, message); },
      accept: (node, turn, result, reason) => { current(); return this.accept(id, node, turn, result, reason); },
      ask: request => {
        current(); const question = this.runs.ask(id, request);
        clearTimeout(this.active.get(id)?.timer); return question;
      },
      finish: summary => { current(); this.runs.finish(id, summary); },
      stop: (status, reason) => { current(); this.stopActive(id, status, reason); },
    };
  }
  converse(id: string, nodeId: string, message?: string): Promise<NodeRun> {
    const pending = this.performTurn(id, nodeId, message);
    this.turns.add(pending);
    void pending.finally(() => this.turns.delete(pending)).catch(() => {});
    return pending;
  }
  private async performTurn(id: string, nodeId: string, message?: string): Promise<NodeRun> {
    this.check();
    let dispatched = false;
    try {
      const dispatch = this.runs.prepareTurn(id, nodeId, message, this.sessions);
      dispatched = true;
      const handle = dispatch.kind === "continue" ? this.sessions.get(dispatch.nodeRunId)
        : this.sessions.open(dispatch.nodeRunId, id, dispatch.input, dispatch.seconds,
          (kind, data, text) => this.runs.record(id, nodeId, kind, data, text),
          () => { this.check(); this.runs.beforeStart(id, nodeId); },
          () => {
            const waiting = this.runs.get(id).status === "waiting_input";
            this.stopActive(id, waiting ? "interrupted" : "timed_out", waiting
              ? "ACP session lifetime expired while waiting; no replay" : "ACP node session timed out");
          },
          () => { if (!this.closed && this.runs.healthy) this.stopActive(id, "interrupted", "ACP session disconnected; external effects unknown"); });
      const result = await handle.prompt(dispatch.text);
      return this.runs.completeTurn(id, nodeId, result.stopReason);
    } catch (error) {
      if (error instanceof StorageError) this.fatal(error);
      else if (dispatched && !this.closed && this.runs.healthy) this.stopActive(id, "interrupted", errorText(error));
      throw error;
    } finally { if (!this.closed) this.reconcile(id); }
  }
  async accept(id: string, nodeId: string, turn: number, result: string, reason: string): Promise<void> {
    this.check();
    const owned = this.runs.accept(id, nodeId, turn, result, reason);
    await this.sessions.closeSession(owned);
  }
  private reconcile(id: string): void {
    if (!this.runs.healthy) return;
    if (["running", "waiting_input"].includes(this.runs.get(id).status)) return;
    this.active.get(id)?.controller.abort(new Error("Run stopped"));
    void this.sessions.closeRun(id).catch(this.fatal);
  }
  private stopActive(id: string, status: EndStatus, reason: string): void {
    try { this.runs.end(id, status, reason); }
    catch (error) { this.fatal(error); }
    finally {
      this.active.get(id)?.controller.abort(new Error(reason));
      void this.sessions.closeRun(id).catch(this.fatal);
    }
  }
  reply(input: InputReply, now = Date.now()) {
    this.check();
    try { return this.runs.reply(input, id => this.sessions.has(id), now); }
    finally { this.reconcile(input.runId); }
  }
  cancel(id: string) {
    this.check(); this.runs.get(id);
    this.stopActive(id, "cancelled", "Run cancelled; external effects are not rolled back"); return this.runs.get(id);
  }
  recover(): void {
    this.check();
    if (this.active.size || this.sessions.size) throw new Error("Recovery requires no active resources");
    this.runs.recover();
  }
  start(): void {
    this.check(); if (this.timer) throw new Error("Run supervisor already started");
    this.recover(); this.timer = setInterval(() => this.tick(), 10_000); this.tick();
  }
  tick(): void {
    this.check();
    try {
      this.runs.trigger();
      for (const run of this.runs.active()) {
        if (run.status === "waiting_input") { this.runs.expireWaiting(run.id); this.reconcile(run.id); continue; }
        if (this.active.has(run.id) || this.active.size >= 4) continue;
        this.launch(run.id);
      }
    } catch (error) { if (this.timer) clearInterval(this.timer); this.fatal(error); }
  }
  private launch(id: string): void {
    const coordinate = this.coordinate;
    if (!coordinate) { this.runs.end(id, "failed", "Coordinator not configured"); return; }
    const admission = this.runs.admitCoordinator(id);
    if (!admission) return;
    const { input, remaining } = admission;
    const stillCurrent = () => {
      const current = this.runs.get(id);
      return current.status === "running" && coordinatorInput(current).requestId === input.requestId;
    };
    const controller = new AbortController();
    const timer = setTimeout(() => this.stopActive(id, "timed_out", "Task run timed out"), remaining);
    // Register the controller before the deferred external entry. Recheck generation and cancellation there.
    const completion = Promise.resolve().then(() => {
      this.check(); controller.signal.throwIfAborted(); this.runs.current(id, input.requestId);
      return coordinate(id, input, this.actions(id, input.requestId), controller.signal);
    }).then(() => {
      if (!this.closed && stillCurrent()) this.runs.end(id, "failed", "Coordinator ended without an explicit completion or blocking decision");
    }, error => {
      if (error instanceof StorageError) throw error;
      if (!this.closed && this.runs.healthy && stillCurrent()) this.runs.end(id, "failed", errorText(error));
    }).catch(this.fatal).finally(async () => {
      clearTimeout(timer);
      try {
        if (!this.runs.healthy || !["running", "waiting_input"].includes(this.runs.get(id).status)) await this.sessions.closeRun(id);
      } finally { this.active.delete(id); }
    }).catch(this.fatal);
    this.active.set(id, { controller, completion, timer });
  }
  close(): Promise<void> { return this.closing ??= this.stop(); }
  private async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const errors: unknown[] = [];
    for (const id of this.sessions.runIds()) {
      try { this.runs.end(id, "interrupted", "Service stopped with an open ACP session"); } catch (error) { errors.push(error); }
    }
    for (const active of this.active.values()) { clearTimeout(active.timer); active.controller.abort(new Error("Service stopping")); }
    const stopped = await Promise.allSettled([this.sessions.close(), ...[...this.active.values()].map(active => active.completion), ...this.turns]);
    // Rejected prompts are expected during cancellation; resource-close failures remain fatal.
    if (stopped[0]?.status === "rejected") errors.push(stopped[0].reason);
    if (errors.length) throw new AggregateError(errors, "Run supervision could not close cleanly");
  }
}
