import { openAcp } from "./connection.js";
import { z } from "zod";
import { errorText } from "../../shared/errors.js";
import { executorSchema } from "../../executors/validation.js";

const inputSchema = z.object({ executor: executorSchema, inputFiles: z.array(z.string()).max(20), resultsRoot: z.string().min(1) }).strict();
const controller = new AbortController();
const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let sequence = 0, started = false, busy = false;
let session: Awaited<ReturnType<typeof openAcp>> | undefined;
let opening: Promise<void> | undefined, closing: Promise<void> | undefined;
function send(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) { reject(new Error("Supervisor disconnected")); return; }
    process.send(value, error => error ? reject(error) : resolve());
  });
}
async function emit(kind: string, data: unknown, text = ""): Promise<void> {
  const seq = ++sequence;
  const acknowledged = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(seq); reject(new Error("Progress acknowledgement timed out")); }, 5000);
    pending.set(seq, { resolve, reject, timer });
  });
  void acknowledged.catch(() => {});
  try { await send({ type: "event", seq, kind, data, text }); await acknowledged; }
  finally { const item = pending.get(seq); if (item) clearTimeout(item.timer); pending.delete(seq); }
}
function close(): Promise<void> {
  return closing ??= (async () => {
    controller.abort(new Error("Execution stopped"));
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Execution stopped")); }
    pending.clear();
    await opening?.catch(() => {});
    await session?.close();
    if (process.connected) process.disconnect();
  })();
}
async function fail(error: unknown): Promise<void> {
  await send({ type: "failed", error: errorText(error) }).catch(() => {});
  await close();
}
process.on("disconnect", () => { void close(); });
process.on("SIGTERM", () => { void close(); });
process.on("SIGINT", () => { void close(); });
process.on("message", (message: { type?: string; input?: unknown; seq?: number; text?: string }) => {
  if (message.type === "ack" && message.seq !== undefined) pending.get(message.seq)?.resolve();
  else if (message.type === "close") void close();
  else if (message.type === "open" && !started && !closing) {
    started = true;
    opening = (async () => {
      const input = inputSchema.parse(message.input);
      session = await openAcp(input.executor, controller.signal, emit, input.resultsRoot, input.inputFiles);
      void session.closed.then(() => { if (!closing) void fail(new Error("ACP process exited")); });
      if (!controller.signal.aborted) await send({ type: "opened" });
    })();
    void opening.catch(error => { void fail(error); });
  } else if (message.type === "prompt" && session && !closing) {
    if (busy || typeof message.text !== "string") { void fail(new Error("Invalid or concurrent turn")); return; }
    busy = true;
    void session.prompt(message.text).then(async stopReason => {
      // Release admission before the parent can observe completion and send the next turn.
      busy = false;
      await send({ type: "turn", stopReason });
    }).catch(error => { busy = false; return fail(error); });
  }
});
void send({ type: "ready" }).catch(() => { void close(); });
