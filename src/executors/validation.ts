import { z } from "zod";
import { absolutePath, identifier } from "../shared/validation.js";

export const executorRecord = z.object({
  id: identifier, type: z.enum(["pi", "codex", "claude", "opencode"]),
  note: z.string().max(2000), cwd: absolutePath, unattendedApproved: z.boolean(),
}).strict();
export const executorSchema = executorRecord.extend({
  note: executorRecord.shape.note.default(""), unattendedApproved: z.boolean().default(false),
});
