import type { Executor } from "../executors/model.js";

export type Schedule = { type: "now" } | { type: "once"; at: string } | { type: "interval"; startAt: string; seconds: number };

export type NodeDefinition = { id: string; prompt: string; executorId: string; dependsOn: string[]; maxRunSeconds: number };
export type TaskInput = { requestKey: string; name: string; prompt: string; nodes: NodeDefinition[];
  workspace?: string; schedule: Schedule; expiresAt?: string; maxRunSeconds: number; maxSteps: number; maxNodeTurns: number; inputWaitSeconds: number };
export type Task = { id: string; input: TaskInput; workspace: string; executors: Record<string, Executor>;
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


export type EndStatus = "failed" | "interrupted" | "cancelled" | "timed_out";
export type TaskUpdate = { id: string; action: "pause" | "resume" | "cancel" };
