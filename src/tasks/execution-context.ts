import { TaskError } from "../shared/errors.js";
import { OUTPUT_LIMIT } from "../shared/limits.js";
import type { NodeDefinition, TaskInput } from "./model.js";

/** 按结果文件布局预留固定依赖和旧交付；UUID 长度固定，摘录按 JSON 最大转义长度计算。 */
export function validateExecutionContext(task: TaskInput, node: NodeDefinition, resultsRoot: string): void {
  const uuid = "00000000-0000-4000-8000-000000000000";
  const resultFile = (nodeId: string) => `${resultsRoot}/${uuid}/${nodeId}.${uuid}.txt`;
  try {
    executionContext(task, node, {
      upstream: node.dependsOn.map(nodeId => ({ nodeId, deliveryId: uuid, resultFile: resultFile(nodeId) })),
      previousDelivery: { runId: uuid, deliveryId: uuid, resultFile: resultFile(node.id),
        excerpt: "\u0001".repeat(500), length: OUTPUT_LIMIT },
    });
  } catch (error) {
    if (!(error instanceof TaskError)) throw error;
    throw new TaskError("validation", "整体目标、节点要求与必要交付引用组成的上下文超过 128000 字符，任务未创建");
  }
}

/** 首轮、续答和创建校验共用同一执行上下文边界。 */
export function executionContext(task: TaskInput, node: NodeDefinition, context?: {
  userFacts?: { messageId: string; kind: string; runId: string | null; createdAt: string; content: string;
    questionId: string | null; question: string | null }[];
  upstream?: { nodeId: string; deliveryId: string | null; resultFile: string | null }[];
  previousDelivery?: { runId: string; deliveryId: string; resultFile: string; excerpt: string; length: number } | null;
  clarification?: string;
}): string {
  const text = "你负责当前节点的交付，协调者负责推进 DAG、向用户提问和验收。结合整体目标、用户事实及本轮补充要求完成固定节点要求；缺少必要信息或权限时，向协调者说明。\n" +
    "upstream 提供已验收的直接上游输入，previousDelivery 提供本节点旧交付的摘录和来源；全文可按需读取 resultFile。\n" +
    "固定节点要求：\n" + node.prompt + "\n\n执行上下文：\n" + JSON.stringify({
      taskGoal: task.prompt, userFacts: context?.userFacts ?? [], upstream: context?.upstream ?? [],
      previousDelivery: context?.previousDelivery ?? null, clarification: context?.clarification ?? null,
    });
  if (text.length > 128000) {
    throw new TaskError("precondition", "节点上下文超过 128000 字符，本次未派发；可减少选定事实或精简本轮补充要求");
  }
  return text;
}
