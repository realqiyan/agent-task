export function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}
export class StorageError extends Error {}
export class FileCommitError extends Error {
  constructor(readonly uncertain: boolean) {
    super(uncertain ? "Configuration publication could not be confirmed; stop and inspect the files" : "Configuration was not published");
  }
}
