import { OUTPUT_LIMIT } from "../shared/limits.js";
import { TaskError } from "../shared/errors.js";
import type { ResultFiles } from "./ports.js";

/** Authorization and content policy; the file adapter owns OS operations and durability. */
export class Results {
  constructor(private readonly files: ResultFiles) {}
  get root(): string { return this.files.root; }
  readable(path: string): void {
    const facts = this.files.describe(path);
    if (!facts.canonical || !facts.inside || !facts.regular) throw new Error("Invalid result file");
    this.files.readable(path);
  }
  readInputFile(allowed: readonly string[], path: string, line = 1, limit?: number): string {
    if (!allowed.includes(path)) throw new TaskError("precondition", "Input file is not authorized for this run");
    if (!Number.isInteger(line) || line < 1 || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) throw new TaskError("validation", "Invalid line range");
    const facts = this.files.describe(path);
    if (!facts.canonical) throw new Error("Input file is not authorized for this run");
    if (!facts.inside) throw new Error("Input file outside result scope");
    if (!facts.regular) throw new Error("Invalid input file");
    const content = this.files.read(path);
    if (line === 1 && limit === undefined) return content;
    return content.split("\n").slice(line - 1, limit === undefined ? undefined : line - 1 + limit).join("\n");
  }
  save(taskRunId: string, nodeId: string, nodeRunId: string, text: string): string {
    for (const id of [taskRunId, nodeId, nodeRunId]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) throw new Error("Invalid result identity");
    }
    if (Buffer.byteLength(text) > OUTPUT_LIMIT) throw new Error("Result exceeds output limit");
    return this.files.save(taskRunId, nodeId, nodeRunId, text);
  }
}
