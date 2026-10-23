export type ExecutorType = "pi" | "codex" | "claude" | "opencode";

/** Prepared local execution target. Readiness does not prove native tool authorization. */
export type Executor = {
  id: string;
  type: ExecutorType;
  nativePath: string;
  command: string;
  args: string[];
  adapterVersion: string | null;
};

export type ExecutorStatus = {
  id: string;
  type: ExecutorType;
  nativePath: string | null;
  state: "missing" | "disabled" | "installing" | "ready" | "error";
  adapterVersion: string | null;
  error: string | null;
};
