import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { OpenExecution } from "./task-model.js";

/** One supervised worker and ACP session per node, retained across turns. */
export const createExecution = (environment: NodeJS.ProcessEnv): OpenExecution => (input, event, beforeStart) => {
  const worker = fork(fileURLToPath(new URL("./worker.js", import.meta.url)), [], {
    env: { ...environment }, stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv: [],
  });
  worker.stderr?.resume();
  let stopped = false, exited = false, busy = false;
  let failure: unknown;
  let kill: ReturnType<typeof setTimeout> | undefined, hardKill: ReturnType<typeof setTimeout> | undefined;
  let turn: { resolve: (result: { stopReason: string }) => void; reject: (error: unknown) => void } | undefined;
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  let done!: () => void;
  const closed = new Promise<void>(resolve => { done = resolve; });
  const close = (): Promise<void> => {
    if (!stopped && !exited) {
      stopped = true;
      readyReject(new Error("Execution stopped"));
      turn?.reject(new Error("Execution stopped")); turn = undefined;
      if (worker.connected) worker.send({ type: "close" }, () => {});
      kill = setTimeout(() => worker.kill("SIGTERM"), 3000);
      hardKill = setTimeout(() => worker.kill("SIGKILL"), 6000);
    }
    return closed;
  };
  const fail = (error: unknown) => { failure = error; readyReject(error); turn?.reject(error); turn = undefined; void close(); };
  worker.on("error", fail);
  worker.on("message", (message: { type?: string; seq?: number; kind?: string; data?: unknown; text?: string; stopReason?: string; error?: string }) => {
    try {
      if (message.type === "ready") {
        if (stopped) { if (worker.connected) worker.disconnect(); return; }
        beforeStart();
        worker.send({ type: "open", input }, error => { if (error) fail(error); });
      } else if (message.type === "opened") readyResolve();
      else if (message.type === "event" && message.kind && message.seq !== undefined) {
        event(message.kind, message.data ?? null, message.text ?? "");
        if (worker.connected) worker.send({ type: "ack", seq: message.seq }, () => {});
      } else if (message.type === "turn") {
        turn?.resolve({ stopReason: message.stopReason ?? "unknown" }); turn = undefined;
      } else if (message.type === "failed") fail(new Error(message.error ?? "Worker failed"));
    } catch (error) { fail(error); }
  });
  const settle = () => {
    if (exited) return;
    exited = true;
    worker.stderr?.destroy();
    if (kill) clearTimeout(kill);
    if (hardKill) clearTimeout(hardKill);
    const error = failure ?? new Error("Execution stopped or disconnected; external effects may be unknown");
    readyReject(error); turn?.reject(error); turn = undefined;
    done();
  };
  worker.once("exit", settle);
  worker.once("close", settle);
  return {
    closed, close,
    async prompt(text) {
      if (stopped || exited || busy) throw new Error("Execution closed or busy");
      busy = true;
      try {
        await ready;
        if (stopped || exited) throw new Error("Execution stopped");
        return await new Promise<{ stopReason: string }>((resolve, reject) => {
          turn = { resolve, reject };
          worker.send({ type: "prompt", text }, error => { if (error) fail(error); });
        });
      } finally { busy = false; }
    },
  };
};
