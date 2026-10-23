import type { Executor, ExecutorStatus, ExecutorType } from "./model.js";

/** Local discovery and adapter preparation; the registry owns admission and publication. */
export interface ExecutorDiscovery {
  discover(): { executors: Executor[]; states: ExecutorStatus[] };
  install(type: ExecutorType, upgrade: boolean, signal: AbortSignal): Promise<Executor>;
  check(executor: Executor): void;
}
