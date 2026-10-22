import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskRun } from "./task-model.js";
import { z } from "zod";
import { executorSchema, identifier, timestamp } from "./model.js";
import { nodeSchema, questionSchema, taskSchema } from "./task-contract.js";

const definitionSchema = z.object({
  id: z.string().uuid(), input: taskSchema, workspace: z.string().nullable(), executors: z.record(identifier, executorSchema),
  status: z.enum(["active", "paused", "cancelled", "completed", "expired"]),
  nextAt: z.number().finite().nullable(), createdAt: timestamp,
}).strict();
const roundSchema = z.object({
  id: z.string().uuid(), taskId: z.string().uuid(), scheduledAt: z.number().finite(),
  status: z.enum(["running", "succeeded", "failed", "interrupted", "skipped", "cancelled", "timed_out", "waiting_input"]),
  createdAt: timestamp, finishedAt: timestamp.nullable(), error: z.string().nullable(), skippedCount: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(), coordinatorStartedAt: timestamp.nullable(), summary: z.string().nullable(),
  waitedMs: z.number().finite().nonnegative(),
  questions: z.array(questionSchema.extend({
    id: z.string().uuid(), createdAt: timestamp, expiresAt: timestamp, sessionExpiresAt: timestamp.nullable(),
    reply: z.object({ requestKey: identifier, answer: z.string().min(1).max(16000), receivedAt: timestamp }).strict().nullable(),
  })).max(20),
  nodes: z.array(z.object({
    id: z.string().uuid(), definition: nodeSchema,
    status: z.enum(["pending", "running", "awaiting_review", "succeeded", "failed", "blocked", "interrupted"]),
    workspace: z.string().nullable(), inputFiles: z.array(z.string()), resultFile: z.string().nullable(), result: z.string().nullable(), acceptance: z.string().nullable(),
    turns: z.array(z.object({ prompt: z.string(), output: z.string(), stopReason: z.string().nullable() }).strict()),
    error: z.string().nullable(), sessionId: z.string().nullable(), startedAt: timestamp.nullable(), eventCount: z.number().int().nonnegative(),
  }).strict()).min(1).max(20),
}).strict();

export class StorageError extends Error {}

/** Task definitions and rounds share one transactional store. */
export class TaskStore {
  private db: DatabaseSync;
  private closed = false;
  get healthy(): boolean { return !this.closed; }
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "tasks.sqlite"));
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (tables.length) {
        this.db.prepare("SELECT seq,id,request_key,data FROM definitions LIMIT 0").all();
        this.db.prepare("SELECT seq,id,task_id,scheduled_at,data FROM rounds LIMIT 0").all();
      }
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
      if (!tables.length) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE definitions(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, request_key TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
        CREATE TABLE rounds(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES definitions(id),
          scheduled_at REAL NOT NULL, data TEXT NOT NULL, UNIQUE(task_id,scheduled_at));
        COMMIT;`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private check(): void { if (this.closed) throw new StorageError("Task storage closed"); }
  definitions(): Task[] {
    this.check();
    return this.db.prepare("SELECT data FROM definitions ORDER BY seq").all().map(row => definitionSchema.parse(JSON.parse(String(row["data"]))));
  }
  rounds(taskId?: string): TaskRun[] {
    this.check();
    const rows = taskId ? this.db.prepare("SELECT data FROM rounds WHERE task_id=? ORDER BY seq").all(taskId)
      : this.db.prepare("SELECT data FROM rounds ORDER BY seq").all();
    return rows.map(row => roundSchema.parse(JSON.parse(String(row["data"]))));
  }
  activeRounds(taskId?: string): TaskRun[] {
    this.check();
    const rows = taskId
      ? this.db.prepare("SELECT data FROM rounds WHERE task_id=? AND json_extract(data,'$.status') IN ('running','waiting_input')").all(taskId)
      : this.db.prepare("SELECT data FROM rounds WHERE json_extract(data,'$.status') IN ('running','waiting_input')").all();
    return rows.map(row => roundSchema.parse(JSON.parse(String(row["data"]))));
  }
  get(id: string): Task {
    this.check();
    const row = this.db.prepare("SELECT data FROM definitions WHERE id=?").get(id);
    if (!row) throw new Error("Task not found");
    return definitionSchema.parse(JSON.parse(String(row["data"])));
  }
  run(id: string): TaskRun {
    this.check();
    const row = this.db.prepare("SELECT data FROM rounds WHERE id=?").get(id);
    if (!row) throw new Error("Task run not found");
    return roundSchema.parse(JSON.parse(String(row["data"])));
  }
  /** The service supplies all policy; the store commits a cursor and round atomically. */
  commit(definition?: Task, round?: TaskRun): void {
    this.check();
    if (definition) definitionSchema.parse(definition);
    if (round) roundSchema.parse(round);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      if (definition) this.db.prepare(`INSERT INTO definitions(id,request_key,data) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(definition.id, definition.input.requestKey, JSON.stringify(definition));
      if (round) this.db.prepare(`INSERT INTO rounds(id,task_id,scheduled_at,data) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(round.id, round.taskId, round.scheduledAt, JSON.stringify(round));
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.close();
      throw new StorageError("Task commit failed", { cause: error });
    }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
