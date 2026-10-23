import { z } from "zod";
import { configSchema } from "./config.js";
import { executorSchema, identifier } from "./model.js";

export const settingsConfigSchema = z.object({
  editToken: z.string().uuid(),
  config: configSchema,
  approveExecutors: z.array(identifier).max(100).default([]),
}).strict();
export const settingsChangeSchema = z.object({
  editToken: z.string().uuid(),
  change: z.discriminatedUnion("action", [
    z.object({ action: z.literal("executor-add"), executor: executorSchema.omit({ unattendedApproved: true }) }).strict(),
    z.object({ action: z.literal("executor-update"), id: identifier,
      patch: executorSchema.omit({ unattendedApproved: true }).extend({ note: executorSchema.shape.note.removeDefault() }).partial() }).strict(),
    z.object({ action: z.enum(["executor-remove", "executor-approve", "executor-revoke"]), id: identifier }).strict(),
    z.object({ action: z.literal("coordinator-set"), coordinator: configSchema.shape.coordinator.unwrap() }).strict(),
    z.object({ action: z.literal("coordinator-clear") }).strict(),
  ]),
}).strict();
const credential = {
  editToken: z.string().uuid(),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200),
};
export const credentialUpdateSchema = z.discriminatedUnion("action", [
  z.object({ ...credential, action: z.literal("replace"),
    value: z.string().min(1).max(16_384).refine(value => Boolean(value.trim()) && !value.includes("\0")) }).strict(),
  z.object({ ...credential, action: z.literal("delete") }).strict(),
]);
