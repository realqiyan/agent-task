import { DatabaseSync } from "../../infrastructure/sqlite.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import type { Task, TaskMessage, TaskRun } from "../model.js";
import type { DefinitionStore, RunStore } from "../ports.js";
import { StorageError, TaskError } from "../../shared/errors.js";
import { definitionSchema, messageSchema, roundSchema } from "./records.js";

/** Task definitions and rounds share one transactional store. */
export class TaskStore implements DefinitionStore, RunStore {
  private db: DatabaseSync;
  private closed = false;
  get healthy(): boolean { return !this.closed; }
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "tasks.sqlite"));
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      if (tables.length) {
        this.db.prepare("SELECT seq,id,workspace,request_key,data FROM definitions LIMIT 0").all();
        this.db.prepare("SELECT seq,id,task_id,scheduled_at,data FROM rounds LIMIT 0").all();
        this.db.prepare("SELECT seq,id,task_id,request_key,data FROM messages LIMIT 0").all();
        this.definitions(); this.rounds();
        for (const row of this.db.prepare("SELECT data FROM messages").all()) this.decode(messageSchema, row["data"]);
      }
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
      if (!tables.length) this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE definitions(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, workspace TEXT NOT NULL,
          request_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(workspace,request_key));
        CREATE TABLE rounds(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES definitions(id),
          scheduled_at REAL, data TEXT NOT NULL, UNIQUE(task_id,scheduled_at));
        CREATE UNIQUE INDEX active_task_run ON rounds(task_id) WHERE json_extract(data,'$.status') IN ('running','waiting_input');
        CREATE TABLE messages(seq INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES definitions(id),
          request_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(task_id,request_key));
        CREATE INDEX message_queue ON messages(task_id,json_extract(data,'$.status'));
        COMMIT;`);
    } catch (error) {
      this.close();
      throw error;
    }
  }
  private check(): void { if (this.closed) throw new StorageError("Task storage closed"); }
  private decode<T>(schema: z.ZodType<T>, data: unknown): T {
    try { return schema.parse(JSON.parse(String(data))); }
    catch (error) {
      this.close();
      throw new StorageError("Invalid stored task data; no conversion or repair performed", { cause: error });
    }
  }
  definitions(): Task[] {
    this.check();
    return this.db.prepare("SELECT data FROM definitions ORDER BY seq").all().map(row => this.decode(definitionSchema, row["data"]));
  }
  rounds(taskId?: string): TaskRun[] {
    this.check();
    const rows = taskId ? this.db.prepare("SELECT data FROM rounds WHERE task_id=? ORDER BY seq").all(taskId)
      : this.db.prepare("SELECT data FROM rounds ORDER BY seq").all();
    return rows.map(row => this.decode(roundSchema, row["data"]));
  }
  activeRounds(taskId?: string): TaskRun[] {
    this.check();
    const rows = taskId
      ? this.db.prepare("SELECT data FROM rounds WHERE task_id=? AND json_extract(data,'$.status') IN ('running','waiting_input')").all(taskId)
      : this.db.prepare("SELECT data FROM rounds WHERE json_extract(data,'$.status') IN ('running','waiting_input')").all();
    return rows.map(row => this.decode(roundSchema, row["data"]));
  }
  get(id: string): Task {
    this.check();
    const row = this.db.prepare("SELECT data FROM definitions WHERE id=?").get(id);
    if (!row) throw new TaskError("not_found", "Task not found");
    return this.decode(definitionSchema, row["data"]);
  }
  run(id: string): TaskRun {
    this.check();
    const row = this.db.prepare("SELECT data FROM rounds WHERE id=?").get(id);
    if (!row) throw new TaskError("not_found", "Task run not found");
    return this.decode(roundSchema, row["data"]);
  }
  message(id: string): TaskMessage {
    this.check();
    const row = this.db.prepare("SELECT data FROM messages WHERE id=?").get(id);
    if (!row) throw new TaskError("not_found", "Task message not found");
    return this.decode(messageSchema, row["data"]);
  }
  request(taskId: string, key: string): TaskMessage | undefined {
    this.check();
    const row = this.db.prepare("SELECT data FROM messages WHERE task_id=? AND request_key=?").get(taskId, key);
    return row ? this.decode(messageSchema, row["data"]) : undefined;
  }
  messages(taskId: string, after = 0, limit = 20, publicOnly = false) {
    this.check();
    const filter = publicOnly ? " AND json_extract(data,'$.role') != 'system'" : "";
    const rows = this.db.prepare("SELECT seq,data FROM messages WHERE task_id=? AND seq>?" + filter + " ORDER BY seq LIMIT ?").all(taskId, after, limit + 1);
    return { items: rows.slice(0, limit).map(row => this.decode(messageSchema, row["data"])),
      next: rows.length > limit ? Number(rows[limit - 1]!["seq"]) : null };
  }
  pending(taskId?: string): TaskMessage[] {
    this.check();
    const filter = "json_extract(data,'$.status') IN ('queued','submitted')";
    const rows = taskId ? this.db.prepare("SELECT data FROM messages WHERE task_id=? AND " + filter + " ORDER BY seq").all(taskId)
      : this.db.prepare("SELECT data FROM messages WHERE " + filter + " ORDER BY seq").all();
    return rows.map(row => this.decode(messageSchema, row["data"]));
  }
  /** The service supplies all policy; inputs, cursor and round share one transaction. */
  saveDefinition(task: Task): void { this.commit(task); }
  commitRun(run: TaskRun, task?: Task, messages: TaskMessage[] = []): void { this.commit(task, run, messages); }
  saveMessages(messages: TaskMessage[], task?: Task): void { this.commit(task, undefined, messages); }
  private commit(definition?: Task, round?: TaskRun, messages: TaskMessage[] = []): void {
    this.check();
    if (definition) definitionSchema.parse(definition);
    if (round) roundSchema.parse(round);
    for (const message of messages) messageSchema.parse(message);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      if (definition) this.db.prepare(`INSERT INTO definitions(id,workspace,request_key,data) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(definition.id, definition.workspace, definition.input.requestKey, JSON.stringify(definition));
      if (round) this.db.prepare(`INSERT INTO rounds(id,task_id,scheduled_at,data) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(round.id, round.taskId, round.scheduledAt, JSON.stringify(round));
      for (const message of messages) this.db.prepare(`INSERT INTO messages(id,task_id,request_key,data) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data`).run(message.id, message.taskId, message.requestKey, JSON.stringify(message));
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      this.close();
      throw new StorageError("Task commit failed", { cause: error });
    }
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
