import { CronExpressionParser } from "cron-parser";
import type { Schedule } from "./model.js";

type CronSchedule = Extract<Schedule, { type: "cron" }>;

/** Five calendar fields, deterministic expressions and an explicit IANA timezone. */
export function parseCron(schedule: CronSchedule, now: number) {
  if (schedule.expression.trim().split(/\s+/).length !== 5 || /\bH\b/i.test(schedule.expression)) {
    throw new Error("Cron requires five fields (minute hour day-of-month month day-of-week); hashed fields are not supported");
  }
  new Intl.DateTimeFormat("en", { timeZone: schedule.timezone });
  return CronExpressionParser.parse(schedule.expression, { currentDate: now, tz: schedule.timezone });
}
