import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorText } from "../shared/errors.js";
import { StorageError } from "../shared/errors.js";
import type { TaskApi } from "./services.js";
import { replySchema, taskSchema, taskUpdateSchema, taskIdSchema, taskListSchema, taskRunListSchema } from "./task-contract.js";
import { version } from "../infrastructure/version.js";
export function createMcpServer(service: TaskApi, fatal: (error: unknown) => void): McpServer {
  const server = new McpServer({ name: "agent-task", version });
  function register<S extends z.ZodRawShape>(name: string, description: string, inputSchema: z.ZodObject<S>,
    execute: (input: z.output<z.ZodObject<S>>) => unknown, readOnly = true): void {
    const outputSchema = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional() });
    server.registerTool<typeof outputSchema, z.ZodObject<S>>(name, {
      description, inputSchema, outputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: !readOnly },
    }, async input => {
      let value: { ok: boolean; data?: unknown; error?: string };
      try { value = { ok: true, data: execute(input as z.output<z.ZodObject<S>>) }; }
      catch (error) {
        if (error instanceof StorageError) fatal(error);
        value = { ok: false, error: errorText(error) };
      }
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value,
        isError: !value.ok } satisfies CallToolResult;
    });
  }
  register("service_status", "Service health and active node run IDs. MCP disconnection does not cancel tasks.",
    z.object({}).strict(), () => service.supervisor.status());
  register("executor_list", "Registered local ACP execution profiles and authorization settings. Approval filtering is not a sandbox.",
    z.object({}).strict(), () => service.executors.list());
  register("task_create", "Create a task with a caller-defined DAG in nodes. Each node selects an administrator-registered ACP executorId. The coordinator advances this fixed DAG, reviews deliveries and requests missing user facts; it does not plan new nodes. Optional workspace selects an existing absolute directory; otherwise each executor uses its registered cwd. Path checks do not grant permissions; no uncertain-effect retries.", taskSchema,
    input => service.definitions.create(input), false);
  register("task_list", "List persisted task definitions.", taskListSchema,
    input => service.definitions.list(input.after, input.limit));
  register("task_get", "Get task goal, caller-defined DAG and assigned executor profiles, canonical workspace (null means executor cwd defaults), budgets and schedule.", taskIdSchema, input => service.definitions.get(input.id));
  register("task_update", "Pause, resume or cancel future triggers only; resume never catches up. To change a task, cancel it and create a new task. Use task_run_cancel to stop an active run; cancellation does not roll back external effects.",
    taskUpdateSchema, input => service.definitions.update(input), false);
  register("task_run_list", "List independent task runs with node progress and blocking reasons.",
    taskRunListSchema, input => service.runs.list(input.taskId, input.after, input.limit));
  register("task_run_get", "Get the committed plan, selected node workspaces, ACP turns, accepted deliveries, blocking questions and errors for one task run.",
    taskIdSchema, input => service.runs.get(input.id));
  register("task_run_reply", "Answer a persisted question on the same task run. Deduplicated by requestKey; no permission escalation or uncertain-effect replay.",
    replySchema, input => service.supervisor.reply(input), false);
  register("task_run_cancel", "Stop this task run; external effects are not rolled back.",
    taskIdSchema, input => service.supervisor.cancel(input.id), false);
  return server;
}
