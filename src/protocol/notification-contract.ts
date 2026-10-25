import { z } from "zod";
import { notificationOriginData } from "../tasks/validation.js";
import { notificationEventSchema } from "../tasks/storage/records.js";
import type { TaskApi } from "./services.js";

const base = { origin: notificationOriginData, owner: z.string().uuid() };
export const notificationRequest = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("poll") }).strict(),
  z.object({ ...base, action: z.literal("ack"), eventIds: z.array(z.string().uuid()).min(1).max(20) }).strict(),
  z.object({ ...base, action: z.literal("release") }).strict(),
]);
export const notificationResponse = z.object({
  acquired: z.boolean(), leaseUntil: z.number().nullable(), items: z.array(notificationEventSchema).max(20),
}).strict();

export function notificationOperation(service: TaskApi["notifications"], value: unknown) {
  const input = notificationRequest.parse(value);
  if (input.action === "poll") return notificationResponse.parse(service.poll(input.origin, input.owner));
  if (input.action === "ack") service.acknowledge(input.origin, input.owner, input.eventIds);
  else service.release(input.origin, input.owner);
  return notificationResponse.parse({ acquired: false, leaseUntil: null, items: [] });
}
