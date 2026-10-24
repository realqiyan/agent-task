import { z } from "zod";
import { executorRecord } from "../../executors/validation.js";
import { absolutePath, identifier, text, timestamp } from "../../shared/validation.js";
import { nodeData, nodeStatusSchema, questionData, runStatusSchema, taskData, taskStatusSchema } from "../validation.js";

export const definitionSchema = z.object({
  id: z.string().uuid(), input: taskData, workspace: absolutePath, executors: z.record(identifier, executorRecord),
  status: taskStatusSchema,
  nextAt: z.number().finite().nullable(), createdAt: timestamp,
}).strict().refine(task => task.input.workspace === task.workspace, "Task workspace must match the canonical request");
export const roundSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), scheduledAt: z.number().finite(),
  status: runStatusSchema,
  createdAt: timestamp, finishedAt: timestamp.nullable(), error: z.string().nullable(), skippedCount: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(), coordinatorStartedAt: timestamp.nullable(), summary: z.string().nullable(),
  waitedMs: z.number().finite().nonnegative(),
  questions: z.array(questionData.extend({
    id: z.string().uuid(), createdAt: timestamp, expiresAt: timestamp, sessionExpiresAt: timestamp.nullable(),
    reply: z.object({ requestKey: identifier, answer: text(16000), receivedAt: timestamp }).strict().nullable(),
  })).max(20),
  nodes: z.array(z.object({
    id: z.string().uuid(), definition: nodeData,
    status: nodeStatusSchema,
    workspace: absolutePath.nullable(), inputFiles: z.array(absolutePath), resultFile: absolutePath.nullable(), result: z.string().nullable(), acceptance: z.string().nullable(),
    turns: z.array(z.object({ prompt: z.string(), output: z.string(), stopReason: z.string().nullable() }).strict()),
    error: z.string().nullable(), sessionId: z.string().nullable(), startedAt: timestamp.nullable(), eventCount: z.number().int().nonnegative(),
  }).strict().superRefine((node, context) => {
    if (["running", "awaiting_review", "succeeded"].includes(node.status) && (!node.startedAt || !node.turns.length)) {
      context.addIssue({ code: "custom", message: "Started nodes require a start time and turn" });
    }
    if (node.status === "succeeded" && (!node.resultFile || !node.result?.trim() || !node.acceptance?.trim() || node.turns.at(-1)?.stopReason !== "end_turn")) {
      context.addIssue({ code: "custom", message: "Accepted node requires a completed turn and delivery" });
    }
  })).min(1).max(20),
}).strict().superRefine((run, context) => {
  const live = ["running", "waiting_input"].includes(run.status);
  if (live !== (run.finishedAt === null)) context.addIssue({ code: "custom", message: "Run completion time does not match status" });
  if (run.status === "waiting_input" && (!run.questions.length || run.questions.at(-1)!.reply !== null)) {
    context.addIssue({ code: "custom", message: "Waiting run requires an unanswered question" });
  }
  if (run.status === "succeeded" && (!run.summary?.trim() || run.nodes.some(node => node.status !== "succeeded"))) {
    context.addIssue({ code: "custom", message: "Successful run requires accepted nodes and summary" });
  }
});
