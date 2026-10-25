import { z } from "zod";
import { absolutePath, identifier, text, timestamp } from "../shared/validation.js";
import { parseCron } from "./cron.js";

export const cronScheduleData = z.object({
  type: z.literal("cron"), expression: text(200), timezone: text(100),
}).strict().superRefine((schedule, ctx) => {
  try { parseCron(schedule, Date.UTC(2000, 0, 1)).next(); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid five-field Cron expression or timezone" }); }
});

export const scheduleData = z.discriminatedUnion("type", [
  z.object({ type: z.literal("now") }).strict(),
  z.object({ type: z.literal("once"), at: timestamp }).strict(),
  cronScheduleData,
]);
export const notificationOriginData = z.object({
  projectId: z.string().regex(/^(git:[0-9a-f]{64}|uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/),
  sessionId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9:_-]+$/),
}).strict();
export const taskStatusSchema = z.enum(["active", "paused", "cancelled", "completed", "expired"]);
export const runStatusSchema = z.enum(["running", "succeeded", "failed", "interrupted", "skipped", "cancelled", "timed_out", "waiting_input"]);
export const nodeStatusSchema = z.enum(["pending", "running", "awaiting_review", "succeeded", "stale", "blocked", "interrupted"]);
export const nodeData = z.object({
  id: identifier, prompt: text(64_000), executorId: identifier,
  dependsOn: z.array(identifier).max(20), maxRunSeconds: z.number().int().min(1).max(3600),
}).strict();
export const questionData = z.object({ nodeId: identifier.optional(), question: text(4000), completedWork: text(4000) }).strict();
export const replyData = z.object({
  taskId: z.string().uuid(), questionId: z.string().uuid(), requestKey: identifier, answer: text(16000),
}).strict();
/** Valid internal data. No request defaults, coercion or normalization at this boundary. */
export const taskData = z.object({
  requestKey: identifier, name: text(200), prompt: text(64_000), nodes: z.array(nodeData).min(1).max(20),
  workspace: absolutePath.optional(), schedule: scheduleData, expiresAt: timestamp.optional(),
  maxRunSeconds: z.number().int().min(1).max(86_400), maxModelCalls: z.number().int().min(1).max(200),
  maxNodeTurns: z.number().int().min(1).max(10), inputWaitSeconds: z.number().int().min(1).max(604800),
}).strict();
export const taskScheduleControlData = z.object({ taskId: z.string().uuid(), action: z.enum(["pause", "resume", "cancel"]) }).strict();
export const messageData = z.object({
  taskId: z.string().uuid(), requestKey: identifier, message: text(16000),
  runId: z.string().uuid().optional(), execute: z.boolean().optional(),
}).strict().refine(input => !input.execute || input.runId !== undefined, "Supplementary execution requires a successful base runId");
export const memorySourceData = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task"), taskId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("run"), runId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("message"), messageId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("question"), runId: z.string().uuid(), questionId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("delivery"), runId: z.string().uuid(), nodeId: identifier, deliveryId: z.string().uuid() }).strict(),
]);
export const memoryItemData = z.object({
  key: identifier, kind: z.enum(["fact", "decision", "caution", "lesson", "question"]), text: text(2000),
  sources: z.array(memorySourceData).min(1).max(10).describe("支持该笔记的结构化记录引用。"),
  scope: z.discriminatedUnion("type", [z.object({ type: z.literal("task") }).strict(),
    z.object({ type: z.literal("run"), runId: z.string().uuid() }).strict()])
    .describe("适用范围，不是保存期限。task：来源支持的持续要求、偏好或经验；历史笔记须标出所属 Run，不能变成默认值。run：本次执行专属事实、结果或假设。一次修订不构成持续默认值，来源位置不机械决定适用范围。"),
  basis: z.enum(["reported", "inferred"])
    .describe("reported：复述来源陈述或记录结果，保留条件和范围；inferred：协调者推断，不是用户确认更广适用范围。两者都不代表独立验证。"),
}).strict();
