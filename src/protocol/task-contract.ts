import { z } from "zod";
import { requestTimestamp } from "../shared/validation.js";
import { nodeData, replyData, taskData, taskUpdateData } from "../tasks/validation.js";

export const nodeSchema = nodeData.extend({
  prompt: z.string().trim().min(1).max(64_000),
  dependsOn: nodeData.shape.dependsOn.default([]), maxRunSeconds: nodeData.shape.maxRunSeconds.default(600),
});
export const replySchema = replyData.extend({ answer: z.string().trim().min(1).max(16000) });
export const taskIdSchema = z.object({ id: z.string().uuid() }).strict();
export const taskListSchema = z.object({
  after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20),
}).strict();
export const taskRunListSchema = taskListSchema.extend({ taskId: z.string().uuid().optional() });
export const taskUpdateSchema = taskUpdateData;
export const taskSchema = taskData.extend({
  name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(64_000).describe("Overall goal; the caller supplies the fixed DAG."),
  nodes: z.array(nodeSchema).min(1).max(20).describe("Fixed DAG with a ready local ACP executorId on every node."),
  schedule: z.discriminatedUnion("type", [
    z.object({ type: z.literal("now") }).strict(),
    z.object({ type: z.literal("once"), at: requestTimestamp }).strict(),
    z.object({ type: z.literal("interval"), startAt: requestTimestamp, seconds: z.number().int().min(60).max(31_536_000) }).strict(),
  ]),
  expiresAt: requestTimestamp.optional(),
  maxRunSeconds: taskData.shape.maxRunSeconds.default(1800), maxSteps: taskData.shape.maxSteps.default(40),
  maxNodeTurns: taskData.shape.maxNodeTurns.default(3), inputWaitSeconds: taskData.shape.inputWaitSeconds.default(86400),
});
