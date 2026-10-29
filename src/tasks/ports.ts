import type { NotificationEvent, NotificationOrigin, Delivery, EndStatus, InputQuestion, MemoryItem, NodeRun, QuestionRequest, Task, TaskInput, TaskMessage, TaskRun } from "./model.js";

export interface TaskQueries {
  readonly healthy: boolean;
  get(id: string): Task;
  definitions(): Task[];
  run(id: string): TaskRun;
  rounds(taskId?: string): TaskRun[];
  activeRounds(taskId?: string): TaskRun[];
}
export interface DefinitionStore extends Pick<TaskQueries, "get" | "definitions" | "activeRounds" | "rounds"> {
  saveDefinition(task: Task): void;
}
export interface MessageStore extends TaskQueries {
  message(id: string): TaskMessage;
  messages(taskId: string, after?: number, limit?: number, publicOnly?: boolean): { items: TaskMessage[]; next: number | null };
  pending(taskId?: string): TaskMessage[];
  request(taskId: string, key: string): TaskMessage | undefined;
  saveMessages(messages: TaskMessage[], task?: Task): void;
}
export interface RunStore extends MessageStore {
  saveDefinition(task: Task): void;
  commitRun(run: TaskRun, task?: Task, messages?: TaskMessage[], notifications?: NotificationEvent[]): void;
}
export interface NotificationStore {
  acquireNotificationLease(origin: NotificationOrigin, owner: string, now: number, until: number): boolean;
  releaseNotificationLease(origin: NotificationOrigin, owner: string): void;
  pendingNotifications(origin: NotificationOrigin, limit: number): NotificationEvent[];
  acknowledgeNotifications(origin: NotificationOrigin, owner: string, eventIds: string[], now: number): void;
}
export interface WorkspaceAccess { resolve(path: string): string; check(path: string): void; }
export interface Deliveries {
  readonly root: string;
  readable(path: string): void;
  save(taskRunId: string, nodeId: string, deliveryId: string, text: string): string;
}
export type ExecutionSession = {
  prompt(text: string, inputFiles?: string[]): Promise<{ stopReason: string }>;
  close(): Promise<void>;
  closed: Promise<void>;
};
export type OpenExecution = (input: { executor: ExecutorLaunch; workspace: string; inputFiles: string[]; resultsRoot: string },
  event: (kind: string, data: unknown, text: string) => void, beforeStart: () => void) => ExecutionSession;
type ExecutorLaunch = Task["executors"][string];

export type CoordinatorActions = {
  inspect(runId?: string): { budget: { modelCalls: number; maxModelCalls: number }; taskId: string; task: TaskInput; run: TaskRun | null; messages: TaskMessage[];
    execution: { runId: string; contextMessages: TaskMessage[] } | null };
  readMessage(messageId: string): TaskMessage;
  check(): void;
  requestModel(): void;
  converse(nodeId: string, message?: string, contextMessageIds?: string[]): Promise<NodeRun>;
  accept(nodeId: string, turn: number, result: string, reason: string, reuse?: boolean, reviewedMessageIds?: string[]): Promise<Delivery>;
  finish(summary: string): void;
  ask(request: QuestionRequest): InputQuestion;
  stop(status: EndStatus, reason: string): void;
  pending(): TaskMessage[];
  submitted(id: string, submissionId: string): void;
  observe(ids: string[]): void;
  settle(id: string, error?: string): void;
  binding(): { conversationId: string | null; cursor: string | null; runId: string | null };
  bind(conversationId: string): void;
  project(cursor: string, runId: string | null, text?: string): void;
  validateMemory(items: MemoryItem[]): void;
  updateMemory(current: MemoryItem[], items: MemoryItem[], removeKeys: string[]): MemoryItem[];
};
export type Coordinate = (taskId: string, input: TaskMessage, actions: CoordinatorActions, signal: AbortSignal, reconcileOnly?: boolean) => Promise<void>;
