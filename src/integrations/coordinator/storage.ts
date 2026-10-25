import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "../../infrastructure/sqlite.js";
import { StorageError } from "../../shared/errors.js";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";

/** The caller holds the application directory lock. New files initialize; existing files must already match the pinned SDK. */
export async function openCoordinatorStorage(directory: string, taskId: string, requireExisting = false) {
  if (!/^[a-f0-9-]{36}$/.test(taskId)) throw new Error("Invalid task identity");
  const root = join(directory, "coordinators");
  const path = join(root, taskId + ".sqlite");
  if (requireExisting && !existsSync(path)) throw new StorageError("Bound task conversation storage is missing; no empty replacement created");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (existsSync(path)) inspectCoordinatorStorage(path);
  // 先由本项目 SQLite 入口加载原生模块，再动态加载 SDK 适配器；避免 ESM 静态依赖提前发出提示。
  const { openNodeSqliteDatabase } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  const database = await openNodeSqliteDatabase(path);
  try {
    await database.exec("PRAGMA synchronous=FULL");
    return await SqliteStorage.open(database);
  } catch (error) { await database.close().catch(() => {}); throw error; }
}

/** 离线检查只读取 SDK 格式，不打开 Harness、不运行调度或 SDK 自动迁移。 */
export function inspectCoordinatorStorage(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const version = db.prepare("SELECT version FROM durable_schema WHERE singleton=1").get()?.["version"];
    if (version !== 1) throw new Error("Unsupported durable schema; explicit offline upgrade required");
    // SDK index columns such as kind are JSON-encoded; read the decoded record fields together.
    const tasks = db.prepare("SELECT json_extract(record,'$.kind') AS kind, json_extract(record,'$.version') AS version FROM tasks WHERE status != 'terminal'").all();
    for (const task of tasks) {
      const expected = task["kind"] === "pi.tool" ? 2 : ["pi.generation", "pi.compaction"].includes(String(task["kind"])) ? 1 : undefined;
      if (task["version"] !== expected || expected === undefined) throw new Error("Unsupported durable task version");
    }
    if (db.prepare("SELECT 1 FROM document_revisions WHERE version != 1 LIMIT 1").get()) throw new Error("Unsupported durable document version");
    if (db.prepare("PRAGMA quick_check").all().some(row => row["quick_check"] !== "ok") || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Invalid durable database");
  } finally { db.close(); }
}
