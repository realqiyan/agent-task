import type { TaskDefinitions } from "../tasks/definitions.js";
import type { TaskRuns } from "../tasks/runs.js";
import type { TaskConversations } from "../tasks/conversations.js";
import type { TaskSupervisor } from "../tasks/supervisor.js";
import type { ExecutorRegistry } from "../executors/registry.js";

/** Public capabilities used by protocol adapters; no storage or process access. */
export type TaskApi = {
  definitions: Pick<TaskDefinitions, "create" | "get" | "list" | "controlSchedule" | "executorImpact">;
  runs: Pick<TaskRuns, "get" | "list" | "active">;
  conversations: Pick<TaskConversations, "list">;
  supervisor: Pick<TaskSupervisor, "status" | "answer" | "send" | "cancel">;
  executors: Pick<ExecutorRegistry, "list" | "refresh" | "upgrade" | "register" | "unregister">;
};
