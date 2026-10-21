import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, fstatSync, fsyncSync, realpathSync, statSync, accessSync, constants } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { OUTPUT_LIMIT } from "./model.js";
import type { Executor } from "./model.js";

/** Exact per-run file allowlist intersected with administrator-granted roots. Never offers general filesystem access. */
export function readInputFile(executor: Executor, allowed: readonly string[], path: string, line = 1, limit?: number): string {
  if (!allowed.includes(path) || realpathSync(path) !== path) throw new Error("Input file is not authorized for this run");
  if (!executor.resultReadRoots.some(root => {
    const rel = relative(realpathSync(root), path);
    return !rel.startsWith("..") && !isAbsolute(rel);
  })) throw new Error("Input file outside authorized read scope");
  if (!Number.isInteger(line) || line < 1 || (limit !== undefined && (!Number.isInteger(limit) || limit < 1))) throw new Error("Invalid line range");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > OUTPUT_LIMIT) throw new Error("Invalid or oversized input file");
    const content = readFileSync(fd, "utf8");
    if (Buffer.byteLength(content) > OUTPUT_LIMIT) throw new Error("Input file grew beyond limit");
    if (line === 1 && limit === undefined) return content;
    return content.split("\n").slice(line - 1, limit === undefined ? undefined : line - 1 + limit).join("\n");
  } finally { closeSync(fd); }
}

export class Results {
  readonly root: string;
  constructor(directory: string) {
    mkdirSync(join(directory, "results"), { recursive: true, mode: 0o700 });
    this.root = realpathSync(join(directory, "results"));
  }
  private inside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }
  authorize(executor: Executor): void {
    if (!executor.resultReadRoots.some(root => this.inside(realpathSync(root), this.root))) {
      throw new Error("Executor " + executor.id + " lacks administrator-approved result read scope");
    }
  }
  readable(path: string, executor: Executor): void {
    this.authorize(executor);
    if (realpathSync(path) !== path || !this.inside(this.root, path) || !statSync(path).isFile()) throw new Error("Invalid result file");
    accessSync(path, constants.R_OK);
    // Actually open it. Native agent sandbox access remains an administrator-reviewed prerequisite.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    closeSync(fd);
  }
  save(taskRunId: string, nodeId: string, runId: string, text: string): string {
    for (const id of [taskRunId, nodeId, runId]) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) throw new Error("Invalid result identity");
    }
    const directory = join(this.root, taskRunId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error("Result directory must not be a symlink");
    const path = join(directory, nodeId + "." + runId + ".txt");
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    for (const dir of [directory, this.root]) {
      const handle = openSync(dir, constants.O_RDONLY);
      try { fsyncSync(handle); } finally { closeSync(handle); }
    }
    return path;
  }
}
