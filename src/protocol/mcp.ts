import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ToolSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorCode, errorText, StorageError } from "../shared/errors.js";
import type { Task, TaskRun } from "../tasks/model.js";
import type { TaskApi } from "./services.js";
import { replySchema, taskSchema, taskUpdateSchema, taskIdSchema, runIdSchema, taskListSchema, taskRunListSchema } from "./task-contract.js";
import { executorsOutput, mcpJsonSchema, pageOutput, runOutput, runSummaryOutput, serverInstructions, statusOutput, taskOutput, taskSummaryOutput, toolOutput } from "./mcp-contract.js";
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
  register("task_create", "Create a persistent task for immediate, one-time or interval execution. Supply the complete fixed DAG and a ready executor per node; the coordinator reviews deliveries and requests missing facts, but does not plan or reassign work. Requires service_status.coordinatorConfigured=true. Returns a task, not an execution result; find runs with task_run_list(taskId). Background model/ACP work survives MCP disconnection. Retry the same submission with the same requestKey and parameters, not a replacement task.",
    taskSchema, taskOutput, input => taskView(service.definitions.create(input)),
    { readOnly: false, destructive: false, idempotent: true, openWorld: true });
  register("task_list", "Find tasks and their future-trigger state, including cancelled and completed tasks. Returns compact records, oldest first; follow next for more. Use task_get for the full definition and task_run_list for execution outcomes.",
    taskListSchema, pageOutput(taskSummaryOutput), input => {
      const page = service.definitions.list(input.after, input.limit);
      return { items: page.items.map(taskSummary), next: page.next };
    });
  register("task_get", "Read a task's full definition and future-trigger state. Its completed status means no trigger remains, not that execution succeeded. Use task_run_list(taskId) to find execution outcomes.",
    taskIdSchema, taskOutput, input => taskView(service.definitions.get(input.id)));
  register("task_update", "Pause, resume or cancel only future task triggers and return the updated task. resume can enable background execution; it cannot clear uncertain outcomes, and no MCP tool provides forced recovery. Does not edit the definition, delete history or stop a current run; use task_run_cancel for that run.",
    taskUpdateSchema, taskOutput, input => taskView(service.definitions.update(input)),
    { readOnly: false, destructive: true, idempotent: true, openWorld: true });
  register("task_run_list", "Find runs or poll their progress with compact records, oldest first. Use taskId to track one task or status=waiting_input to find questions. An empty page can mean the task has not triggered yet, not failure. Follow next for more; use task_run_get for delivery text and raw turns.",
    taskRunListSchema, pageOutput(runSummaryOutput), input => {
      const page = service.runs.list(input.taskId, input.after, input.limit, input.status);
      return { items: page.items.map(runSummary), next: page.next };
    });
  register("task_run_get", "Read a run's full execution record, questions and outputs. nodes[].result contains accepted delivery text; turns contain raw output, not deliveries. succeeded records coordinator acceptance, not independent verification of external effects. For routine polling, prefer task_run_list.",
    runIdSchema, runOutput, input => runView(service.runs.get(input.id)));
  register("task_run_reply", "Submit user facts for the latest unanswered question of a waiting_input run. Resumes the same run asynchronously and returns its snapshot, not a completed result. Cannot edit the plan, grant permissions or retry uncertain work. A new reply requires unexpired waiting deadlines and valid retained ACP sessions; expiry or session loss can end the run even when this call fails.",
    replySchema, runOutput, input => runView(service.supervisor.reply(input)),
    { readOnly: false, destructive: false, idempotent: true, openWorld: true });
  register("task_run_cancel", "Cancel one running or waiting run and return without waiting for resource cleanup; terminal runs are unchanged. Does not roll back external effects or delete history. May pause, but never cancels, the task's future triggers. To stop the whole task, first call task_update(action=cancel), then cancel its active run.",
    runIdSchema, runOutput, input => runView(service.supervisor.cancel(input.id)),
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

function taskView(task: Task) {
  return { ...task,
    executors: Object.fromEntries(Object.entries(task.executors).map(([id, executor]) => [id,
      { nativePath: executor.nativePath, adapterVersion: executor.adapterVersion }])),
    nextAt: task.nextAt === null ? null : new Date(task.nextAt).toISOString() };
}

function taskSummary(task: Task) {
  return { id: task.id, requestKey: task.input.requestKey, name: task.input.name, status: task.status,
    workspace: task.workspace, schedule: task.input.schedule,
    nextAt: task.nextAt === null ? null : new Date(task.nextAt).toISOString(),
    expiresAt: task.input.expiresAt ?? null, createdAt: task.createdAt,
    nodeIds: task.input.nodes.map(node => node.id),
    executorIds: [...new Set(task.input.nodes.map(node => node.executorId))] };
}

function runView(run: TaskRun) {
  return { ...run, scheduledAt: new Date(run.scheduledAt).toISOString() };
}

function runSummary(run: TaskRun) {
  return { id: run.id, taskId: run.taskId, status: run.status, scheduledAt: new Date(run.scheduledAt).toISOString(),
    createdAt: run.createdAt, finishedAt: run.finishedAt, error: run.error, skippedCount: run.skippedCount,
    steps: run.steps, coordinatorStartedAt: run.coordinatorStartedAt, summary: run.summary, waitedMs: run.waitedMs,
    questions: run.questions.map(question => ({ id: question.id, nodeId: question.nodeId, question: question.question,
      completedWork: question.completedWork, createdAt: question.createdAt, expiresAt: question.expiresAt,
      sessionExpiresAt: question.sessionExpiresAt, answered: question.reply !== null })),
    nodes: run.nodes.map(node => ({ id: node.id, definitionId: node.definition.id, executorId: node.definition.executorId,
      dependsOn: node.definition.dependsOn, status: node.status, turnCount: node.turns.length,
      delivered: node.result !== null, error: node.error, startedAt: node.startedAt })) };
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
