/** Built-in discovery and adapter-installation targets. Custom registrations use independent IDs. */
export type ExecutorType = "pi" | "codex" | "claude" | "opencode";

/** Prepared local execution target. Readiness does not prove native tool authorization. */
export type Executor = {
  id: string;
  type: ExecutorType | "custom";
  nativePath: string;
  command: string;
  args: string[];
  /** Custom process startup directory; absence uses the task workspace. */
  cwd?: string;
  adapterVersion: string | null;
};

/** Administrator-owned local stdio launch; never supplied by a task caller. */
export type CustomExecutor = { id: string; command: string; args: string[]; cwd?: string };

export type ExecutorStatus = {
  id: string;
  type: ExecutorType | "custom";
  nativePath: string | null;
  cwd?: string;
  state: "missing" | "disabled" | "installing" | "ready" | "error";
  adapterVersion: string | null;
  error: string | null;
};
