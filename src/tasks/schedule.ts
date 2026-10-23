import type { Schedule, Task, TaskRun } from "./model.js";

export function hasUncertainOutcome(run: TaskRun): boolean {
  return run.nodes.some(node => node.status === "interrupted");
}

export function initialTime(schedule: Schedule, now: number): number {
  return schedule.type === "now" ? now : Date.parse(schedule.type === "once" ? schedule.at : schedule.startAt);
}
export function resumeSchedule(task: Task, now: number): Task {
  const next = structuredClone(task);
  if (next.nextAt === null || ["cancelled", "expired"].includes(next.status)) throw new Error("Task has no future schedule");
  next.status = "active";
  if (next.nextAt < now) {
    if (next.input.schedule.type === "interval") next.nextAt += (Math.floor((now - next.nextAt) / (next.input.schedule.seconds * 1000)) + 1) * next.input.schedule.seconds * 1000;
    else { next.nextAt = null; next.status = "completed"; }
  }
  return next;
}
export type Trigger = { kind: "none" } | { kind: "expired" } |
  { kind: "due"; at: number; nextAt: number | null; count: number; reason: string | null };
/** Calendar only. Node dispatch remains the coordinator's decision. */
export function dueTrigger(task: Task, overlaps: boolean, now: number): Trigger {
  if (task.status !== "active" || task.nextAt === null) return { kind: "none" };
  if (task.input.expiresAt && now >= Date.parse(task.input.expiresAt)) return { kind: "expired" };
  if (task.nextAt > now) return { kind: "none" };
  const schedule = task.input.schedule;
  const count = schedule.type === "interval" ? Math.floor((now - task.nextAt) / (schedule.seconds * 1000)) + 1 : 1;
  const at = task.nextAt + (schedule.type === "interval" ? (count - 1) * schedule.seconds * 1000 : 0);
  return { kind: "due", at, count, nextAt: schedule.type === "interval" ? at + schedule.seconds * 1000 : null,
    reason: overlaps ? "Previous round still active; slot skipped" : now - at > 30_000 ? "Late slot skipped" : null };
}
