import type { CoordinatorActions } from "../../tasks/ports.js";
import type { Delivery, InputQuestion, MemorySource, TaskMessage } from "../../tasks/model.js";

export function deliveryView(delivery: Delivery) {
  return { deliveryId: delivery.id, runId: delivery.runId, nodeId: delivery.nodeId, turn: delivery.turn,
    source: delivery.source, length: delivery.text.length,
    reference: { type: "delivery", runId: delivery.runId, nodeId: delivery.nodeId, deliveryId: delivery.id } satisfies MemorySource };
}

export function questionView(question: InputQuestion, runId: string) {
  const { id, ...fields } = question;
  return { ...fields, questionId: id, runId,
    reference: { type: "question", runId, questionId: id } satisfies MemorySource };
}

/** 同一有界视图用于主动上下文和按需查询，不替模型选择执行节点。 */
export function coordinatorView(actions: CoordinatorActions, args: {
  runId?: string; messageId?: string; nodeId?: string; goal?: boolean; offset?: number; limit?: number;
} = {}) {
  const { taskId, task, run, messages, execution, budget } = actions.inspect(args.runId);
  const offset = args.offset ?? 0, limit = args.limit ?? 16000;
  const excerpt = (text: string, start = 0, count = 500) => ({ text: text.slice(start, start + count), length: text.length,
    next: text.length > start + count ? start + count : null });
  const taskReference = { type: "task", taskId } satisfies MemorySource;
  const messageView = (message: TaskMessage) => ({ messageId: message.id, runId: message.runId,
    reference: { type: "message", messageId: message.id } satisfies MemorySource,
    role: message.role, kind: message.kind, content: excerpt(message.content), questionId: message.questionId });
  if (args.goal) return ({ reference: taskReference, ...excerpt(task.prompt, offset, limit) });
  if (args.messageId) {
    const message = actions.readMessage(args.messageId);
    return ({ ...messageView(message), content: excerpt(message.content, offset, limit),
      eligibleForExecution: execution?.contextMessages.some(item => item.id === message.id) ?? false });
  }
  if (args.nodeId) {
    const node = task.nodes.find(node => node.id === args.nodeId);
    if (!node) throw new Error("节点不存在");
    return ({ ...node, reference: taskReference, prompt: excerpt(node.prompt, offset, limit) });
  }
  const count = Math.min(limit, 20);
  const page = (items: TaskMessage[]) => ({ items: items.slice(offset, offset + count).map(messageView),
    next: items.length > offset + count ? offset + count : null });
  return ({ taskId, budget: { ...budget, remainingModelCalls: Math.max(0, budget.maxModelCalls - budget.modelCalls) },
    task: { ...task, reference: taskReference, prompt: excerpt(task.prompt), nodes: task.nodes.map(node => ({ ...node, prompt: excerpt(node.prompt) })) },
    execution: execution ? { runId: execution.runId, contextMessages: page(execution.contextMessages) } : null,
    view: { messages: page(messages), run: run ? { runId: run.id,
      reference: { type: "run", runId: run.id } satisfies MemorySource,
      source: run.source, status: run.status, modelCalls: run.modelCalls,
      coordinatorStartedAt: run.coordinatorStartedAt, waitedMs: run.waitedMs,
      error: run.error, summary: run.summary ? excerpt(run.summary) : null,
      questionCount: run.questions.length, questions: run.questions.slice(-1).map(question => questionView(question, run.id)),
      nodes: run.nodes.map(node => ({ nodeId: node.definition.id, status: node.status, error: node.error,
        startedAt: node.startedAt, sessionId: node.sessionId, deliveryId: node.deliveryId,
        baseline: node.baseline ? deliveryView(node.baseline) : null,
        deliveries: node.deliveries.map(deliveryView),
        turns: node.turns.map((turn, index) => ({ turn: index + 1, length: turn.output.length, stopReason: turn.stopReason })),
        unreviewedMessageIds: node.status === "awaiting_review"
          ? messages.filter(message => !node.turns.at(-1)!.messageIds.includes(message.id)).map(message => message.id) : [],
        latestOutput: excerpt(node.turns.at(-1)?.output ?? "") })) } : null } });
}
