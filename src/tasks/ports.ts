import type { Executor } from "../executors/model.js";
import type { CoordinatorInput, InputQuestion, NodeRun, QuestionRequest, Task, TaskInput, TaskRun } from "./model.js";

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
/** Only TaskRuns receives the write capability for runs and their coupled task cursor. */
export interface RunStore extends TaskQueries {
  saveDefinition(task: Task): void;
  commitRun(run: TaskRun, task?: Task): void;
}
export interface WorkspaceAccess { resolve(path: string): string; check(path: string): void; }
export interface Deliveries {
  readonly root: string;
  readable(path: string): void;
  save(taskRunId: string, nodeId: string, nodeRunId: string, text: string): string;
}
export type ExecutionSession = {
  prompt(text: string): Promise<{ stopReason: string }>;
  close(): Promise<void>;
  closed: Promise<void>;
};
export type OpenExecution = (input: { executor: Executor; inputFiles: string[]; resultsRoot: string },
  event: (kind: string, data: unknown, text: string) => void, beforeStart: () => void) => ExecutionSession;

/** The coordinator has no process, database, credentials, or general filesystem capability. */
export type CoordinatorActions = {
  inspect(): { task: TaskInput; run: TaskRun };
  step(): void;
  converse(nodeId: string, message?: string): Promise<NodeRun>;
  accept(nodeId: string, turn: number, result: string, reason: string): Promise<void>;
  finish(summary: string): void;
  ask(request: QuestionRequest): InputQuestion;
  stop(status: "failed", reason: string): void;
};
export type Coordinate = (runId: string, input: CoordinatorInput, actions: CoordinatorActions, signal: AbortSignal) => Promise<void>;
