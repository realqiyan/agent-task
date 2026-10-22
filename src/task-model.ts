import type { Executor, Schedule } from "./model.js";

export type NodeDefinition = { id: string; prompt: string; executorId: string; dependsOn: string[]; maxRunSeconds: number };
export type TaskInput = { requestKey: string; name: string; prompt: string; nodes: NodeDefinition[];
  workspace?: string; schedule: Schedule; expiresAt?: string; maxRunSeconds: number; maxSteps: number; maxNodeTurns: number; inputWaitSeconds: number };
export type Task = { id: string; input: TaskInput; workspace: string | null; executors: Record<string, Executor>;
  status: "active" | "paused" | "cancelled" | "completed" | "expired"; nextAt: number | null; createdAt: string };
export type Turn = { prompt: string; output: string; stopReason: string | null };
export type NodeRun = { id: string; definition: NodeDefinition;
  status: "pending" | "running" | "awaiting_review" | "succeeded" | "failed" | "blocked" | "interrupted";
  workspace: string | null; inputFiles: string[]; resultFile: string | null; result: string | null; acceptance: string | null;
  turns: Turn[]; error: string | null; sessionId: string | null; startedAt: string | null; eventCount: number };
export type TaskRun = { id: string; taskId: string; scheduledAt: number;
  status: "running" | "succeeded" | "failed" | "interrupted" | "skipped" | "cancelled" | "timed_out" | "waiting_input";
  createdAt: string; finishedAt: string | null; error: string | null; skippedCount: number;
  steps: number; coordinatorStartedAt: string | null; summary: string | null; nodes: NodeRun[]; questions: InputQuestion[]; waitedMs: number };

export type QuestionRequest = { nodeId?: string; question: string; completedWork: string };
export type InputReply = { runId: string; questionId: string; requestKey: string; answer: string };
export type InputQuestion = QuestionRequest & { id: string; createdAt: string; expiresAt: string;
  sessionExpiresAt: string | null; reply: { requestKey: string; answer: string; receivedAt: string } | null };
export type CoordinatorInput = { requestId: string; content: string };

export type ExecutionSession = {
  prompt(text: string): Promise<{ stopReason: string }>;
  close(): Promise<void>;
  closed: Promise<void>;
};
export type OpenExecution = (input: { executor: Executor; inputFiles: string[] },
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
