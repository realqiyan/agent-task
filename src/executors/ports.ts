import type { CustomExecutor, Executor, ExecutorStatus, ExecutorType } from "./model.js";

/** Durable custom registrations; application owns exclusive data-directory access. */
export interface CustomExecutorFiles {
  read(): CustomExecutor[];
  publish(entries: readonly CustomExecutor[]): void;
}

/** Local discovery and adapter preparation; the registry owns admission and publication. */
export interface ExecutorDiscovery {
  discover(): { executors: Executor[]; states: ExecutorStatus[] };
  install(type: ExecutorType, upgrade: boolean, signal: AbortSignal): Promise<Executor>;
  check(executor: Executor): void;
}
