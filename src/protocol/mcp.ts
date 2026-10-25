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
  register("service_status", "创建工作前或诊断停滞时，检查监督器、存储、协调配置和容量。不探测模型凭据或可用性；执行端就绪状态见 executor_list。",
    z.object({}).strict(), statusOutput, () => service.supervisor.status());
  register("executor_list", "查询可用于 task_create 的本机 ACP 执行端 ID 和适配器准备状态。只选择 state=ready；这只证明启动依赖已准备，不证明原生认证或工具授权。不刷新发现或安装适配器。",
    z.object({}).strict(), executorsOutput, () => ({ executors: service.executors.list().executors.map(executorStatus) }));
  register("task_create", "创建立即、单次或 Cron 触发的持久 Task。提供完整固定 DAG，并为每个节点指定就绪执行端；协调者判断、澄清、记忆和验收，不重写计划或改派。要求 service_status.coordinatorConfigured=true。返回任务定义，不是执行结果；用 task_run_list(taskId) 查运行。MCP 断开不取消后台工作。重复提交须使用相同 requestKey 和参数，不创建替代任务。",
    taskSchema, taskOutput, input => taskView(service.definitions.create(input), service.runs.active()),
    { readOnly: false, destructive: false, idempotent: true, openWorld: true });
  register("task_list", "查询任务及未来触发状态，包括已取消和已完成任务。返回按创建时间升序的摘要，用 next 继续。完整定义见 task_get，执行结果见 task_run_list。",
    taskListSchema, pageOutput(taskSummaryOutput), input => {
      const page = service.definitions.list(input.after, input.limit);
      return { items: page.items.map(taskSummary), next: page.next };
    });
  register("task_get", "读取任务完整定义与未来触发状态。scheduleStatus=completed 只表示没有剩余触发，不表示执行成功。执行结果见 task_run_list(taskId)。",
    taskIdSchema, taskOutput, input => taskView(service.definitions.get(input.taskId), service.runs.active()));
  register("task_schedule_control", "只暂停、恢复或取消未来触发，并返回更新后的任务。resume 可能启用后台执行，但不能清除不确定结果；MCP 不提供强制恢复。不修改定义、删除历史或停止当前 Run；停止 Run 使用 task_run_cancel。",
    taskScheduleControlSchema, taskOutput, input => taskView(service.definitions.controlSchedule(input), service.runs.active()),
    { readOnly: false, destructive: true, idempotent: true, openWorld: true });
  register("task_run_list", "查询 Run 或轮询摘要进度，按创建时间升序。taskId 限定任务，status=waiting_input 查找问题。空页可能表示尚未触发，不表示失败。用 next 继续；交付和原始输出见 task_run_get。",
    taskRunListSchema, pageOutput(runSummaryOutput), input => {
      const page = service.runs.list(input.taskId, input.after, input.limit, input.status);
      return { items: page.items.map(runSummary), next: page.next };
    });
  register("task_run_get", "读取 Run 的完整执行记录、问题和输出。nodes[].result 是已验收交付，turns 是原始输出。succeeded 表示协调者已验收，不证明外部效果经过独立验证。常规轮询优先使用 task_run_list。",
    runIdSchema, runOutput, input => runView(service.runs.get(input.runId)));
  register("task_message_list", "读取公开 Task 对话，包括输入回执、协调者回复、问题和总结。不包含内部推理或工具日志。以 next 作为 after 继续；回执不证明事实已采纳或执行成功。",
    messageListSchema, pageOutput(messageOutput), input => {
      const page = service.conversations.list(input.taskId, input.after, input.limit);
      return { items: page.items.map(messageView), next: page.next };
    });
  register("task_message_send", "向 Task 协调者提交持久消息。普通讨论不回答待决问题，也不启动空闲 ACP 工作。execute=true 明确请求固定 DAG 内的补充工作，须引用活动 Run 或成功基线 Run。不重开终结 Run，不重试结果不明的工作。",
    messageSchema, messageOutput, input => messageView(service.supervisor.send(input)),
    { readOnly: false, destructive: false, idempotent: true, openWorld: true });
  register("task_question_answer", "回答本 Task 的具体待决问题。返回持久输入回执，只续接所属等待 Run。普通消息不代替回答。检查问题期限、归属和 ACP 保留状态；回答不授予权限，也不重放不确定副作用。",
    replySchema, messageOutput, input => messageView(service.supervisor.answer(input)),
    { readOnly: false, destructive: false, idempotent: true, openWorld: true });
  register("task_run_cancel", "取消一个运行或等待中的 Run，不等待资源收尾就返回；终结 Run 不变。不回滚外部效果或删除历史。可能暂停但不取消未来触发。如需同时停止未来触发与当前执行，先 task_schedule_control(action=cancel)，再取消活动 Run。",
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
    modelCalls: run.modelCalls, coordinatorStartedAt: run.coordinatorStartedAt, summary: run.summary, waitedMs: run.waitedMs,
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
