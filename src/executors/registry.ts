import type { Executor } from "./model.js";

export function sameExecutor(a: Executor, b: Executor): boolean {
  return a.id === b.id && a.type === b.type && a.cwd === b.cwd;
}
export function authorizedProfile(snapshot: Executor | undefined, current: Executor | undefined): boolean {
  return Boolean(snapshot?.unattendedApproved && current?.unattendedApproved && sameExecutor(snapshot, current));
}

/** Immutable registrations for one service lifetime. Settings apply to the next instance. */
export class ExecutorRegistry {
  private readonly profiles: readonly Executor[];
  constructor(profiles: readonly Executor[]) { this.profiles = structuredClone(profiles); }
  list() { return { executors: this.profiles.map(profile => ({ ...profile, transport: "stdio" as const })) }; }
  snapshot(ids: readonly string[]): Record<string, Executor> {
    const result: Record<string, Executor> = Object.create(null) as Record<string, Executor>;
    for (const id of ids) {
      const profile = this.profiles.find(item => item.id === id);
      if (!profile?.unattendedApproved) throw new Error("Executor not found or not approved: " + id);
      result[id] = structuredClone(profile);
    }
    return result;
  }
  authorize(snapshot: Executor | undefined): Executor {
    if (!snapshot || !authorizedProfile(snapshot, this.profiles.find(profile => profile.id === snapshot.id))) {
      throw new Error("Executor authorization revoked or changed");
    }
    return structuredClone(snapshot);
  }
}
