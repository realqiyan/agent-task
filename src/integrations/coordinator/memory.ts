import { Type } from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { MemoryItem } from "../../tasks/model.js";
import { memoryItemData } from "../../tasks/validation.js";

// The model and business validator share the same structured reference contract.
const { $schema: _schema, ...itemSchema } = z.toJSONSchema(memoryItemData, { target: "draft-7", io: "input" });
export const memoryUpdateParameters = Type.Object({
  items: Type.Array(Type.Unsafe<MemoryItem>(itemSchema), { maxItems: 40 }),
}, { additionalProperties: false });

/** Product Task lifetime is the conversation, not an SDK generation/tool task. */
export const TaskMemory = defineDoc<{ items: MemoryItem[] }>({
  kind: "agent-task.memory", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ items: [] }),
});
