import { join } from "node:path";
import type { Executor, ExecutorType } from "../executors/model.js";
import type { ExecutorDiscovery } from "../executors/ports.js";
import { LocalCustomExecutorFiles } from "../executors/files.js";
import { ExecutorRegistry } from "../executors/registry.js";
import { checkWorkspace, resolveWorkspace } from "../infrastructure/workspace.js";
import { LocalResultFiles } from "../results/files.js";
import { Results } from "../results/service.js";
import { TaskDefinitions } from "../tasks/definitions.js";
import { TaskRuns } from "../tasks/runs.js";
import { TaskConversations } from "../tasks/conversations.js";
import { TaskSupervisor } from "../tasks/supervisor.js";
import { TaskStore } from "../tasks/storage/store.js";
import type { Coordinate, OpenExecution } from "../tasks/ports.js";

/** Creates and owns the business store and services; callers must stop ingress before closing. */
export function createTaskRuntime(directory: string, profiles: readonly Executor[], openExecution: OpenExecution,
  coordinate: Coordinate | undefined, fatal: (error: unknown) => void,
  discovery?: ExecutorDiscovery, disabled: readonly ExecutorType[] = []) {
  const store = new TaskStore(directory);
  try {
    const executors = new ExecutorRegistry(profiles, discovery, disabled,
      discovery ? new LocalCustomExecutorFiles(join(directory, "custom-executors.json")) : undefined);
    const workspaces = { resolve: resolveWorkspace, check: checkWorkspace };
    const results = new Results(new LocalResultFiles(join(directory, "results"), true));
    const definitions = new TaskDefinitions(store, executors, workspaces, Boolean(coordinate));
    const conversations = new TaskConversations(store, () => Boolean(coordinate));
    const runs = new TaskRuns(store, executors, results, workspaces, conversations);
    const supervisor = new TaskSupervisor(runs, conversations, openExecution, coordinate, fatal);
    let closing: Promise<void> | undefined;
    return { definitions, runs, conversations, supervisor, executors,
      close(): Promise<void> {
        return closing ??= (async () => {
          definitions.close();
          conversations.stopAdmission();
          const stopped = supervisor.close();
          runs.close();
          // 拒绝新的 Run 写入，但保留输入回执服务，直到协调所有者完成投影和收尾。
          try {
            const outcomes = await Promise.allSettled([stopped, executors.close()]);
            const errors = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
            if (errors.length) throw new AggregateError(errors, "任务运行实例收尾失败");
          }
          finally { conversations.close(); store.close(); }
        })();
      },
    };
  } catch (error) { store.close(); throw error; }
}
