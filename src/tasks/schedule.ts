import { TaskError } from "../shared/errors.js";
import type { Schedule, Task, TaskRun } from "./model.js";
import { parseCron } from "./cron.js";

export function hasUncertainOutcome(run: TaskRun): boolean {
  return run.nodes.some(node => node.status === "interrupted");
}

export function initialTime(schedule: Schedule, now: number): number {
  return schedule.type === "now" ? now : schedule.type === "once" ? Date.parse(schedule.at) : parseCron(schedule, now).next().getTime();
}
export function resumeSchedule(task: Task, now: number): Task {
  const next = structuredClone(task);
  if (next.nextAt === null || ["cancelled", "expired"].includes(next.scheduleStatus)) throw new TaskError("precondition", "Task has no future schedule");
  next.scheduleStatus = "active";
  if (next.nextAt < now) {
    if (next.input.schedule.type === "cron") next.nextAt = parseCron(next.input.schedule, now).next().getTime();
    else { next.nextAt = null; next.scheduleStatus = "completed"; }
  }
  return next;
}
export type Trigger = { kind: "none" } | { kind: "expired" } |
  { kind: "due"; at: number; nextAt: number | null; count: number; reason: string | null };
/** Calendar only. Node dispatch remains the coordinator's decision. */
export function dueTrigger(task: Task, overlaps: boolean, now: number): Trigger {
  if (task.scheduleStatus !== "active" || task.nextAt === null) return { kind: "none" };
  if (task.input.expiresAt && now >= Date.parse(task.input.expiresAt)) return { kind: "expired" };
  if (task.nextAt > now) return { kind: "none" };
  const schedule = task.input.schedule;
  let count = 1, at = task.nextAt, nextAt: number | null = null;
  if (schedule.type === "cron") {
    const cron = parseCron(schedule, at);
    nextAt = cron.next().getTime();
    while (nextAt <= now) {
      at = nextAt; count++;
      nextAt = cron.next().getTime();
    }
  }
  return { kind: "due", at, count, nextAt,
    reason: overlaps ? "Previous round still active; slot skipped" : now - at > 30_000 ? "Late slot skipped" : null };
}
