import { join } from "node:path";
import type { Executor } from "../executors/model.js";
import { ExecutorRegistry } from "../executors/registry.js";
import { checkWorkspace, resolveWorkspace } from "../infrastructure/workspace.js";
import { LocalResultFiles } from "../results/files.js";
import { Results } from "../results/service.js";
import { TaskDefinitions } from "../tasks/definitions.js";
import { TaskRuns } from "../tasks/runs.js";
import { RunSupervisor } from "../tasks/supervisor.js";
import { TaskStore } from "../tasks/storage/store.js";
import type { Coordinate, OpenExecution } from "../tasks/ports.js";

/** Creates and owns the business store and services; callers must stop ingress before closing. */
export function createTaskRuntime(directory: string, profiles: readonly Executor[], openExecution: OpenExecution,
  coordinate: Coordinate | undefined, fatal: (error: unknown) => void) {
  const store = new TaskStore(directory);
  try {
    const executors = new ExecutorRegistry(profiles);
    const workspaces = { resolve: resolveWorkspace, check: checkWorkspace };
    const results = new Results(new LocalResultFiles(join(directory, "results"), true));
    const definitions = new TaskDefinitions(store, executors, workspaces, Boolean(coordinate));
    const runs = new TaskRuns(store, executors, results, workspaces);
    const supervisor = new RunSupervisor(runs, openExecution, coordinate, fatal);
    let closing: Promise<void> | undefined;
    return { definitions, runs, supervisor, executors,
      close(): Promise<void> {
        return closing ??= (async () => {
          definitions.close();
          const stopped = supervisor.close();
          runs.close();
          try { await stopped; } finally { store.close(); }
        })();
      },
    };
  } catch (error) { store.close(); throw error; }
}
