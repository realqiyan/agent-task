import { z } from "zod";
import { requestTimestamp } from "../shared/validation.js";
import { nodeData, replyData, runStatusSchema, taskData, taskUpdateData } from "../tasks/validation.js";

export const nodeSchema = nodeData.extend({
  id: nodeData.shape.id.describe("Unique caller-defined ID in this DAG, referenced by dependsOn; not a run UUID."),
  prompt: z.string().trim().min(1).max(64_000).describe("Self-contained work and acceptance criteria for this executor. The task-level prompt is not copied here. Plain text/Markdown delivery is valid unless a format is required."),
  executorId: nodeData.shape.executorId.describe("ID from executor_list with state=ready; fixed at creation, with no automatic fallback."),
  dependsOn: nodeData.shape.dependsOn.default([]).describe("Direct upstream node IDs; omit for none. Must exist, with no duplicates, self-references or cycles. Only their accepted deliveries unlock this node and are supplied as file paths, not full transcripts."),
  maxRunSeconds: nodeData.shape.maxRunSeconds.default(600).describe("Total ACP session lifetime in seconds from opening, including execution, review, clarification and human-input waits; does not reset each turn."),
});
export const replySchema = replyData.extend({
  runId: replyData.shape.runId.describe("UUID of the run that owns the question; not a task or node ID."),
  questionId: replyData.shape.questionId.describe("Latest unanswered questions[].id from task_run_list/get. Reply before expiresAt and any non-null sessionExpiresAt."),
  requestKey: replyData.shape.requestKey.describe("Caller-chosen reply key, scoped to this run. Use a new key per answer; retry with the same key, questionId and trimmed answer to return the current run without resuming twice, even after completion. Conflicting reuse fails."),
  answer: z.string().trim().min(1).max(16000).describe("User-provided facts answering this question, not invented assumptions or permission grants. Trimmed before storage and duplicate comparison."),
});
export const taskIdSchema = z.object({ id: z.string().uuid().describe("Persisted task UUID returned by task_create or task_list; not a run ID.") }).strict();
export const runIdSchema = z.object({ id: z.string().uuid().describe("Persisted task-run UUID returned by task_run_list or task_run_get; not a task or DAG node ID.") }).strict();
export const taskListSchema = z.object({
  after: z.number().int().nonnegative().default(0).describe("Zero-based offset in the matching records, oldest first; not an ID or timestamp. Use next with unchanged filters to continue a scan. Restart at 0 to refresh, especially with status filters; pages are not a snapshot."),
  limit: z.number().int().min(1).max(100).default(20).describe("Maximum records per page."),
}).strict();
export const taskRunListSchema = taskListSchema.extend({
  taskId: z.string().uuid().optional().describe("Filter runs by task UUID. Omit to list runs across all tasks; unknown task IDs yield an empty page."),
  status: runStatusSchema.optional().describe("Filter by run state; omit for all outcomes. waiting_input finds questions; running also includes queued runs, not just active ACP work."),
});
export const taskUpdateSchema = taskUpdateData.extend({
  id: taskIdSchema.shape.id,
  action: taskUpdateData.shape.action.describe("pause keeps the next trigger but suspends it; resume re-enables it without catch-up (past interval slots advance; past now/once slots become completed); cancel permanently removes future triggers. pause/resume require a remaining trigger. resume fails if any run has an interrupted node."),
});
export const taskSchema = taskData.extend({
  requestKey: taskData.shape.requestKey.describe("Caller-chosen creation key, scoped to the canonical workspace. Keep it stable for retries: identical normalized parameters return the existing task, including cancelled/completed tasks; changes conflict. A new key creates separate work, not a retry."),
  name: z.string().trim().min(1).max(200).describe("Short display name; not an identifier or deduplication key."),
  prompt: z.string().trim().min(1).max(64_000).describe("Overall goal and final delivery criteria for the coordinator. Put each executor's instructions in its node prompt; this does not replace the DAG."),
  nodes: z.array(nodeSchema).min(1).max(20).describe("Complete fixed DAG; use one node for a single-step task. Only dependsOn imposes order, not array position; independent nodes may run concurrently."),
  workspace: taskData.shape.workspace.describe("Existing absolute directory on the service machine, canonicalized and fixed for every run. Omit only via local stdio, which uses its launch directory, not necessarily the host's current project. Required over direct HTTP; not a sandbox or permission grant."),
  schedule: z.discriminatedUnion("type", [
    z.object({ type: z.literal("now").describe("One slot eligible immediately; the scheduler creates and starts the run asynchronously.") }).strict(),
    z.object({
      type: z.literal("once").describe("One slot at the specified future time."),
      at: requestTimestamp.describe("Future ISO 8601 trigger time with UTC Z or numeric offset; normalized to UTC."),
    }).strict(),
    z.object({
      type: z.literal("interval").describe("Repeating slots anchored to startAt, not to completion of the previous run."),
      startAt: requestTimestamp.describe("First trigger, in the future, as ISO 8601 with UTC Z or numeric offset."),
      seconds: z.number().int().min(60).max(31_536_000).describe("Fixed elapsed seconds between slots; not a calendar/timezone schedule."),
    }).strict(),
  ]).describe("When runs become eligible, not guaranteed start times. Slots over 30 seconds late or overlapping a running/waiting run of this task are skipped, not queued for catch-up."),
  expiresAt: requestTimestamp.optional().describe("Cutoff for new runs and previously unstarted nodes, not a completion timeout. Must follow the first trigger. Existing ACP sessions may continue. ISO 8601 with timezone; omit for no cutoff."),
  maxRunSeconds: taskData.shape.maxRunSeconds.default(1800).describe("Run execution budget in seconds from coordinator start, excluding human-input waits; includes ACP execution. Separate from expiresAt and each node's session lifetime."),
  maxSteps: taskData.shape.maxSteps.default(40).describe("Maximum coordinator tool calls per run, including inspection, delivery acceptance and finalization; not executor-internal tool calls."),
  maxNodeTurns: taskData.shape.maxNodeTurns.default(3).describe("Maximum ACP turns per node per run: initial work plus clarifications in the same session, not automatic retries."),
  inputWaitSeconds: taskData.shape.inputWaitSeconds.default(86400).describe("Seconds allowed for each user answer. With retained ACP sessions, waiting is also capped at 300 seconds and their remaining lifetime. Follow the earlier of the question's expiresAt and non-null sessionExpiresAt."),
});
