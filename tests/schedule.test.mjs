import test from "node:test";
import assert from "node:assert/strict";
import { initialTime } from "../dist/tasks/schedule.js";
import { scheduleData } from "../dist/tasks/validation.js";
import { taskSchema } from "../dist/protocol/task-contract.js";

test("Cron requires valid five-field expressions and explicit timezones; interval is rejected", () => {
  const cron = { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" };
  assert.deepEqual(scheduleData.parse(cron), cron);
  assert.deepEqual(taskSchema.shape.schedule.parse({ ...cron, expression: " 0 9 * * 1-5 ", timezone: " Asia/Shanghai " }), cron);
  for (const schedule of [
    { type: "interval", startAt: "2026-01-01T00:00:00.000Z", seconds: 60 },
    { ...cron, expression: "* * * * * *" }, { ...cron, expression: "@daily" },
    { ...cron, expression: "61 * * * *" }, { ...cron, expression: "0 0 30 2 *" },
    { ...cron, expression: "H 9 * * *" }, { ...cron, timezone: "not/a-zone" },
    { type: "cron", expression: "* * * * *" },
  ]) {
    assert.equal(taskSchema.shape.schedule.safeParse(schedule).success, false, JSON.stringify(schedule));
    assert.equal(scheduleData.safeParse(schedule).success, false, JSON.stringify(schedule));
  }
});

test("Cron uses calendar matches strictly after creation in the requested timezone", () => {
  const next = (expression, timezone, at) => new Date(initialTime({ type: "cron", expression, timezone }, Date.parse(at))).toISOString();
  assert.equal(next("0 9 * * 1-5", "Asia/Shanghai", "2026-01-02T00:00:00Z"), "2026-01-02T01:00:00.000Z");
  assert.equal(next("0 9 * * 1-5", "Asia/Shanghai", "2026-01-02T01:00:00Z"), "2026-01-05T01:00:00.000Z");
  assert.equal(next("0 9 1 * *", "UTC", "2026-01-01T10:00:00Z"), "2026-02-01T09:00:00.000Z");
  assert.equal(next("0 9 1 * 1", "UTC", "2026-01-01T10:00:00Z"), "2026-01-05T09:00:00.000Z");
  // cron-parser shifts a missing spring hour and does not repeat a fixed fall hour.
  assert.equal(next("30 2 * * *", "America/New_York", "2026-03-08T06:00:00Z"), "2026-03-08T07:30:00.000Z");
  assert.equal(next("30 1 * * *", "America/New_York", "2026-11-01T04:00:00Z"), "2026-11-01T05:30:00.000Z");
  assert.equal(next("30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z"), "2026-11-02T06:30:00.000Z");
});
