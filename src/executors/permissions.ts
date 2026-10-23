export type PermissionRequest = {
  toolCall: { name?: string | null; rawInput?: unknown };
  options: readonly { kind: string; optionId: string }[];
};
export type PermissionResponse = { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } };

/** Applies only to ACP requests that actually ask for approval; this is not a sandbox. */
export function permissionDecision(request: PermissionRequest, cancelled = false): PermissionResponse {
  if (cancelled) return { outcome: { outcome: "cancelled" } };
  // Native authorization must suffice. A new ACP approval would widen it.
  const option = request.options.find(value => value.kind === "reject_once");
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } };
}
