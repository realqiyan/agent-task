import { createRequire } from "node:module";

// Node 22 warns on loading SQLite. Suppress only that known notice during the
// synchronous import, then restore normal warning handling for all other code.
const emitWarning = process.emitWarning;
let sqlite: typeof import("node:sqlite");
try {
  process.emitWarning = (warning, ...args: unknown[]) => {
    if (warning === "SQLite is an experimental feature and might change at any time"
      && args[0] === "ExperimentalWarning") return;
    Reflect.apply(emitWarning, process, [warning, ...args]);
  };
  sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
} finally {
  process.emitWarning = emitWarning;
}

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSync = import("node:sqlite").DatabaseSync;
