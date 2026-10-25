import { lstatSync } from "node:fs";
import { readPrivateText, replacePrivateText } from "../infrastructure/private-files.js";
import { FileCommitError, StorageError, TaskError } from "../shared/errors.js";
import type { CustomExecutor } from "./model.js";
import type { CustomExecutorFiles } from "./ports.js";
import { customExecutorsSchema } from "./validation.js";

/** Strict private-file storage. No execution, policy, migration or history repair. */
export class LocalCustomExecutorFiles implements CustomExecutorFiles {
  private expected: string | null = null;
  constructor(private readonly path: string) {}
  private text(): string | null {
    return lstatSync(this.path, { throwIfNoEntry: false }) ? readPrivateText(this.path) : null;
  }
  read(): CustomExecutor[] {
    try {
      const text = this.text();
      const entries = customExecutorsSchema.parse(text === null ? [] : JSON.parse(text));
      this.expected = text;
      return entries;
    } catch { throw new StorageError("Cannot read custom executor registrations; inspect the private file"); }
  }
  publish(entries: readonly CustomExecutor[]): void {
    const text = JSON.stringify(customExecutorsSchema.parse(entries), null, 2) + "\n";
    let current: string | null;
    try { current = this.text(); }
    catch { throw new StorageError("Custom executor storage is unavailable"); }
    if (current !== this.expected) throw new StorageError("Custom executor registrations changed outside the service; stop and inspect");
    try { replacePrivateText(this.path, text, current === null); }
    catch (error) {
      if (error instanceof FileCommitError && !error.uncertain) {
        throw new TaskError("unavailable", "Custom executor registration was not saved");
      }
      throw new StorageError("Custom executor publication is uncertain; stop and inspect before retrying");
    }
    this.expected = text;
  }
}
