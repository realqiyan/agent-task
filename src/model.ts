import { z } from "zod";

export const timestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
export const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
export const scheduleSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("now") }).strict(),
  z.object({ type: z.literal("once"), at: timestamp }).strict(),
  z.object({ type: z.literal("interval"), startAt: timestamp,
    seconds: z.number().int().min(60).max(31_536_000) }).strict(),
]);
export type Schedule = z.infer<typeof scheduleSchema>;
export const executorSchema = z.object({
  id: identifier,
  command: z.string().min(1),
  args: z.array(z.string().max(4096)).max(100).default([]),
  cwd: z.string().min(1),
  envKeys: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(50).default([]),
  permissionAllowlist: z.array(z.string().min(1).max(200)).max(100).default([]),
  unattendedApproved: z.boolean().default(false),
  resultReadRoots: z.array(z.string().min(1)).max(50).default([]),
}).strict();
export type Executor = z.infer<typeof executorSchema>;
export const OUTPUT_LIMIT = 262_144;
export const EVENT_LIMIT = 2000;
export const GRACE_MS = 30_000;
export function iso(now = Date.now()): string { return new Date(now).toISOString(); }
export function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }
export function initialTime(schedule: Schedule, now: number): number {
  return schedule.type === "now" ? now : Date.parse(schedule.type === "once" ? schedule.at : schedule.startAt);
}
