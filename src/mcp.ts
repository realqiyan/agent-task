import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorText } from "./model.js";
import { StorageError } from "./task-storage.js";
import type { Tasks } from "./tasks.js";
import { replySchema, taskSchema } from "./task-contract.js";

const page = { after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(20) };
const id = z.string().uuid();
export function createMcpServer(service: Tasks, fatal: (error: unknown) => void): McpServer {
  const server = new McpServer({ name: "agent-task", version: "0.1.0" });
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
    z.object({}).strict(), () => service.status());
  register("executor_list", "Registered local ACP execution profiles and authorization settings. Approval filtering is not a sandbox.",
    z.object({}).strict(), () => service.listExecutors());
  register("task_create", "Create an intelligent task. A durable coordinator plans a DAG and delegates to approved ACP executors. No uncertain-effect retries.", taskSchema,
    input => service.create(input), false);
  register("task_list", "List persisted task definitions.", z.object(page).strict(),
    input => service.list(input.after, input.limit));
  register("task_get", "Get task goal, allowed executor profiles, budgets and schedule.", z.object({ id }).strict(), input => service.get(input.id));
  for (const action of ["pause", "resume", "cancel"] as const) {
    register("task_" + action, "Control future task triggers, not active rounds.", z.object({ id }).strict(),
      input => service.change(input.id, action), false);
  }
  register("task_run_list", "List independent task runs with node progress and blocking reasons.",
    z.object({ ...page, taskId: id.optional() }).strict(), input => service.runs(input.taskId, input.after, input.limit));
  register("task_run_get", "Get the committed plan, ACP turns, accepted deliveries, blocking questions and errors for one task run.",
    z.object({ id }).strict(), input => service.run(input.id));
  register("task_run_reply", "Answer a persisted question on the same task run. Deduplicated by requestKey; no permission escalation or uncertain-effect replay.",
    replySchema, input => service.reply(input), false);
  register("task_run_cancel", "Stop this task run; external effects are not rolled back.",
    z.object({ id }).strict(), input => service.cancel(input.id), false);
  return server;
}
