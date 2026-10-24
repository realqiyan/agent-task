export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}
export class StorageError extends Error {}

/** Stable failure classes exposed by protocol adapters. */
export type ErrorCode = "validation" | "not_found" | "conflict" | "precondition" | "unavailable" | "internal";

/** A business failure with a stable class; the message stays the operator-facing explanation. */
export class TaskError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

export function errorCode(error: unknown): ErrorCode {
  if (error instanceof TaskError) return error.code;
  if (error instanceof StorageError) return "unavailable";
  return "internal";
}
export class FileCommitError extends Error {
  constructor(readonly uncertain: boolean) {
    super(uncertain ? "Configuration publication could not be confirmed; stop and inspect the files" : "Configuration was not published");
  }
}
