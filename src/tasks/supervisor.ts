import { errorText, StorageError, TaskError } from "../shared/errors.js";
import { MAX_ACTIVE_COORDINATORS, MAX_CONVERSATION_SECONDS, MAX_NODE_SESSIONS, MAX_TASKS } from "../shared/limits.js";
import type { TaskConversations } from "./conversations.js";
import type { EndStatus, InputReply, MessageRequest, NodeRun, TaskMessage } from "./model.js";
import type { Coordinate, CoordinatorActions, OpenExecution } from "./ports.js";
import type { TaskRuns } from "./runs.js";
import { NodeSessions } from "./sessions.js";

type Owner = { runId: string | null; controller: AbortController; completion: Promise<void>; timer: ReturnType<typeof setTimeout> };
/** One coordinator owner per Task; the SDK owns all model and tool scheduling. */
export class TaskSupervisor {
  private closed = false;
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly active = new Map<string, Owner>();
  private readonly turns = new Set<Promise<NodeRun>>();
  private readonly sessions: NodeSessions;
  constructor(private readonly runs: TaskRuns, private readonly conversations: TaskConversations, openExecution: OpenExecution,
    private readonly coordinate: Coordinate | undefined, private readonly fatal: (error: unknown) => void) {
    this.sessions = new NodeSessions(openExecution, fatal);
  }
  private check(): void { if (this.closed) throw new TaskError("unavailable", "Task supervisor closed"); }
  status() {
    return { running: !this.closed && this.timer !== undefined && this.runs.healthy,
      activeTaskRunIds: [...this.active.values()].flatMap(owner => owner.runId ? [owner.runId] : []),
      activeTaskIds: [...this.active.keys()], activeNodeRunIds: this.sessions.nodeIds(),
      storageHealthy: this.runs.healthy, coordinatorConfigured: this.coordinate !== undefined,
      limits: { maxActiveConversations: MAX_ACTIVE_COORDINATORS, maxTasks: MAX_TASKS, maxNodeSessions: MAX_NODE_SESSIONS } };
  }
  actions(id: string, inputId = this.runs.get(id).inputId): CoordinatorActions {
    return this.conversationActions(this.conversations.get(inputId), true);
  }
  private conversationActions(input: TaskMessage, execution: boolean): CoordinatorActions {
    this.check();
    const { taskId, runId } = input;
    const current = () => { this.check(); if (execution) this.runs.current(runId!, input.id); };
    const execute = () => { current(); if (!execution || !runId) throw new TaskError("precondition", "Discussion does not authorize execution or answer a pending question"); return runId; };
    return {
      inspect: selected => {
        this.check();
        const view = this.runs.inspect(taskId, selected ?? runId);
        const bound = execution ? (view.run?.id === runId ? view : this.runs.inspect(taskId, runId)) : null;
        const modelCalls = execution ? bound!.run!.modelCalls : this.conversations.get(input.id).modelCalls;
        return { ...view, budget: { modelCalls, maxModelCalls: view.task.maxModelCalls }, execution: bound ? { runId: runId!, contextMessages: bound.messages } : null };
      },
      readMessage: id => { this.check(); return this.conversations.readMessage(taskId, id); },
      check: current,
      requestModel: () => { current(); if (execution) { try { this.runs.requestModel(runId!); } finally { this.reconcile(runId!); } } else this.conversations.requestModel(input.id); },
      converse: (node, message, contextMessageIds) => this.converse(execute(), node, message, contextMessageIds),
      accept: async (node, turn, result, reason, reuse) => this.runs.accept(execute(), node, turn, result, reason, reuse),
      ask: request => {
        const id = execute(), question = this.runs.ask(id, request);
        clearTimeout(this.active.get(taskId)?.timer); return question;
      },
      finish: summary => { this.runs.finish(execute(), summary); },
      stop: (status, reason) => { this.runs.end(execute(), status, reason); },
      pending: () => {
        this.check();
        if (execution) {
          const run = this.runs.get(runId!);
          if (run.status !== "running" || run.inputId !== input.id) return [];
        }
        return this.conversations.pending(taskId).filter(message => message.id === input.id ||
          (message.runId === runId && message.execute === execution && ["message", "supplement"].includes(message.kind)));
      },
      submitted: (id, submissionId) => { this.check(); this.conversations.submitted(id, submissionId); },
      observe: ids => { current(); this.runs.observe(taskId, execution ? runId : null, ids); },
      // 关闭入口后仍允许已准入输入收尾；所有者退出前业务库仍由应用持有。
      settle: (id, error) => { this.conversations.settle(id, error); },
      binding: () => this.conversations.binding(taskId),
      bind: id => { this.check(); this.conversations.bind(taskId, id); },
      project: (cursor, runId, text) => { this.conversations.project(taskId, cursor, runId, text); },
      validateMemory: items => { current(); this.conversations.validateMemory(taskId, items); },
    };
  }
  converse(id: string, nodeId: string, message?: string, contextMessageIds?: string[]): Promise<NodeRun> {
    const pending = this.performTurn(id, nodeId, message, contextMessageIds);
    this.turns.add(pending);
    void pending.finally(() => this.turns.delete(pending)).catch(() => {});
    return pending;
  }
  private accepted(id: string, nodeId: string): boolean {
    const node = this.runs.get(id).nodes.find(node => node.definition.id === nodeId)!;
    return ["succeeded", "stale"].includes(node.status) && node.deliveries.some(delivery => !delivery.source && delivery.turn === node.turns.length);
  }
  private async retireAccepted(): Promise<void> {
    if (this.sessions.size < MAX_NODE_SESSIONS) return;
    for (const run of this.runs.active()) for (const node of run.nodes) {
      if (this.sessions.has(node.id) && this.accepted(run.id, node.definition.id)) {
        await this.sessions.closeSession(node.id); return;
      }
    }
  }
  private async performTurn(id: string, nodeId: string, message?: string, contextMessageIds?: string[]): Promise<NodeRun> {
    this.check();
    const currentRun = this.runs.current(id), inputId = currentRun.inputId;
    const ownedNode = currentRun.nodes.find(node => node.definition.id === nodeId);
    let dispatched = false;
    try {
      const closing = ownedNode && this.sessions.closingSession(ownedNode.id);
      if (closing) await closing;
      if (this.sessions.size >= MAX_NODE_SESSIONS) await this.retireAccepted();
      this.check(); this.runs.current(id, inputId);
      const dispatch = this.runs.prepareTurn(id, nodeId, message, this.sessions, contextMessageIds);
      dispatched = true;
      const handle = dispatch.kind === "continue" ? this.sessions.get(dispatch.nodeRunId)
        : this.sessions.open(dispatch.nodeRunId, id, dispatch.input, dispatch.seconds,
          (kind, data, text) => this.runs.record(id, nodeId, kind, data, text),
          () => { this.check(); this.runs.beforeStart(id, nodeId); },
          () => {
            if (this.accepted(id, nodeId)) { void this.sessions.closeSession(dispatch.nodeRunId).catch(this.fatal); return; }
            const waiting = this.runs.get(id).status === "waiting_input";
            this.stopActive(id, waiting ? "interrupted" : "timed_out", waiting
              ? "ACP session lifetime expired while waiting; no replay" : "ACP node session timed out");
          },
          () => {
            if (this.closed || !this.runs.healthy) return;
            if (this.accepted(id, nodeId)) void this.sessions.closeSession(dispatch.nodeRunId).catch(this.fatal);
            else this.stopActive(id, "interrupted", "ACP session disconnected; external effects unknown");
          });
      const result = await handle.prompt(dispatch.text, dispatch.inputFiles);
      return this.runs.completeTurn(id, nodeId, result.stopReason);
    } catch (error) {
      if (error instanceof StorageError) this.fatal(error);
      else if (dispatched && !this.closed && this.runs.healthy) this.stopActive(id, "interrupted", errorText(error));
      throw error;
    } finally { if (!this.closed) this.reconcile(id); }
  }
  private reconcile(id: string): void {
    if (!this.runs.healthy) return;
    const run = this.runs.get(id);
    if (["running", "waiting_input"].includes(run.status)) return;
    const owner = this.active.get(run.taskId);
    if (owner?.runId === id) owner.controller.abort(new TaskError("precondition", run.error ?? "任务运行已停止"));
    void this.sessions.closeRun(id).catch(this.fatal);
  }
  private stopActive(id: string, status: EndStatus, reason: string): void {
    try { this.runs.end(id, status, reason); }
    catch (error) { this.fatal(error); }
    finally { this.reconcile(id); }
  }
  answer(input: InputReply, now = Date.now()) {
    this.check();
    try { return this.runs.answer(input, id => this.sessions.has(id), now); }
    finally { for (const run of this.runs.list(input.taskId).items) this.reconcile(run.id); }
  }
  send(input: MessageRequest, now = Date.now()) {
    this.check();
    return input.execute ? this.runs.supplement(input, now) : this.conversations.send(input, now);
  }
  cancel(id: string) {
    this.check(); this.runs.get(id);
    this.stopActive(id, "cancelled", "Run cancelled; external effects are not rolled back"); return this.runs.get(id);
  }
  recover(): void {
    this.check();
    if (this.active.size || this.sessions.size) throw new TaskError("conflict", "Recovery requires no active resources");
    this.runs.recover();
  }
  start(): void {
    this.check(); if (this.timer) throw new TaskError("conflict", "Task supervisor already started");
    this.recover(); this.timer = setInterval(() => this.tick(), 10_000); this.tick();
  }
  tick(): void {
    this.check();
    try {
      this.runs.trigger();
      for (const run of this.runs.active()) if (run.status === "waiting_input") { this.runs.expireWaiting(run.id); this.reconcile(run.id); }
      for (const input of this.conversations.pending()) {
        if (this.active.has(input.taskId) || this.active.size >= MAX_ACTIVE_COORDINATORS) continue;
        const run = input.runId ? this.runs.get(input.runId) : null;
        if (input.execute && run?.status === "running") {
          const admission = this.runs.admitCoordinator(run.id);
          if (admission) this.launch(admission.input, true, admission.remaining);
        } else if (input.execute) {
          if (this.conversations.binding(input.taskId).conversationId !== null) this.launch(input, false, MAX_CONVERSATION_SECONDS * 1000, true);
          else this.conversations.settle(input.id, "Execution is no longer active; no coordinator submission or replay.");
        } else {
          const remaining = this.conversations.admitTurn(input.id);
          if (remaining > 0) this.launch(input, false, remaining);
          else this.conversations.settle(input.id, "Conversation turn deadline reached");
        }
      }
    } catch (error) { if (this.timer) clearInterval(this.timer); this.fatal(error); }
  }
  private launch(input: TaskMessage, execution: boolean, remaining: number, reconcileOnly = false): void {
    const coordinate = this.coordinate, { taskId, runId } = input;
    if (!coordinate) { this.conversations.settle(input.id, "Coordinator not configured"); if (execution) this.runs.end(runId!, "failed", "Coordinator not configured"); return; }
    const stillCurrent = () => {
      if (!execution) return false;
      const current = this.runs.get(runId!);
      return current.status === "running" && current.inputId === input.id;
    };
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (execution) this.stopActive(runId!, "timed_out", "Task run timed out");
      else { this.conversations.settle(input.id, "Conversation turn timed out"); controller.abort(new Error("Conversation turn timed out")); }
    }, remaining);
    const completion = Promise.resolve().then(() => {
      this.check(); controller.signal.throwIfAborted();
      if (execution) this.runs.current(runId!, input.id);
      return coordinate(taskId, input, this.conversationActions(input, execution), controller.signal, reconcileOnly);
    }).then(() => {
      if (!this.closed && stillCurrent()) this.runs.end(runId!, "failed", "Coordinator ended without an explicit completion or blocking decision");
    }, error => {
      if (error instanceof StorageError) throw error;
      if (!this.closed && this.runs.healthy) {
        this.conversations.settle(input.id, errorText(error));
        if (stillCurrent()) this.runs.end(runId!, "failed", errorText(error));
      }
    }).catch(this.fatal).finally(async () => {
      clearTimeout(timer);
      try {
        if (runId && (!this.runs.healthy || !["running", "waiting_input"].includes(this.runs.get(runId).status))) await this.sessions.closeRun(runId);
      } finally { this.active.delete(taskId); }
      if (!this.closed && this.runs.healthy) this.tick();
    }).catch(this.fatal);
    this.active.set(taskId, { runId: execution ? runId : null, controller, completion, timer });
  }
  close(): Promise<void> { return this.closing ??= this.stop(); }
  private async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    const errors: unknown[] = [];
    const runIds = new Set([...this.sessions.runIds(), ...[...this.active.values()].flatMap(owner => owner.runId ? [owner.runId] : [])]);
    for (const id of runIds) {
      try {
        const run = this.runs.get(id);
        if (run.status === "running" || run.nodes.some(node => ["running", "awaiting_review"].includes(node.status))) {
          this.runs.end(id, "interrupted", "服务停止，活动协调或尚未验收的 ACP 工作已中断");
        }
      } catch (error) { errors.push(error); }
    }
    for (const active of this.active.values()) {
      clearTimeout(active.timer);
      active.controller.abort(new Error(active.runId && this.runs.healthy ? this.runs.get(active.runId).error ?? "服务停止" : "服务停止"));
    }
    const stopped = await Promise.allSettled([this.sessions.close(), ...[...this.active.values()].map(active => active.completion), ...this.turns]);
    if (stopped[0]?.status === "rejected") errors.push(stopped[0].reason);
    if (errors.length) throw new AggregateError(errors, "Task supervision could not close cleanly");
  }
}
