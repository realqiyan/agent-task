import { z } from "zod";
import { configSchema } from "./config.js";

export const settingsConfigSchema = z.object({
  editToken: z.string().uuid(),
  config: configSchema,
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
