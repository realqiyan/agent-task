import { z } from "zod";
import { absolutePath, identifier, text, timestamp } from "../shared/validation.js";

export const scheduleData = z.discriminatedUnion("type", [
  z.object({ type: z.literal("now") }).strict(),
  z.object({ type: z.literal("once"), at: timestamp }).strict(),
  z.object({ type: z.literal("interval"), startAt: timestamp, seconds: z.number().int().min(60).max(31_536_000) }).strict(),
]);
export const nodeData = z.object({
  id: identifier, prompt: text(64_000), executorId: identifier,
  dependsOn: z.array(identifier).max(20), maxRunSeconds: z.number().int().min(1).max(3600),
}).strict();
export const questionData = z.object({ nodeId: identifier.optional(), question: text(4000), completedWork: text(4000) }).strict();
export const replyData = z.object({
  runId: z.string().uuid(), questionId: z.string().uuid(), requestKey: identifier, answer: text(16000),
}).strict();
/** Valid internal data. No request defaults, coercion or normalization at this boundary. */
export const taskData = z.object({
  requestKey: identifier, name: text(200), prompt: text(64_000), nodes: z.array(nodeData).min(1).max(20),
  workspace: absolutePath.optional(), schedule: scheduleData, expiresAt: timestamp.optional(),
  maxRunSeconds: z.number().int().min(1).max(86_400), maxSteps: z.number().int().min(1).max(200),
  maxNodeTurns: z.number().int().min(1).max(10), inputWaitSeconds: z.number().int().min(1).max(604800),
}).strict();
export const taskUpdateData = z.object({ id: z.string().uuid(), action: z.enum(["pause", "resume", "cancel"]) }).strict();
