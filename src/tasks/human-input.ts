import { iso } from "../shared/time.js";
import type { CoordinatorInput, InputQuestion, InputReply, QuestionRequest, TaskRun } from "./model.js";

/** Human facts are persisted business state, not executor permission or retry authorization. */
export function askInput(run: TaskRun, request: QuestionRequest, seconds: number, now: number, questionId: string): { run: TaskRun; question: InputQuestion } {
  if (run.status !== "running") throw new Error("Task run is not running");
  if (run.nodes.some(node => node.status === "running")) throw new Error("Wait for all ACP turns before asking for input");
  if (request.nodeId && !run.nodes.some(node => node.definition.id === request.nodeId)) throw new Error("Unknown question node");
  if (run.questions.length >= 20) throw new Error("Question limit reached");
  run = structuredClone(run);
  const sessions = run.nodes.filter(node => node.status === "awaiting_review");
  const question: InputQuestion = { ...request, id: questionId, createdAt: iso(now), expiresAt: iso(now + seconds * 1000),
    sessionExpiresAt: sessions.length ? iso(Math.min(now + 300_000, ...sessions.map(node =>
      Date.parse(node.startedAt!) + node.definition.maxRunSeconds * 1000))) : null, reply: null };
  run.questions.push(question); run.status = "waiting_input";
  return { run, question };
}

export function waitingFailure(run: TaskRun, now: number): { status: "interrupted" | "timed_out"; reason: string } | undefined {
  if (run.status !== "waiting_input") return;
  const question = run.questions.at(-1)!;
  if (question.sessionExpiresAt && now >= Date.parse(question.sessionExpiresAt)) {
    return { status: "interrupted", reason: "ACP session retention expired while waiting; reconcile external effects before any new work" };
  }
  if (now >= Date.parse(question.expiresAt)) return { status: "timed_out", reason: "Human input deadline reached" };
}

/** Exact retries return their receipt, even after completion/cancellation; they never reactivate a run. */
export function applyReply(run: TaskRun, input: InputReply, now: number): TaskRun | undefined {
  run = structuredClone(run);
  const question = run.questions.find(value => value.id === input.questionId);
  if (!question) throw new Error("Unknown question");
  const used = run.questions.find(value => value.reply?.requestKey === input.requestKey);
  if (used) {
    if (used.id !== question.id || used.reply!.answer !== input.answer) throw new Error("Reply requestKey already used with different parameters");
    return undefined;
  }
  if (question.reply || run.questions.at(-1)?.id !== question.id) throw new Error("Question already answered or stale");
  if (run.status !== "waiting_input") throw new Error("Task run is not waiting for input: " + run.status);
  const failure = waitingFailure(run, now);
  if (failure) throw new Error(failure.reason);
  question.reply = { requestKey: input.requestKey, answer: input.answer, receivedAt: iso(now) };
  run.waitedMs += Math.max(0, now - Date.parse(question.createdAt));
  run.status = "running";
  return run;
}

export function coordinatorInput(run: TaskRun): CoordinatorInput {
  const question = run.questions.findLast(value => value.reply !== null);
  if (!question) return { requestId: "run:" + run.id, content: "Advance this task run using its caller-defined DAG. Start by reading inspect_run." };
  return { requestId: "reply:" + question.id,
    content: "Human facts for the existing task run. Read inspect_run; preserve the committed plan and accepted deliveries. This reply grants no permissions or authorization to retry uncertain effects.\n" +
      JSON.stringify({ questionId: question.id, nodeId: question.nodeId, question: question.question,
        completedWork: question.completedWork, answer: question.reply!.answer }) };
}
