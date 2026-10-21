import { z } from "zod";
import { identifier, scheduleSchema, timestamp } from "./model.js";

export const nodeSchema = z.object({
  id: identifier, prompt: z.string().trim().min(1).max(64_000), executorId: identifier,
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
export const taskSchema = z.object({
  requestKey: identifier, name: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(64_000),
  executorIds: z.array(identifier).min(1).max(20),
  schedule: scheduleSchema, expiresAt: timestamp.optional(),
  maxRunSeconds: z.number().int().min(1).max(86_400).default(1800),
  maxSteps: z.number().int().min(1).max(200).default(40),
  maxNodeTurns: z.number().int().min(1).max(10).default(3),
  inputWaitSeconds: z.number().int().min(1).max(604800).default(86400),
}).strict();
