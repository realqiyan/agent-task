import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorCode, errorText, StorageError } from "../shared/errors.js";
import type { Delivery, Task, TaskMessage, TaskRun } from "../tasks/model.js";
import type { TaskApi } from "./services.js";
import { messageListSchema, messageSchema, replySchema, taskSchema, taskScheduleControlSchema, taskIdSchema, runIdSchema, taskListSchema, taskRunListSchema } from "./task-contract.js";
import { executorsOutput, messageOutput, mcpJsonSchema, pageOutput, runOutput, runSummaryOutput, serverInstructions, statusOutput, taskOutput, taskSummaryOutput, toolOutput } from "./mcp-contract.js";
import { version } from "../infrastructure/version.js";

type Hints = { readOnly: boolean; destructive: boolean; idempotent: boolean; openWorld: boolean };
const readOnly: Hints = { readOnly: true, destructive: false, idempotent: true, openWorld: false };

export function createMcpServer(service: TaskApi, fatal: (error: unknown) => void): Server {
  // Own tools/call validation so invalid arguments and operation errors share the
  // advertised envelope. McpServer skips output validation for isError responses.
  const server = new Server({ name: "agent-task", version }, { capabilities: { tools: {} }, instructions: serverInstructions });
  const tools = new Map<string, { definition: Tool; call(input: unknown): CallToolResult }>();
  function register<S extends z.ZodRawShape, D extends z.ZodType>(name: string, description: string,
    inputSchema: z.ZodObject<S>, dataSchema: D,
    execute: (input: z.output<z.ZodObject<S>>) => unknown, hints: Hints = readOnly): void {
    const outputSchema = toolOutput(dataSchema);
    tools.set(name, {
      definition: ToolSchema.parse({
        name,
        description,
        inputSchema: { ...mcpJsonSchema(inputSchema, "input"), type: "object" },
        outputSchema: { ...mcpJsonSchema(outputSchema, "output"), type: "object" },
        annotations: { readOnlyHint: hints.readOnly, destructiveHint: hints.destructive, idempotentHint: hints.idempotent, openWorldHint: hints.openWorld },
      }),
      call(input) {
        let value;
        try {
          value = outputSchema.parse({ ok: true, data: execute(inputSchema.parse(input)) });
        } catch (error) {
          if (error instanceof StorageError) fatal(error);
          value = outputSchema.parse({ ok: false,
            code: error instanceof z.ZodError ? "validation" : errorCode(error),
            error: error instanceof z.ZodError ? invalidInput(error) : errorText(error) });
        }
        return result(value);
      },
    });
  }
  register("service_status", "Check scheduler/storage health, coordinator configuration and capacity before creating work or when diagnosing a stalled run. Does not test model credentials or availability; use executor_list for executor readiness.",
    z.object({}).strict(), statusOutput, () => service.supervisor.status());
  register("executor_list", "Find local ACP executor IDs for task_create and inspect adapter preparation. Select only state=ready; this confirms launch dependencies, not native authentication or tool authorization. Does not refresh discovery or install adapters.",
    z.object({}).strict(), executorsOutput, () => ({ executors: service.executors.list().executors.map(executorStatus) }));
  register("task_create", "Create a persistent task for immediate, one-time or Cron-scheduled execution. Supply the complete fixed DAG and a ready executor per node; the coordinator reviews deliveries and requests missing facts, but does not plan or reassign work. Requires service_status.coordinatorConfigured=true. Returns a task, not an execution result; find runs with task_run_list(taskId). Background model/ACP work survives MCP disconnection. Retry the same submission with the same requestKey and parameters, not a replacement task.",
    taskSchema, taskOutput, input => taskView(service.definitions.create(input), service.runs.active()),
    { readOnly: false, destructive: false, idempotent: true, openWorld: true });
  register("task_list", "Find tasks and their future-trigger state, including cancelled and completed tasks. Returns compact records, oldest first; follow next for more. Use task_get for the full definition and task_run_list for execution outcomes.",
    taskListSchema, pageOutput(taskSummaryOutput), input => {
      const page = service.definitions.list(input.after, input.limit);
      return { items: page.items.map(taskSummary), next: page.next };
    });
  register("task_get", "Read a task's full definition and future-trigger state. scheduleStatus=completed means no trigger remains, not that execution succeeded. Use task_run_list(taskId) to find execution outcomes.",
    taskIdSchema, taskOutput, input => taskView(service.definitions.get(input.taskId), service.runs.active()));
  register("task_schedule_control", "Pause, resume or cancel only future task triggers and return the updated task. resume can enable background execution; it cannot clear uncertain outcomes, and no MCP tool provides forced recovery. Does not edit the definition, delete history or stop a current run; use task_run_cancel for that run.",
    taskScheduleControlSchema, taskOutput, input => taskView(service.definitions.controlSchedule(input), service.runs.active()),
    { readOnly: false, destructive: true, idempotent: true, openWorld: true });
  register("task_run_list", "Find runs or poll their progress with compact records, oldest first. Use taskId to track one task or status=waiting_input to find questions. An empty page can mean the task has not triggered yet, not failure. Follow next for more; use task_run_get for delivery text and raw turns.",
    taskRunListSchema, pageOutput(runSummaryOutput), input => {
      const page = service.runs.list(input.taskId, input.after, input.limit, input.status);
      return { items: page.items.map(runSummary), next: page.next };
    });
  register("task_run_get", "Read a run's full execution record, questions and outputs. nodes[].result contains accepted delivery text; turns contain raw output, not deliveries. succeeded records coordinator acceptance, not independent verification of external effects. For routine polling, prefer task_run_list.",
    runIdSchema, runOutput, input => runView(service.runs.get(input.runId)));
  register("task_message_list", "Read public Task conversation history, including input receipts, coordinator replies, questions and summaries. No reasoning or internal tool logs. Use next as after; receipt status does not imply fact adoption or execution success.",
    messageListSchema, pageOutput(messageOutput), input => {
      const page = service.conversations.list(input.taskId, input.after, input.limit);
      return { items: page.items.map(messageView), next: page.next };
    });
  register("task_message_send", "Send a durable message to the Task coordinator. Ordinary chat never answers a pending question or starts idle ACP work. execute=true explicitly requests supplementary work within the fixed DAG: reference the active Run or a successful baseline Run. No terminal Run is reopened and no uncertain work is retried.",
    messageSchema, messageOutput, input => messageView(service.supervisor.send(input)),
    { readOnly: false, destructive: false, idempotent: true, openWorld: true });
  register("task_question_answer", "Answer a specific outstanding question of this Task. Returns a durable input receipt and resumes only the owning waiting Run. Normal messages do not answer questions. Enforces question deadlines, ownership and ACP retention; cannot grant permissions or replay uncertain effects.",
    replySchema, messageOutput, input => messageView(service.supervisor.answer(input)),
    { readOnly: false, destructive: false, idempotent: true, openWorld: true });
  register("task_run_cancel", "Cancel one running or waiting run and return without waiting for resource cleanup; terminal runs are unchanged. Does not roll back external effects or delete history. May pause, but never cancels, the task's future triggers. To stop current execution and future scheduled work, first call task_schedule_control(action=cancel), then cancel its active run.",
    runIdSchema, runOutput, input => runView(service.supervisor.cancel(input.runId)),
    { readOnly: false, destructive: true, idempotent: true, openWorld: true });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools.values()].map(tool => tool.definition) }));
  server.setRequestHandler(CallToolRequestSchema, request => {
    const tool = tools.get(request.params.name);
    if (request.params.task) return result({ ok: false, code: "validation", error: "MCP task-augmented calls are not supported; use Agent Task tools directly" });
    return tool ? tool.call(request.params.arguments ?? {}) : result({ ok: false, code: "not_found", error: "Unknown Agent Task tool" });
  });
  return server;
}

/** MCP exposes ISO instants; storage keeps epoch milliseconds for scheduling arithmetic. */
function executorStatus(executor: ReturnType<TaskApi["executors"]["list"]>["executors"][number]) {
  return { id: executor.id, nativePath: executor.nativePath, state: executor.state,
    adapterVersion: executor.adapterVersion, error: executor.error };
}

function taskView(task: Task, active: TaskRun[]) {
  const run = active.find(run => run.taskId === task.id);
  return { conversationInitialized: task.conversationId !== null, activeRun: run ? { runId: run.id, status: run.status } : null, taskId: task.id, input: task.input, workspace: task.workspace, scheduleStatus: task.scheduleStatus, createdAt: task.createdAt,
    executors: Object.fromEntries(Object.entries(task.executors).map(([id, executor]) => [id,
      { nativePath: executor.nativePath, adapterVersion: executor.adapterVersion }])),
    nextAt: task.nextAt === null ? null : new Date(task.nextAt).toISOString() };
}

function taskSummary(task: Task) {
  return { taskId: task.id, requestKey: task.input.requestKey, name: task.input.name, scheduleStatus: task.scheduleStatus,
    workspace: task.workspace, schedule: task.input.schedule,
    nextAt: task.nextAt === null ? null : new Date(task.nextAt).toISOString(),
    expiresAt: task.input.expiresAt ?? null, createdAt: task.createdAt,
    nodeIds: task.input.nodes.map(node => node.id),
    executorIds: [...new Set(task.input.nodes.map(node => node.executorId))] };
}

function deliveryView(delivery: Delivery) {
  const { id, ...rest } = delivery;
  return { deliveryId: id, ...rest };
}
function messageView(message: TaskMessage) {
  return { messageId: message.id, taskId: message.taskId, runId: message.runId, questionId: message.questionId,
    role: message.role, kind: message.kind, content: message.content, status: message.status,
    error: message.error, createdAt: message.createdAt, finishedAt: message.finishedAt };
}
function runView(run: TaskRun) {
  const { id, inputId, ...rest } = run;
  return { ...rest, runId: id, inputMessageId: inputId, scheduledAt: run.scheduledAt === null ? null : new Date(run.scheduledAt).toISOString(),
    questions: run.questions.map(({ id, ...question }) => ({ questionId: id, ...question })),
    nodes: run.nodes.map(({ id, deliveries, baseline, ...node }) => ({ nodeRunId: id, ...node,
      deliveries: deliveries.map(deliveryView), baseline: baseline ? deliveryView(baseline) : null })) };
}

function runSummary(run: TaskRun) {
  return { runId: run.id, taskId: run.taskId, source: run.source, status: run.status, scheduledAt: run.scheduledAt === null ? null : new Date(run.scheduledAt).toISOString(),
    createdAt: run.createdAt, finishedAt: run.finishedAt, error: run.error, skippedCount: run.skippedCount,
    steps: run.steps, coordinatorStartedAt: run.coordinatorStartedAt, summary: run.summary, waitedMs: run.waitedMs,
    questions: run.questions.map(question => ({ questionId: question.id, nodeId: question.nodeId, question: question.question,
      completedWork: question.completedWork, createdAt: question.createdAt, expiresAt: question.expiresAt,
      sessionExpiresAt: question.sessionExpiresAt, answered: question.reply !== null })),
    nodes: run.nodes.map(node => ({ nodeRunId: node.id, definitionId: node.definition.id, executorId: node.definition.executorId,
      dependsOn: node.definition.dependsOn, status: node.status, turnCount: node.turns.length,
      delivered: node.status === "succeeded" && node.deliveryId !== null, error: node.error, startedAt: node.startedAt })) };
}

function invalidInput(error: z.ZodError): string {
  return "Invalid input: " + error.issues.slice(0, 8).map(issue => {
    const path = issue.path.join(".") || "request";
    return path + ": " + issue.message;
  }).join("; ");
}

function result<T extends { ok: boolean }>(value: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: !value.ok };
}
