import { randomUUID } from "node:crypto";
import { iso } from "../shared/time.js";
import { TaskError } from "../shared/errors.js";
import { MAX_CONVERSATION_SECONDS, MAX_PENDING_TASK_INPUTS } from "../shared/limits.js";
import type { MemoryItem, MemorySource, MessageRequest, TaskMessage } from "./model.js";
import type { MessageStore } from "./ports.js";
import { memoryItemData, messageData } from "./validation.js";

export function inputMessage(taskId: string, runId: string | null, key: string, content: string,
  kind: TaskMessage["kind"], execute: boolean, request = "", now = Date.now()): TaskMessage {
  return { id: randomUUID(), taskId, runId, questionId: null, requestKey: key, request, content, execute,
    startedAt: null, role: kind === "execution" ? "system" : "user", kind, seen: false, modelCalls: 0, status: "queued",
    submissionId: null, error: null, createdAt: iso(now), finishedAt: null };
}

/** Reliable input and public history. This service never writes Run state or owns a model loop. */
export class TaskConversations {
  private closed = false;
  private accepting = true;
  stopAdmission(): void { this.accepting = false; }
  private checkAdmission(): void {
    this.check();
    if (!this.accepting) throw new TaskError("unavailable", "Task conversation admission closed");
  }
  private check(): void { if (this.closed) throw new TaskError("unavailable", "Task conversations closed"); }
  close(): void { this.closed = true; }
  constructor(private readonly store: MessageStore, private readonly configured: () => boolean) {}

  duplicate(taskId: string, key: string, request: string): TaskMessage | undefined {
    this.checkAdmission();
    const existing = this.store.request(taskId, key);
    if (existing && existing.request !== request) throw new TaskError("conflict", "Input requestKey belongs to different input");
    return existing;
  }

  admit(taskId: string): void {
    this.checkAdmission();
    this.store.get(taskId);
    if (!this.configured()) throw new TaskError("precondition", "Coordinator is not configured");
    if (this.store.pending(taskId).length >= MAX_PENDING_TASK_INPUTS) throw new TaskError("precondition", "Task input queue is full");
  }

  send(value: MessageRequest, now = Date.now()): TaskMessage {
    this.checkAdmission();
    const input = messageData.parse(value);
    const request = JSON.stringify({ type: "message", ...input, execute: input.execute ?? false });
    const existing = this.duplicate(input.taskId, input.requestKey, request);
    if (existing) return existing;
    if (input.execute) throw new TaskError("validation", "Supplementary execution requires Run admission");
    this.admit(input.taskId);
    const active = this.store.activeRounds(input.taskId)[0];
    if (input.runId && this.store.run(input.runId).taskId !== input.taskId) throw new TaskError("validation", "Run belongs to another task");
    const runId = input.runId ?? active?.id ?? null;
    const message = inputMessage(input.taskId, runId, input.requestKey, input.message, "message", active?.id === runId && active.status === "running", request, now);
    this.store.saveMessages([message]);
    return message;
  }

  list(taskId: string, after = 0, limit = 20) {
    this.checkAdmission();
    this.store.get(taskId);
    return this.store.messages(taskId, after, limit, true);
  }

  pending(taskId?: string): TaskMessage[] { this.check(); return this.store.pending(taskId); }
  get(id: string): TaskMessage { this.check(); return this.store.message(id); }

  submitted(id: string, submissionId: string): void {
    const message = this.get(id);
    if (message.submissionId && message.submissionId !== submissionId) throw new TaskError("conflict", "Input is already bound to another SDK submission");
    message.submissionId = submissionId;
    if (message.status === "queued") message.status = "submitted";
    this.store.saveMessages([message]);
  }

  settle(id: string, error?: string): void {
    const message = this.get(id);
    if (message.status === "processed" || message.status === "failed") return;
    message.status = error ? "failed" : "processed";
    message.error = error ?? null;
    message.finishedAt = iso(Date.now());
    this.store.saveMessages([message]);
  }

  admitTurn(id: string, now = Date.now()): number {
    const input = this.get(id), task = this.store.get(input.taskId);
    input.startedAt ??= iso(now);
    this.store.saveMessages([input]);
    return Date.parse(input.startedAt) + Math.min(MAX_CONVERSATION_SECONDS, task.input.maxRunSeconds) * 1000 - now;
  }

  requestModel(id: string): void {
    const input = this.get(id), task = this.store.get(input.taskId);
    if (input.modelCalls >= task.input.maxModelCalls) throw new TaskError("precondition", "本次对话的模型请求额度已耗尽");
    input.modelCalls++;
    this.store.saveMessages([input]);
  }

  binding(taskId: string) {
    this.check();
    const task = this.store.get(taskId);
    return { conversationId: task.conversationId, cursor: task.conversationCursor, runId: task.conversationRunId };
  }

  bind(taskId: string, conversationId: string): void {
    this.check();
    const task = this.store.get(taskId);
    if (task.conversationId && task.conversationId !== conversationId) throw new TaskError("conflict", "Task already owns another coordinator conversation");
    task.conversationId = conversationId;
    this.store.saveMessages([], task);
  }

  project(taskId: string, cursor: string, runId: string | null, text?: string): void {
    this.check();
    const task = this.store.get(taskId);
    if (runId && this.store.run(runId).taskId !== taskId) throw new TaskError("conflict", "Public message belongs to another task");
    const messages: TaskMessage[] = [];
    if (text?.trim() && !this.store.request(taskId, "entry:" + cursor)) {
      const message = inputMessage(taskId, runId, "entry:" + cursor, text, "message", false);
      Object.assign(message, { role: "coordinator", status: "processed", seen: true, finishedAt: iso(Date.now()) });
      messages.push(message);
    }
    task.conversationCursor = cursor;
    task.conversationRunId = runId;
    this.store.saveMessages(messages, task);
  }

  readMessage(taskId: string, id: string): TaskMessage {
    const message = this.get(id);
    if (message.taskId !== taskId) throw new TaskError("validation", "Message belongs to another Task");
    if (!message.seen) throw new TaskError("precondition", "Message has not reached an observation boundary");
    return message;
  }

  private memorySource(taskId: string, source: MemorySource, path: string): void {
    try {
      let owner: string;
      if (source.type === "task") owner = this.store.get(source.taskId).id;
      else if (source.type === "message") owner = this.store.message(source.messageId).taskId;
      else {
        const run = this.store.run(source.runId);
        owner = run.taskId;
        if (owner !== taskId) throw new TaskError("validation", `${path}.runId belongs to another Task`);
        if (source.type === "question" && !run.questions.some(question => question.id === source.questionId)) {
          throw new TaskError("validation", `${path}.questionId does not identify a question in the referenced Run`);
        }
        if (source.type === "delivery" && !run.nodes.some(node => node.definition.id === source.nodeId &&
          node.deliveries.some(delivery => delivery.id === source.deliveryId))) {
          throw new TaskError("validation", `${path}.deliveryId does not identify an accepted delivery of the referenced Run and node`);
        }
      }
      if (owner !== taskId) throw new TaskError("validation", `${path} belongs to another Task`);
    } catch (error) {
      if (error instanceof TaskError && error.code === "not_found") {
        const field = source.type === "task" ? "taskId" : source.type === "message" ? "messageId" : "runId";
        throw new TaskError("validation", `${path}.${field} does not identify an existing ${field === "taskId" ? "Task" : field === "messageId" ? "message" : "Run"}`);
      }
      throw error;
    }
  }

  validateMemory(taskId: string, items: MemoryItem[]): void {
    this.check();
    this.store.get(taskId);
    if (items.length > 40) throw new TaskError("precondition", "Task memory is limited to 40 items");
    const keys = new Set<string>();
    for (const value of items) {
      const item = memoryItemData.parse(value);
      if (keys.has(item.key)) throw new TaskError("validation", "Duplicate memory key");
      keys.add(item.key);
      if (item.scope.type === "run") this.memorySource(taskId, item.scope, `memory[${item.key}].scope`);
      item.sources.forEach((source, index) => this.memorySource(taskId, source, `memory[${item.key}].sources[${index}]`));
    }
    if (JSON.stringify(items).length > 24000) throw new TaskError("precondition", "Task memory exceeds 24000 characters");
  }
}
