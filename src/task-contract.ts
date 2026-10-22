import { z } from "zod";
import { isAbsolute } from "node:path";
import { identifier, scheduleSchema, timestamp } from "./model.js";

export const nodeSchema = z.object({
  id: identifier, prompt: z.string().trim().min(1).max(64_000),
  executorId: identifier.describe("Administrator-registered ACP executor assigned to this node; not a command or URL."),
  dependsOn: z.array(identifier).max(20).default([]),
  maxRunSeconds: z.number().int().min(1).max(3600).default(600),
}).strict();
export const questionSchema = z.object({
  nodeId: identifier.optional(), question: z.string().trim().min(1).max(4000),
  completedWork: z.string().trim().min(1).max(4000),
}).strict();
export const replySchema = z.object({
  runId: z.string().uuid(), questionId: z.string().uuid(), requestKey: identifier,
  answer: z.string().trim().min(1).max(16000),
}).strict();
export const taskIdSchema = z.object({ id: z.string().uuid() }).strict();
export const taskListSchema = z.object({
  after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20),
}).strict();
export const taskRunListSchema = taskListSchema.extend({ taskId: z.string().uuid().optional() });
export const taskUpdateSchema = z.object({
  id: z.string().uuid(), action: z.enum(["pause", "resume", "cancel"]),
}).strict();
export const taskSchema = z.object({
  requestKey: identifier, name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(64_000).describe("Overall goal and coordination constraints; does not generate or replace the DAG."),
  nodes: z.array(nodeSchema).min(1).max(20).describe("Caller-defined fixed DAG. Each node specifies its prompt, executorId and direct dependencies."),
  workspace: z.string().min(1).max(4096).refine(path => isAbsolute(path) && !path.includes("\0"), "Workspace must be an absolute path without NUL").optional(),
  schedule: scheduleSchema, expiresAt: timestamp.optional(),
  maxRunSeconds: z.number().int().min(1).max(86_400).default(1800),
  maxSteps: z.number().int().min(1).max(200).default(40),
  maxNodeTurns: z.number().int().min(1).max(10).default(3),
  inputWaitSeconds: z.number().int().min(1).max(604800).default(86400),
}).strict();
