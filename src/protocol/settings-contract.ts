import { SettingsError } from "../configuration/settings.js";
import { z } from "zod";
import { configSchema } from "../configuration/contract.js";
import { customExecutorId, customExecutorSchema, executorTypeSchema } from "../executors/validation.js";

export const settingsConfigSchema = z.object({
  editToken: z.string().uuid(),
  config: configSchema,
}).strict();
export const settingsChangeSchema = z.object({
  editToken: z.string().uuid(),
  change: z.discriminatedUnion("action", [
    z.object({ action: z.enum(["executor-enable", "executor-disable"]), id: executorTypeSchema }).strict(),
    z.object({ action: z.literal("coordinator-set"), coordinator: configSchema.shape.coordinator.unwrap() }).strict(),
    z.object({ action: z.literal("coordinator-clear") }).strict(),
  ]),
}).strict();
export const executorRegisterSchema = customExecutorSchema;
export const executorUnregisterSchema = z.object({ id: customExecutorId }).strict();
export const executorRefreshSchema = z.object({}).strict();
export const executorUpgradeSchema = z.object({ id: executorTypeSchema }).strict();
const credential = {
  editToken: z.string().uuid(),
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(200),
};
export const credentialUpdateSchema = z.discriminatedUnion("action", [
  z.object({ ...credential, action: z.literal("replace"),
    value: z.string().min(1).max(16_384).refine(value => Boolean(value.trim()) && !value.includes("\0")) }).strict(),
  z.object({ ...credential, action: z.literal("delete") }).strict(),
]);

/** Reject with field paths only; rejected values and parser diagnostics can contain credentials. */
export function parseSettings<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.slice(0, 8).map(issue => issue.path.join(".") || "request");
    throw new SettingsError("invalid", "Invalid fields: " + fields.join(", "));
  }
  return result.data;
}
