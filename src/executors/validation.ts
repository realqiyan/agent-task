import { z } from "zod";
import { absolutePath, identifier } from "../shared/validation.js";

export const executorTypeSchema = z.enum(["pi", "codex", "claude", "opencode"]);
export const executorRecord = z.object({
  id: identifier, type: executorTypeSchema, nativePath: absolutePath,
  command: absolutePath, args: z.array(z.string().max(4000)).max(100),
  adapterVersion: z.string().min(1).max(200).nullable(),
}).strict();
