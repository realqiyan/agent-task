import { z } from "zod";
import { executorRecord } from "../../executors/validation.js";
import { absolutePath, identifier, text, timestamp } from "../../shared/validation.js";
import { notificationOriginData, nodeData, nodeStatusSchema, questionData, runStatusSchema, taskData, taskStatusSchema } from "../validation.js";

export const notificationEventSchema = z.object({
  eventId: z.string().uuid(), taskId: z.string().uuid(), runId: z.string().uuid(),
  kind: runStatusSchema.exclude(["running"]), createdAt: timestamp, summary: z.string().max(2000),
  origin: notificationOriginData,
}).strict();
export const definitionSchema = z.object({
  notification: notificationOriginData.nullable(),
  id: z.string().uuid(), input: taskData, workspace: absolutePath, executors: z.record(identifier, executorRecord),
  scheduleStatus: taskStatusSchema,
  nextAt: z.number().finite().nullable(), createdAt: timestamp,
  conversationId: z.string().nullable(), conversationCursor: z.string().nullable(), conversationRunId: z.string().uuid().nullable(),
}).strict().refine(task => task.input.workspace === task.workspace, "Task workspace must match the canonical request");
export const deliverySchema = z.object({
  id: z.string().uuid(), runId: z.string().uuid(), nodeId: identifier, turn: z.number().int().nonnegative(),
  text: z.string().min(1), path: absolutePath, reason: text(4000), createdAt: timestamp,
  inputDeliveries: z.array(z.string().uuid()), messageIds: z.array(z.string().uuid()),
  source: z.object({ runId: z.string().uuid(), deliveryId: z.string().uuid() }).strict().nullable(),
}).strict();
export const messageSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), runId: z.string().uuid().nullable(), questionId: z.string().uuid().nullable(),
  role: z.enum(["user", "coordinator", "system"]), kind: z.enum(["message", "supplement", "answer", "execution", "question", "result", "error"]),
  content: z.string(), startedAt: timestamp.nullable(), requestKey: z.string(), request: z.string(), execute: z.boolean(), seen: z.boolean(),
  modelCalls: z.number().int().nonnegative(), status: z.enum(["queued", "submitted", "processed", "failed"]),
  submissionId: z.string().nullable(), error: z.string().nullable(), createdAt: timestamp, finishedAt: timestamp.nullable(),
}).strict();
export const roundSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), scheduledAt: z.number().finite().nullable(),
  inputId: z.string().uuid(),
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("schedule") }).strict(),
    z.object({ type: z.literal("message"), messageId: z.string().uuid(), baseRunId: z.string().uuid() }).strict(),
  ]),
  status: runStatusSchema,
  createdAt: timestamp, finishedAt: timestamp.nullable(), error: z.string().nullable(), skippedCount: z.number().int().nonnegative(),
  modelCalls: z.number().int().nonnegative(), coordinatorStartedAt: timestamp.nullable(), summary: z.string().nullable(),
  waitedMs: z.number().finite().nonnegative(),
  questions: z.array(questionData.extend({
    id: z.string().uuid(), createdAt: timestamp, expiresAt: timestamp, sessionExpiresAt: timestamp.nullable(),
    reply: z.object({ requestKey: identifier, answer: text(16000), receivedAt: timestamp }).strict().nullable(),
  })).max(20),
  nodes: z.array(z.object({
    id: z.string().uuid(), definition: nodeData,
    status: nodeStatusSchema,
    workspace: absolutePath.nullable(), inputFiles: z.array(absolutePath), resultFile: absolutePath.nullable(), result: z.string().nullable(), acceptance: z.string().nullable(),
    deliveryId: z.string().uuid().nullable(), deliveries: z.array(deliverySchema), baseline: deliverySchema.nullable(),
    turns: z.array(z.object({ prompt: z.string(), output: z.string(), stopReason: z.string().nullable(),
      sessionId: z.string().nullable(), inputDeliveries: z.array(z.string().uuid()), messageIds: z.array(z.string().uuid()), contextMessageIds: z.array(z.string().uuid()) }).strict()),
    error: z.string().nullable(), sessionId: z.string().nullable(), startedAt: timestamp.nullable(), eventCount: z.number().int().nonnegative(),
  }).strict().superRefine((node, context) => {
    if (["running", "awaiting_review"].includes(node.status) && (!node.startedAt || !node.turns.length)) {
      context.addIssue({ code: "custom", message: "Started nodes require a start time and turn" });
    }
    const accepted = node.deliveries.find(delivery => delivery.id === node.deliveryId);
    if (node.status === "succeeded" && (!accepted || node.result !== accepted.text || node.resultFile !== accepted.path || node.acceptance !== accepted.reason)) {
      context.addIssue({ code: "custom", message: "Accepted node must select its immutable delivery" });
    }
    const previous = new Map(node.baseline ? [[node.baseline.id, node.baseline]] : []);
    for (const delivery of node.deliveries) {
      const source = delivery.source ? previous.get(delivery.source.deliveryId) : undefined;
      const turn = node.turns[delivery.turn - 1];
      if (previous.has(delivery.id) || (delivery.source
        ? !source || source.runId !== delivery.source.runId || source.text !== delivery.text || source.path !== delivery.path
        : turn?.stopReason !== "end_turn" || !turn.output.includes(delivery.text))) {
        context.addIssue({ code: "custom", message: "Delivery requires a completed source turn or an unchanged previously accepted source" });
      }
      previous.set(delivery.id, delivery);
    }
  })).min(1).max(20),
}).strict().superRefine((run, context) => {
  const live = ["running", "waiting_input"].includes(run.status);
  if ((run.source.type === "schedule") !== (run.scheduledAt !== null)) context.addIssue({ code: "custom", message: "Run source does not match its scheduled slot" });
  for (const node of run.nodes) {
    if (node.deliveries.some(delivery => delivery.runId !== run.id || delivery.nodeId !== node.definition.id) ||
      (node.baseline && (run.source.type !== "message" || node.baseline.runId !== run.source.baseRunId || node.baseline.nodeId !== node.definition.id))) {
      context.addIssue({ code: "custom", message: "Delivery ownership does not match the node and Run source" });
    }
  }
  if (live !== (run.finishedAt === null)) context.addIssue({ code: "custom", message: "Run completion time does not match status" });
  if (run.status === "waiting_input" && (!run.questions.length || run.questions.at(-1)!.reply !== null)) {
    context.addIssue({ code: "custom", message: "Waiting run requires an unanswered question" });
  }
  if (run.status === "succeeded" && (!run.summary?.trim() || run.nodes.some(node => node.status !== "succeeded"))) {
    context.addIssue({ code: "custom", message: "Successful run requires accepted nodes and summary" });
  }
});
