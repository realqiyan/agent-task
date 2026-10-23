import type { TaskDefinitions } from "../tasks/definitions.js";
import type { TaskRuns } from "../tasks/runs.js";
import type { RunSupervisor } from "../tasks/supervisor.js";
import type { ExecutorRegistry } from "../executors/registry.js";

/** Public capabilities used by protocol adapters; no storage or process access. */
export type TaskApi = {
  definitions: Pick<TaskDefinitions, "create" | "get" | "list" | "update" | "executorImpact">;
  runs: Pick<TaskRuns, "get" | "list">;
  supervisor: Pick<RunSupervisor, "status" | "reply" | "cancel">;
  executors: Pick<ExecutorRegistry, "list">;
};
