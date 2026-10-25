import { TaskError } from "../shared/errors.js";
import type { NotificationEvent, NotificationOrigin, Task, TaskRun } from "./model.js";
import type { NotificationStore } from "./ports.js";
import { notificationOriginData } from "./validation.js";

/** 业务事件由 Run 写入口产生，与 Run 一起提交；不决定渠道重试或唤醒模型。 */
export function runNotification(task: Task, run: TaskRun): NotificationEvent[] {
  if (!task.notification || run.status === "running") return [];
  const question = run.status === "waiting_input" ? run.questions.at(-1) : undefined;
  return [{
    eventId: question?.id ?? run.id, taskId: task.id, runId: run.id,
    kind: run.status, createdAt: question?.createdAt ?? run.finishedAt!,
    summary: (question?.question ?? run.summary ?? run.error ?? "").slice(0, 2000),
    origin: task.notification,
  }];
}

/** 会话投递账本；确认只代表宿主已保存消息，不代表模型完成或用户已读。 */
export class TaskNotifications {
  private closed = false;
  constructor(private readonly store: NotificationStore) {}
  private check(origin: NotificationOrigin): void {
    if (this.closed) throw new TaskError("unavailable", "通知服务已关闭");
    notificationOriginData.parse(origin);
  }
  poll(origin: NotificationOrigin, owner: string, now = Date.now()) {
    this.check(origin);
    const leaseUntil = now + 30_000;
    if (!this.store.acquireNotificationLease(origin, owner, now, leaseUntil)) return { acquired: false, leaseUntil: null, items: [] };
    return { acquired: true, leaseUntil, items: this.store.pendingNotifications(origin, 20) };
  }
  acknowledge(origin: NotificationOrigin, owner: string, eventIds: string[], now = Date.now()): void {
    this.check(origin);
    this.store.acknowledgeNotifications(origin, owner, eventIds, now);
  }
  release(origin: NotificationOrigin, owner: string): void {
    this.check(origin);
    this.store.releaseNotificationLease(origin, owner);
  }
  close(): void { this.closed = true; }
}
