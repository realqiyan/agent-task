import { Type } from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { MemoryItem } from "../../tasks/model.js";
import { memoryItemData } from "../../tasks/validation.js";

// The model and business validator share the same structured reference contract.
const { $schema: _schema, ...itemSchema } = z.toJSONSchema(memoryItemData, { target: "draft-7", io: "input" });
export const memoryUpdateParameters = Type.Object({
  items: Type.Array(Type.Unsafe<MemoryItem>(itemSchema), { maxItems: 40, description: "按 key 新增或更新的条目；未列出的笔记保持不变。仅删除时传空数组。" }),
  removeKeys: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" }),
    { maxItems: 40, uniqueItems: true, description: "明确删除的笔记 key；不存在的 key 不产生变化，不能同时更新同一 key。" })),
}, { additionalProperties: false });

/** Product Task lifetime is the conversation, not an SDK generation/tool task. */
export const TaskMemory = defineDoc<{ items: MemoryItem[] }>({
  kind: "agent-task.memory", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ items: [] }),
});
