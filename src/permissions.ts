export type PermissionRequest = {
  toolCall: { name?: string | null; rawInput?: unknown };
  options: readonly { kind: string; optionId: string }[];
};
export type PermissionResponse = { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } };

/** Applies only to ACP requests that actually ask for approval; this is not a sandbox. */
export function permissionDecision(request: PermissionRequest, allowlist: string[], cancelled = false): PermissionResponse {
  if (cancelled) return { outcome: { outcome: "cancelled" } };
  const name = request.toolCall.name;
  const allowed = typeof name === "string" && allowlist.includes(name) && request.toolCall.rawInput != null;
  const option = request.options.find(value => value.kind === (allowed ? "allow_once" : "reject_once"));
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}
