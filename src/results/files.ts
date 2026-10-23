import { mkdirSync, openSync, closeSync, writeFileSync, readFileSync, fstatSync, fsyncSync, realpathSync, statSync, constants } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { OUTPUT_LIMIT } from "../shared/limits.js";
import type { ResultFiles } from "./ports.js";

/** Handles are local to each operation and always closed, including failure paths. */
export class LocalResultFiles implements ResultFiles {
  constructor(readonly root: string, create = false) {
    if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
    if (realpathSync(root) !== root) throw new Error("Result root must not be a symlink");
  }
  describe(path: string) {
    const rel = relative(this.root, path);
    return { canonical: realpathSync(this.root) === this.root && realpathSync(path) === path,
      inside: Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel), regular: statSync(path).isFile() };
  }
  readable(path: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (!fstatSync(fd).isFile()) throw new Error("Invalid result file"); } finally { closeSync(fd); }
  }
  read(path: string): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > OUTPUT_LIMIT) throw new Error("Invalid or oversized input file");
      const content = readFileSync(fd, "utf8");
      if (Buffer.byteLength(content) > OUTPUT_LIMIT) throw new Error("Input file grew beyond limit");
      return content;
    } finally { closeSync(fd); }
  }
  save(taskRunId: string, nodeId: string, nodeRunId: string, text: string): string {
    const directory = join(this.root, taskRunId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (realpathSync(directory) !== directory) throw new Error("Result directory must not be a symlink");
    const path = join(directory, nodeId + "." + nodeRunId + ".txt");
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    for (const dir of [directory, this.root]) {
      const handle = openSync(dir, constants.O_RDONLY);
      try { fsyncSync(handle); } finally { closeSync(handle); }
    }
    return path;
  }
}
