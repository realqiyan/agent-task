/** Administrator registration; capabilities and validation evidence are not authorization. */
export type Executor = {
  id: string;
  type: "pi" | "codex" | "claude" | "opencode";
  note: string;
  cwd: string;
  unattendedApproved: boolean;
};
