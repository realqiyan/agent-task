import { z } from "zod";
import { absolutePath, identifier } from "../shared/validation.js";

export const executorTypeSchema = z.enum(["pi", "codex", "claude", "opencode"]);
const launchArgs = z.array(z.string().max(4000).refine(value => !value.includes("\0"))).max(100);
export const customExecutorId = identifier.refine(id => !executorTypeSchema.safeParse(id).success,
  "Built-in executor IDs are reserved");
export const customExecutorSchema = z.object({
  id: customExecutorId, command: absolutePath, args: launchArgs, cwd: absolutePath.optional(),
}).strict();
export const customExecutorsSchema = z.array(customExecutorSchema).max(100).refine(
  entries => new Set(entries.map(entry => entry.id)).size === entries.length, "Duplicate executor ID");
export const executorRecord = z.object({
  id: identifier, type: z.enum([...executorTypeSchema.options, "custom"]), nativePath: absolutePath,
  command: absolutePath, args: launchArgs, cwd: absolutePath.optional(),
  adapterVersion: z.string().min(1).max(200).nullable(),
}).strict().refine(entry => entry.type === "custom"
  ? customExecutorId.safeParse(entry.id).success && entry.command === entry.nativePath && entry.adapterVersion === null
  : entry.cwd === undefined, "Invalid executor launch record");
