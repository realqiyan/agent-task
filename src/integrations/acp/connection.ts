import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import * as acp from "@agentclientprotocol/sdk";
import { executorLaunch } from "./runtime.js";
import type { Executor } from "../../executors/model.js";
import { Results } from "../../results/service.js";
import { LocalResultFiles } from "../../results/files.js";
import { permissionDecision } from "../../executors/permissions.js";
import { version } from "../../infrastructure/version.js";
import { TaskError } from "../../shared/errors.js";

export type Progress = (kind: string, data: unknown, text?: string) => Promise<void>;

/** Project only public progress. Queue every piece before yielding so concurrent notifications cannot reorder output. */
export function progressEvents(update: acp.SessionUpdate): { kind: string; data: unknown; text?: string }[] {
  if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
    const result: { kind: string; data: unknown; text: string }[] = [];
    for (let i = 0; i < update.content.text.length; i += 2000) {
      const text = update.content.text.slice(i, i + 2000);
      result.push({ kind: "output", data: { text }, text });
    }
    return result;
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return [{ kind: "tool", data: { id: update.toolCallId, name: update.name ?? null,
      status: update.status ?? null, kind: update.kind ?? null } }];
  }
  if (update.sessionUpdate === "plan") {
    return [{ kind: "plan", data: update.entries.slice(0, 30).map(entry => ({
      content: entry.content.slice(0, 300), status: entry.status, priority: entry.priority,
    })) }];
  }
  return [];
}

export function readTextFile(results: Results, inputFiles: readonly string[], request: acp.ReadTextFileRequest,
  sessionId: string | undefined, controller: AbortController): acp.ReadTextFileResponse {
  controller.signal.throwIfAborted();
  if (request.sessionId !== sessionId) throw acp.RequestError.invalidParams(undefined, "Wrong input-file session");
  try {
    return { content: results.readInputFile(inputFiles, request.path, request.line ?? 1, request.limit ?? undefined) };
  } catch (error) {
    if (error instanceof TaskError && ["validation", "precondition"].includes(error.code)) {
      throw acp.RequestError.invalidParams(undefined, error.message);
    }
    controller.abort(error);
    throw error;
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid) {
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
}
/** Kill the whole group even if its leader already exited. */
export async function terminateGroup(child: ChildProcess): Promise<void> {
  signalGroup(child, "SIGTERM");
  await delay(300);
  signalGroup(child, "SIGKILL");
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}
export async function openAcp(executor: Executor, workspace: string, signal: AbortSignal, emit: Progress, resultsRoot: string, inputFiles: string[] = []) {
  signal.throwIfAborted();
  const results = new Results(new LocalResultFiles(resultsRoot));
  const launch = executorLaunch(executor, process.env);
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd ?? workspace, env: launch.env, detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const controller = new AbortController();
  const cancel = AbortSignal.any([signal, controller.signal]);
  let sessionId: string | undefined, connection: acp.ClientConnection | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let wireBytes = 0;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.once("error", error => controller.abort(error));
  child.once("exit", (code, sig) => controller.abort(new Error("Agent exited: " + (sig ?? code))));
  child.stdout.on("data", (chunk: Buffer) => {
    wireBytes += chunk.length;
    if (wireBytes > 8_388_608) controller.abort(new Error("ACP wire output limit exceeded"));
  });
  // Drain diagnostics without storing raw stderr, which can contain credentials.
  child.stderr.on("data", (chunk: Buffer) => {
    wireBytes += chunk.length;
    if (wireBytes > 8_388_608) controller.abort(new Error("Agent diagnostic output limit exceeded"));
  });
  const abort = () => {
    if (sessionId && connection) void connection.agent.notify(acp.methods.agent.session.cancel, { sessionId }).catch(() => {});
    killTimer ??= setTimeout(() => {
      connection?.close(cancel.reason);
      void terminateGroup(child).catch(() => {});
    }, 500);
  };
  cancel.addEventListener("abort", abort, { once: true });
  let reporting = Promise.resolve();
  const report: Progress = (...args) => {
    const next = reporting.then(() => emit(...args));
    reporting = next.catch(error => { controller.abort(error); });
    return next;
  };
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    cancel.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
    connection?.close();
    await terminateGroup(child);
    await closed;
  })();
  let busy = false;
  const supportsInputFiles = inputFiles.length > 0;
  const app = acp.client({ name: "task-conductor" })
    .onRequest(acp.methods.client.fs.readTextFile, async ctx => {
      cancel.throwIfAborted();
      return readTextFile(results, inputFiles, ctx.params, sessionId, controller);
    })
    .onRequest(acp.methods.client.session.requestPermission, async ctx => {
      const request = ctx.params;
      const response = permissionDecision(request, cancel.aborted || request.sessionId !== sessionId);
      await report("permission", { tool: request.toolCall.name ?? null, outcome: response.outcome });
      return response;
    })
    .onNotification(acp.methods.client.session.update, async ctx => {
      if (ctx.params.sessionId !== sessionId || cancel.aborted) return;
      await Promise.all(progressEvents(ctx.params.update).map(event => report(event.kind, event.data, event.text)));
      // Do not persist internal thought streams, raw tool inputs/outputs, or arbitrary extensions.
    });
  try {
    connection = await app.connect(acp.ndJsonStream(
      Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, { maxMessageBytes: 1_048_576 },
    ));
    if (cancel.aborted) abort();
    const init = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: supportsInputFiles ? { fs: { readTextFile: true, writeTextFile: false } } : {},
      clientInfo: { name: "task-conductor", version },
    });
    cancel.throwIfAborted();
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error("Incompatible ACP protocol version");
    await report("agent", { name: init.agentInfo?.name ?? null, version: init.agentInfo?.version ?? null });
    const session = await connection.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    sessionId = session.sessionId;
    await report("session", sessionId);
    cancel.throwIfAborted();
    return {
      close, closed,
      async prompt(text: string, files: string[] = inputFiles): Promise<string> {
        cancel.throwIfAborted();
        if (closing || busy) throw new Error("ACP session closed or busy");
        if (files.length && !supportsInputFiles) throw new Error("ACP session has no input-file capability");
        inputFiles = [...files]; busy = true;
        try {
          const result = await connection!.agent.request(acp.methods.agent.session.prompt, {
            sessionId: sessionId!, prompt: [{ type: "text", text }],
          });
          await reporting;
          cancel.throwIfAborted();
          return result.stopReason;
        } finally { busy = false; }
      },
    };
  } catch (error) {
    await close();
    if (cancel.aborted) throw cancel.reason;
    throw error;
  }
}
