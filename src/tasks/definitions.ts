import { randomUUID } from "node:crypto";
import type { ExecutorType } from "../executors/model.js";
import type { ExecutorRegistry } from "../executors/registry.js";
import { TaskError } from "../shared/errors.js";
import { MAX_TASKS } from "../shared/limits.js";
import { iso } from "../shared/time.js";
import type { Task, TaskInput, TaskUpdate } from "./model.js";
import type { DefinitionStore, WorkspaceAccess } from "./ports.js";
import { validateGraph } from "./graph.js";
import { hasUncertainOutcome, initialTime, resumeSchedule } from "./schedule.js";
import { taskData, taskUpdateData } from "./validation.js";

/** Owns task definitions and future-trigger controls. Never writes a run. */
export class TaskDefinitions {
  private closed = false;
  constructor(private readonly store: DefinitionStore, private readonly executors: ExecutorRegistry,
    private readonly workspaces: WorkspaceAccess, private readonly coordinatorConfigured: boolean) {}
  private check(): void { if (this.closed) throw new TaskError("unavailable", "Task definition service closed"); }
  create(value: TaskInput, now = Date.now()): Task {
    this.check();
    if (!this.coordinatorConfigured) throw new TaskError("precondition", "Coordinator is not configured");
    const input = taskData.parse(value), all = this.store.definitions();
    if (input.workspace === undefined) throw new TaskError("validation", "workspace is required without a local MCP launch directory");
    const workspace = this.workspaces.resolve(input.workspace);
    input.workspace = workspace;
    const existing = all.find(item => item.workspace === workspace && item.input.requestKey === input.requestKey);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new TaskError("conflict", "requestKey already used with different parameters");
      return existing;
    }
    if (all.length >= MAX_TASKS) throw new TaskError("precondition", "Task definition limit reached");
    validateGraph(input.nodes);
    const executors = this.executors.snapshot(input.nodes.map(node => node.executorId));
    const nextAt = initialTime(input.schedule, now);
    if (input.schedule.type !== "now" && nextAt < now) throw new TaskError("validation", "Schedule must start in the future");
    if (input.expiresAt && Date.parse(input.expiresAt) <= Math.max(now, nextAt)) throw new TaskError("validation", "Deadline must follow first trigger");
    const task: Task = { id: randomUUID(), input, workspace,
      executors, nextAt, status: "active", createdAt: iso(now) };
    this.store.saveDefinition(task); return task;
  }
  get(id: string): Task { this.check(); return this.store.get(id); }
  list(after = 0, limit = 20) {
    this.check(); const all = this.store.definitions();
    return { items: all.slice(after, after + limit), next: all.length > after + limit ? after + limit : null };
  }
  update(value: TaskUpdate, now = Date.now()): Task {
    this.check();
    const { id, action } = taskUpdateData.parse(value);
    let task = this.store.get(id);
    if (action === "cancel") { task.status = "cancelled"; task.nextAt = null; }
    else {
      if (task.nextAt === null || ["cancelled", "expired"].includes(task.status)) throw new TaskError("precondition", "Task has no future schedule");
      if (action === "pause") task.status = "paused";
      else {
        if (this.store.rounds(id).some(hasUncertainOutcome)) throw new TaskError("precondition", "Task has uncertain external outcomes; future triggers require reconciliation");
        task = resumeSchedule(task, now);
      }
    }
    this.store.saveDefinition(task); return task;
  }
  executorImpact(disabled: readonly ExecutorType[]) {
    this.check();
    return this.store.definitions().filter(task =>
      ((task.nextAt !== null && ["active", "paused"].includes(task.status)) || this.store.activeRounds(task.id).length > 0) &&
      Object.values(task.executors).some(snapshot => snapshot.type !== "custom" && disabled.includes(snapshot.type)))
      .map(task => ({ id: task.id, name: task.input.name }));
  }
  close(): void { this.closed = true; }
}
