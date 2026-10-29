import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createCoordinatorProvider } from "./provider.js";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, ROOT_CONVERSATION_ID, section, ToolTask } from "@earendil-works/pi-durable";
import type { Conversation, Cursor, EntryId, GenerationCheckpoint, Submission, ToolTaskInput } from "@earendil-works/pi-durable";
import { openCoordinatorStorage } from "./storage.js";
import { memoryUpdateParameters, TaskMemory } from "./memory.js";
import { errorText, StorageError } from "../../shared/errors.js";
import type { Config } from "../../configuration/model.js";
import type { MemorySource, TaskMessage } from "../../tasks/model.js";
import { coordinatorView, deliveryView, questionView } from "./context.js";
import type { Coordinate } from "../../tasks/ports.js";

const instructions = `你是一个 Task 的持续协调者，对整体目标负责。通过 ACP 执行端完成领域工作，依据结果、用户事实和有来源的记忆作出推进、澄清、验收、等待或结束决定。
调用方已固定 DAG、节点要求、依赖和执行端。你决定合法范围内的下一步，不另行拆解任务、改计划或切换执行端。task-context 提供有界的当前账本；只有需要补全或核对依据时才使用 task_inspect、node_output_read，无须重复读取已完整提供的信息。
存在已准入的 running Run 时，使用 node_execute 推进依赖已满足的节点，或在同一 ACP 会话中澄清尚未验收的输出。选择相关 contextMessageIds；系统会提供固定要求、整体目标和上游引用，你补充的上下文不能替换这些要求。
end_turn 只表示本轮协议结束。问题、拒绝和中间结果不是交付。判断结果是否满足要求、是否保留重要限制，依据不足则澄清。不要仅凭下游的结论否定原始证据；无法消除的冲突要保留不确定性。
node_delivery_accept 正式接受最新输出的准确摘录；交付本身必须满足要求，验收理由不能补造缺失内容。所有必需交付均有效后，你仍需判断整体目标是否完成，并明确使用 run_complete；节点全部成功不会自动完成 Run。
普通讨论不启动空闲 ACP 工作，也不回答待决问题。缺少用户事实时使用 task_question_ask；执行授权不足不是缺失事实。补充工作须有显式执行意图，终结 Run 不重新打开。run_fail 用于确认无法完成的情况。
已验收交付与终结 Run 不可变。stale 表示旧交付待重新审查。新消息或上游变化后，判断对整体目标和各节点的影响，复用仍有效的交付，或在授权内补充工作。结果不明时停止，不重试、重放外部副作用或绕过门禁。
账本是执行状态的依据。任务记忆用于保存对后续判断有价值的事实、条件、决定、未决问题和经验。
记忆是参考，不是授权或独立证明。区分来源陈述 reported 与你的推断 inferred。长期保存不等于长期适用：一次执行的事实使用 Run 范围；持续要求必须有明确来源支持。来源所在 Run 不机械决定适用范围，范围不明则保留条件，需要沿用时再核对。`;

/** Durable terminates only when every tool in a round requests it. Admit decisions as singleton batches. */
export function coordinatorToolBatchError(names: readonly string[]): string | undefined {
  if (names.length > 50) return "单批最多调用 50 个工具；本批未执行";
  if (names.length > 1 && names.some(name => ["task_question_ask", "run_complete", "run_fail"].includes(name))) {
    return "本批未执行。task_question_ask、run_complete、run_fail 必须各自独占工具批次。";
  }
  return undefined;
}

/** Pi owns the inbox, model loop and compaction. The business ledger owns admission and outcomes. */
export function createCoordinator(directory: string, config: NonNullable<Config["coordinator"]>, fatal?: (error: unknown) => void): Coordinate {
  return async (taskId, input, actions, signal, reconcileOnly = false) => {
    let admitted = false, boundaryFailure: unknown;
    const block = (error: unknown) => {
      // SDK tool/model error envelopes must not hide a failed business store from its application owner.
      if (error instanceof StorageError) {
        const first = !(boundaryFailure instanceof StorageError);
        boundaryFailure = error;
        if (first) fatal?.(error);
      } else boundaryFailure ??= error;
    };
    const guard = () => {
      signal.throwIfAborted();
      if (boundaryFailure) throw boundaryFailure;
      if (!admitted) throw new Error("Previous coordinator work is being stopped before input admission");
    };
    const tool: typeof defineTool = definition => defineTool({ outputLimits: { maxBytes: 262144, maxLines: 10000 }, ...definition,
      parameters: { ...definition.parameters, additionalProperties: false }, execute: async (args, api, context) => {
      try { guard(); actions.check(); return await definition.execute(args, api, context); }
      catch (error) { if (error instanceof StorageError) block(error); throw error; }
    } });
    signal.throwIfAborted();
    const models = createModels(), provider = createCoordinatorProvider(config);
    // Durable hooks fail open. A remembered hook failure must also block the actual provider/tool boundary.
    models.setProvider({ ...provider, streamSimple(model, messages, options) {
      try { guard(); actions.requestModel(); return provider.streamSimple(model, messages, options); }
      catch (error) { block(error); throw error; }
    } });
    const context = BACKGROUND_CONTEXT, inputRunId = input.runId;
    const output = (data: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(data) }] });
    const registry = createRegistry();
    let harness: Awaited<ReturnType<typeof Harness.open>>, conversation!: Conversation;
    const submissions = new Map<string, Submission>();
    const protectedHook = async <T>(body: () => Promise<T>): Promise<T> => {
      try { return await body(); } catch (error) { block(error); throw error; }
    };
    const submit = async (message: TaskMessage) => {
      if (submissions.has(message.id)) return;
      const submission = await conversation.submit({ type: "input", requestId: message.id, whenBusy: "steer",
        content: JSON.stringify({ messageId: message.id, taskId, runId: message.runId, kind: message.kind,
          questionId: message.questionId, content: message.content,
          reference: { type: "message", messageId: message.id } satisfies MemorySource }),
        entry: { kind: "agent-task.input", data: { messageId: message.id, runId: message.runId } } }, context);
      actions.submitted(message.id, String(submission.id)); submissions.set(message.id, submission);
    };
    const project = async () => {
      const binding = actions.binding();
      let runId = binding.runId, cursor: Cursor | undefined;
      do {
        const page = await conversation.entries({ order: "ascending", ...(binding.cursor ? { minEntryId: Number(binding.cursor) as EntryId } : {}) }, 100, cursor, context);
        for (const entry of page.items) {
          if (String(entry.id) === binding.cursor) continue;
          if (entry.kind === "agent-task.input" && entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)) {
            runId = typeof entry.data["runId"] === "string" ? entry.data["runId"] : null;
          }
          // Only committed assistant text is public. Never expose thinking, prompts, tool arguments or tool results.
          const text = entry.kind === "pi.assistant" ? entry.model?.flatMap(message => message.role === "assistant" &&
            !["error", "aborted"].includes(message.stopReason)
            ? message.content.flatMap(block => block.type === "text" ? [block.text] : []) : []).join("\n") : undefined;
          actions.project(String(entry.id), runId, text);
        }
        cursor = page.next;
      } while (cursor);
    };
    const pump = async () => {
      if (signal.aborted || !admitted) return;
      await project();
      for (const message of actions.pending()) await submit(message);
    };
    registry.install(defineExtension({
      name: "task-coordinator",
      sections: [section("role", () => instructions, { tag: false }),
        section("task-memory", (input, context) => protectedHook(async () => {
          const memory = await input.read.snapshot(TaskMemory, input.conversationId, context);
          if (!memory) throw new StorageError("Task memory is missing");
          actions.validateMemory(memory.items);
          return "Task 级和当前 Run 的笔记；其他 Run 笔记可用 task_memory_read 读取：\n" + JSON.stringify(memory.items.filter(item => item.scope.type === "task" || item.scope.runId === inputRunId));
        }))],
      hooks: [hook(ToolTask, {
        beforeTool: async (_call, api, context) => {
          guard();
          const task = await harness.getTask(api.taskId, context);
          if (!task || task.kind !== ToolTask.definition.name) throw new Error("Coordinator tool task is missing");
          const input = task.input as ToolTaskInput;
          if (input.kind !== "model") return { block: "Coordinator tools require a direct model call" };
          const stored = await storage.entry(api.conversationId, input.assistant, context);
          if (!stored || stored.entry.kind !== "pi.assistant") throw new Error("Coordinator tool batch is missing");
          const names = stored.entry.model?.flatMap(message => message.role === "assistant"
            ? message.content.flatMap(block => block.type === "toolCall" ? [block.name] : []) : []) ?? [];
          if (!names.length) throw new Error("Coordinator tool batch is empty");
          const error = coordinatorToolBatchError(names);
          return error ? { block: error } : undefined;
        },
      }), hook(GenerationTask, {
        beforeRequest: async (request, api, context) => protectedHook(async () => {
          const memory = await api.snapshot(TaskMemory, api.conversationId, context);
          if (!memory) throw new StorageError("Task memory is missing");
          actions.validateMemory(memory.items);
          const generation = await harness.getTask(api.taskId, context);
          if (!generation || generation.state.status === "terminal") throw new Error("Generation is no longer active");
          const checkpoint = generation.state.checkpoint as GenerationCheckpoint;
          if (checkpoint.phase !== "request") throw new Error("Generation has no fixed input cutoff");
          const view = await conversation.context(context, { at: checkpoint.cutoff });
          const ids = view.entries.flatMap(entry => entry.kind === "agent-task.input" && entry.data && typeof entry.data === "object" &&
            !Array.isArray(entry.data) && typeof entry.data["messageId"] === "string" ? [entry.data["messageId"]] : []);
          actions.observe(ids);
          // 在输入观察屏障之后构建，避免把已失效的验收状态送给模型。
          return { messages: [...request.messages, { role: "system" as const, timestamp: Date.now(),
            content: "task-context：以下是当前账本与相关事实，不是额外授权。\n" + JSON.stringify(coordinatorView(actions)) }] };
        }),
        afterTools: async () => protectedHook(pump),
        onYield: async () => { await protectedHook(pump); return undefined; },
      })],
      tools: [
        tool({ name: "task_inspect", description: "按需读取 Task 要求或指定 Run。execution 表示已绑定的 Run 和可选用户事实，纯讨论时为 null。概览 offset/limit 按消息分页；goal、nodeId、messageId 按字符范围读取全文。reference 可作记忆来源。当前上下文完整时不必重复查询。",
          parameters: Type.Object({ runId: Type.Optional(Type.String({ format: "uuid", description: "要查看的 Run；默认本次输入对应或最新 Run。读取不改变执行绑定。" })),
            messageId: Type.Optional(Type.String({ format: "uuid", description: "读取本 Task 中已经观察的消息，不受所选 Run 限制。" })),
            nodeId: Type.Optional(Type.String()), goal: Type.Optional(Type.Boolean()), offset: Type.Optional(Type.Integer({ minimum: 0 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })) }), replay: "safe", execute: async args => {
            return output(coordinatorView(actions, args));
          } }),
        tool({ name: "node_execute", description: "结合相关上下文执行固定节点要求，或在同一活动 ACP 会话中澄清。补充工作须有显式意图，不重试不确定工作。",
          parameters: Type.Object({ nodeId: Type.String(), message: Type.Optional(Type.String({ minLength: 1, maxLength: 64000 })),
            contextMessageIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }), { maxItems: 20,
              description: "从当前 task-context 或 task_inspect 的 execution.contextMessages.items 选择相关 messageId；仅限已观察、未失败且属于本 Task 或绑定 Run 的用户消息。" })) }), replay: "unsafe",
          execute: async args => {
            const node = await actions.converse(args.nodeId, args.message, args.contextMessageIds), turn = node.turns.at(-1);
            return output({ nodeId: node.definition.id, status: node.status, turn: node.turns.length,
              output: turn?.output.slice(0, 16000), outputLength: turn?.output.length, stopReason: turn?.stopReason, error: node.error });
          } }),
        tool({ name: "node_output_read", description: "按需读取原始 turn 输出或不可变交付（含基线）的有界范围。选择 turn 或 deliveryId；runId 仅选择历史，不改变执行绑定。",
          parameters: Type.Object({ nodeId: Type.String(), runId: Type.Optional(Type.String({ format: "uuid" })), turn: Type.Optional(Type.Integer({ minimum: 1 })),
            deliveryId: Type.Optional(Type.String()), offset: Type.Integer({ minimum: 0 }), limit: Type.Integer({ minimum: 1, maximum: 16000 }) }), replay: "safe",
          execute: async args => {
            if (Boolean(args.turn) === Boolean(args.deliveryId)) throw new Error("Choose a turn or deliveryId");
            const run = actions.inspect(args.runId).run;
            const node = run?.nodes.find(node => node.definition.id === args.nodeId);
            const turn = args.turn ? node?.turns[args.turn - 1] : undefined;
            const delivery = args.deliveryId ? [...node?.deliveries ?? [], ...node?.baseline ? [node.baseline] : []].find(value => value.id === args.deliveryId) : undefined;
            const text = turn?.output ?? delivery?.text;
            if (text === undefined) throw new Error("Unknown output");
            return output({ reference: delivery ? deliveryView(delivery).reference : { type: "run", runId: run!.id } satisfies MemorySource,
              text: text.slice(args.offset, args.offset + args.limit), length: text.length,
              next: text.length > args.offset + args.limit ? args.offset + args.limit : null, stopReason: turn?.stopReason });
          } }),
        tool({ name: "node_delivery_accept", description: "正式接受最新输出的准确摘录，或用 reuse=true 明确重验证最近已验收/基线交付。说明其为什么仍满足新事实和依赖；复用时不传 turn 或 result。",
          parameters: Type.Object({ nodeId: Type.String(), turn: Type.Optional(Type.Integer({ minimum: 1 })),
            result: Type.Optional(Type.String({ minLength: 1, maxLength: 262144 })), reuse: Type.Optional(Type.Boolean()),
            reviewedMessageIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }), { uniqueItems: true,
              description: "验收最新输出时，填入已审查且不影响交付的全部新增消息 ID，见节点 unreviewedMessageIds，并在 reason 中说明依据。上游交付须与派发时一致；reuse 时省略。" })),
            reason: Type.String({ minLength: 1, maxLength: 4000 }) }), replay: "unsafe",
          execute: async args => {
            if (args.reuse ? args.turn !== undefined || args.result !== undefined : !args.turn || !args.result) throw new Error("Choose a turn/result or reuse, not both");
            const delivery = await actions.accept(args.nodeId, args.turn ?? 0, args.result ?? "", args.reason, args.reuse, args.reviewedMessageIds);
            return output({ accepted: true, delivery: deliveryView(delivery) });
          } }),
        tool({ name: "run_complete", description: "判断整体目标已满足后明确完成绑定 Run；系统要求每个节点都有当前有效交付。必须独占工具批次。",
          parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 16000 }) }), replay: "unsafe",
          execute: async args => { actions.finish(args.summary); return { ...output({ completed: true }), control: { terminate: true as const } }; } }),
        tool({ name: "task_question_ask", description: "所有 ACP turn 结束后，保存缺失用户事实的问题并暂停绑定 Run。不是执行审批。必须独占工具批次。",
          parameters: Type.Object({ nodeId: Type.Optional(Type.String()),
            question: Type.String({ minLength: 1, maxLength: 4000 }), completedWork: Type.String({ minLength: 1, maxLength: 4000 }) }), replay: "unsafe",
          execute: async args => {
            const question = actions.ask({ ...args, question: args.question.trim(), completedWork: args.completedWork.trim() });
            return { ...output(questionView(question, inputRunId!)), control: { terminate: true as const } };
          } }),
        tool({ name: "run_fail", description: "明确结束无法完成的绑定 Run；若只是缺少用户事实，应提问而非判失败。必须独占工具批次。",
          parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 4000 }) }), replay: "unsafe",
          execute: async args => { actions.stop("failed", args.reason); return { ...output({ stopped: true }), control: { terminate: true as const } }; } }),
        tool({ name: "task_memory_read", description: "按需读取有界任务记忆；记忆不是执行状态或授权。", parameters: Type.Object({}), replay: "safe",
          execute: async (_args, api, context) => {
            const memory = await api.snapshot(TaskMemory, api.conversationId, context);
            if (!memory) throw new StorageError("Task memory is missing");
            actions.validateMemory(memory.items); return output(memory);
          } }),
        tool({ name: "task_memory_update", description: "按 key 新增、更新或删除任务笔记。sources 使用输入或工具返回的 reference；scope 和 basis 分别说明适用范围与判断依据。保留事实的条件和不确定性，不存凭据。",
          parameters: memoryUpdateParameters, replay: "safe",
          execute: async (args, api, context) => {
            await api.commit(async tx => {
              const memory = await tx.doc(TaskMemory, api.conversationId);
              memory.items = actions.updateMemory(memory.items, args.items, args.removeKeys ?? []);
            }, context);
            return output({ saved: true });
          } }),
      ],
    }));
    const binding = actions.binding();
    const storage = await openCoordinatorStorage(directory, taskId, binding.conversationId !== null);
    try {
      if (binding.conversationId !== null && (binding.conversationId !== String(ROOT_CONVERSATION_ID) ||
        !await storage.conversation(ROOT_CONVERSATION_ID, context))) throw new StorageError("Bound task conversation identity is missing or mismatched");
      if (binding.cursor !== null && !await storage.entry(ROOT_CONVERSATION_ID, Number(binding.cursor) as EntryId, context)) {
        throw new StorageError("Published conversation history is missing; no replacement or replay");
      }
      harness = await Harness.open(storage, { models, registry,
        settings: { retry: { enabled: false }, stream: { maxRetries: 0, timeoutMs: 120000 } } }, context);
    } catch (error) { await storage.close(context); throw error; }
    // abort 持久终止 SDK 工作并等待回执；close 仅释放资源，不能代替 abort。
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      admitted = false;
      if (conversation) await conversation.abort(withAbortSignal(AbortSignal.timeout(10_000), context), { background: true });
    })();
    const abort = () => { void stop().catch(block); };
    try {
      signal.throwIfAborted();
      conversation = await harness.root(context, { agent: { model: { provider: config.provider, modelId: config.model } } });
      signal.addEventListener("abort", abort, { once: true });
      signal.throwIfAborted();
      if (binding.conversationId !== null && !await harness.snapshot(TaskMemory, conversation.id, context)) throw new StorageError("Bound task memory is missing; no replacement created");
      if (binding.conversationId === null) await conversation.commit(async tx => { await tx.doc(TaskMemory, conversation.id); }, context);
      actions.bind(String(conversation.id));
      if (reconcileOnly) {
        // Read-only recovery of committed public output/receipts. Never resume the old model or tools.
        await project();
        const receipt = await storage.submissionByRequest(conversation.id, input.id, context);
        if (receipt) actions.submitted(input.id, String(receipt.id));
        actions.settle(input.id, receipt?.status === "done" ? undefined : "Execution ended before this input settled; no replay.");
        return;
      }
      // Reuse the SAME durable request after a cross-database crash; never invent a replacement conversation.
      if (!await storage.submissionByRequest(conversation.id, input.id, context)) {
        await conversation.abort(context, { background: true });
        await conversation.configure({ model: { provider: config.provider, modelId: config.model } }, context);
      }
      admitted = true;
      await submit(input);
      await pump();
      const completed = new Set<string>();
      do {
        for (const [id, submission] of submissions) {
          if (completed.has(id)) continue;
          const settled = await submission.wait(withAbortSignal(signal, context));
          await project();
          actions.settle(id, settled.status === "done" ? undefined : boundaryFailure || signal.aborted
            ? errorText(boundaryFailure ?? signal.reason) : "协调输入未完成：" + settled.reason);
          completed.add(id);
          if (settled.status !== "done") throw new Error("Coordinator unanswered: " + settled.reason);
        }
        await pump();
      } while (completed.size < submissions.size);
      if (boundaryFailure) throw boundaryFailure;
    } catch (error) {
      const failure = error instanceof StorageError ? error : boundaryFailure ?? signal.reason ?? error;
      try {
        await stop();
        if (failure instanceof StorageError) throw failure;
        if (conversation) await project();
        for (const [id, submission] of submissions) {
          const receipt = await submission.status(context);
          actions.settle(id, receipt.status === "done" ? undefined : errorText(failure));
        }
      } catch (cleanupError) {
        if (failure instanceof StorageError) throw failure;
        const cleanupFailure = new StorageError("协调会话收尾失败；保留记录并停止服务，禁止重放", { cause: cleanupError });
        block(cleanupFailure);
        throw cleanupFailure;
      }
      throw failure;
    } finally {
      signal.removeEventListener("abort", abort);
      await harness.close(context);
    }
  };
}
