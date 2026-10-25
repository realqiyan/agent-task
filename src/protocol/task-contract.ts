import { z } from "zod";
import { requestTimestamp } from "../shared/validation.js";
import { cronScheduleData, nodeData, messageData, replyData, runStatusSchema, taskData, taskScheduleControlData } from "../tasks/validation.js";

export const nodeSchema = nodeData.extend({
  id: nodeData.shape.id.describe("DAG 内由调用方定义的唯一节点 ID，供 dependsOn 引用；不是 Run UUID。"),
  prompt: z.string().trim().min(1).max(64_000).describe("执行端的独立工作要求与验收标准。整体目标、选定用户事实和已验收上游引用仅补充上下文，不替换要求。未指定格式时允许普通文本或 Markdown 交付。"),
  executorId: nodeData.shape.executorId.describe("来自 executor_list 且 state=ready 的执行端 ID；创建后固定，不自动切换。"),
  dependsOn: nodeData.shape.dependsOn.default([]).describe("直接上游节点 ID；无依赖时可省略。节点必须存在，不得重复、自引用或成环。仅已验收交付解锁本节点，上游以文件路径提供，不传完整会话。"),
  maxRunSeconds: nodeData.shape.maxRunSeconds.default(600).describe("从打开起计算的 ACP 会话总寿命，单位秒；包括执行、审查、澄清和等待用户，不按 turn 重置。"),
});
export const replySchema = replyData.extend({
  taskId: replyData.shape.taskId.describe("问题所属的 Task。"),
  questionId: replyData.shape.questionId.describe("task_run_list/get 中最新未回答的 questions[].questionId。须早于 expiresAt 及非空 sessionExpiresAt 回答。"),
  requestKey: replyData.shape.requestKey.describe("调用方指定、Task 内唯一的回答去重键。每个新回答用新键；相同键、questionId 和去除首尾空白后的 answer 返回原回执，不重复续接，即使运行已结束。内容冲突则拒绝。"),
  answer: z.string().trim().min(1).max(16000).describe("用户提供的事实回答，不是猜测或权限授予。存储和去重前去除首尾空白。"),
});
export const messageSchema = messageData.safeExtend({
  taskId: messageData.shape.taskId.describe("消息接收方 Task 协调者；节点不是独立聊天入口。"),
  requestKey: messageData.shape.requestKey.describe("Task 内稳定的输入去重键，与问题回答共用；完全相同的重提返回同一回执。"),
  message: z.string().trim().min(1).max(16000).describe("用户消息或相关事实；不回答待决问题，也不授予执行端权限。"),
  runId: messageData.shape.runId.describe("可选的上下文 Run。execute=true 时必填，指向活动 Run 或成功的基线 Run。"),
  execute: messageData.shape.execute.default(false).describe("明确请求固定 DAG 内的补充工作。省略或 false 表示讨论或上下文；空闲讨论不启动 ACP。"),
});
export const messageListSchema = z.object({
  taskId: z.string().uuid(), after: z.number().int().nonnegative().default(0).describe("递增的公开消息游标，不解析其含义；传入 next 继续。"),
  limit: z.number().int().min(1).max(100).default(20),
}).strict();
export const taskIdSchema = z.object({ taskId: z.string().uuid().describe("task_create 或 task_list 返回的持久 Task UUID；不是 Run ID。") }).strict();
export const runIdSchema = z.object({ runId: z.string().uuid().describe("task_run_list 或 task_run_get 返回的持久 Run UUID；不是 Task 或 DAG 节点 ID。") }).strict();
export const taskListSchema = z.object({
  after: z.number().int().nonnegative().default(0).describe("匹配记录中从 0 开始的偏移，按创建时间升序；不是 ID 或时间戳。保持过滤条件并传入 next 继续。刷新时从 0 开始，尤其使用状态过滤时；分页不是快照。"),
  limit: z.number().int().min(1).max(100).default(20).describe("每页最多返回的记录数。"),
}).strict();
export const taskRunListSchema = taskListSchema.extend({
  taskId: z.string().uuid().optional().describe("按 Task UUID 过滤 Run。省略则查询所有 Task；不存在的 Task ID 返回空页。"),
  status: runStatusSchema.optional().describe("按 Run 状态过滤；省略则包含所有结果。waiting_input 用于查找问题；running 也包括等待调度的 Run，不只指活动 ACP 工作。"),
});
export const taskScheduleControlSchema = taskScheduleControlData.extend({
  taskId: taskIdSchema.shape.taskId,
  action: taskScheduleControlData.shape.action.describe("pause 保留并暂停下一次触发；resume 恢复但不补跑，过期 Cron 时点跳到未来，过期 now/once 变为 completed；cancel 永久取消未来触发。pause/resume 要求仍有触发时点；存在中断节点时拒绝 resume。"),
});
export const taskSchema = taskData.extend({
  requestKey: taskData.shape.requestKey.describe("调用方指定的创建去重键，作用域为规范工作目录。重提时保持不变：规范化参数相同则返回已有任务，包括已取消或完成任务；参数变化则冲突。新键表示新工作，不是重试。"),
  name: z.string().trim().min(1).max(200).describe("简短显示名称，不是标识符或去重键。"),
  prompt: z.string().trim().min(1).max(64_000).describe("协调者的整体目标与最终交付标准。各执行端的具体要求写入节点 prompt；整体目标不替换 DAG。"),
  nodes: z.array(nodeSchema).min(1).max(20).describe("完整固定 DAG；单步任务使用一个节点。执行顺序只由 dependsOn 限定，不由数组位置限定；独立节点允许并发。"),
  workspace: taskData.shape.workspace.describe("服务机器上已存在的绝对目录，规范化后固定用于所有 Run。仅本地 stdio 可省略并使用其启动目录，该目录未必是宿主当前项目。直接 HTTP 必填；不是沙箱或授权。"),
  schedule: z.discriminatedUnion("type", [
    z.object({ type: z.literal("now").describe("立即具备触发条件的单次时点；系统异步创建并准入 Run。") }).strict(),
    z.object({
      type: z.literal("once").describe("指定未来时间的单次触发。"),
      at: requestTimestamp.describe("带 UTC Z 或数字时区偏移的未来 ISO 8601 时间，规范化为 UTC。"),
    }).strict(),
    cronScheduleData.safeExtend({
      type: z.literal("cron").describe("周期日历时点；首次匹配严格晚于创建时间，不以上一 Run 完成为起点。"),
      expression: z.string().trim().min(1).max(200).describe("五字段：分、时、日、月、星期，例如 0 9 * * 1-5。不支持秒、@ 别名或散列 H 字段。日与星期均受限时按 OR 匹配。"),
      timezone: z.string().trim().min(1).max(100).describe("必填 IANA 时区，例如 Asia/Shanghai 或 UTC；不从服务环境推断。夏令时遵循 cron-parser 的日历规则。"),
    }),
  ]).describe("Run 具备准入条件的时间，不保证实际开始时间。迟到超过 30 秒或与本 Task 正在运行/等待的 Run 重叠时跳过，不排队补跑。"),
  expiresAt: requestTimestamp.optional().describe("新 Run 和新 ACP 工作的截止时间，不是完成超时。须晚于首次触发，不终止已开始的 ACP turn。使用带时区的 ISO 8601；省略则不设截止时间。"),
  maxRunSeconds: taskData.shape.maxRunSeconds.default(1800).describe("Run 从协调开始计算的执行时长，单位秒，包含 ACP 执行但扣除等待用户的时间；独立于 expiresAt 和节点会话寿命。"),
  maxModelCalls: taskData.shape.maxModelCalls.default(20).describe("每个 Run 最多准入的模型请求次数，包含失败请求及 SDK 压缩请求。每次请求计一次，工具不重复计数；等待及回答不重置。独立讨论按输入使用同样上限，工程收尾不消耗模型额度。"),
  maxNodeTurns: taskData.shape.maxNodeTurns.default(3).describe("每个 Run 内每个节点最多 ACP turn 数，包括首轮工作、澄清和显式授权的补充工作，不允许自动重试。"),
  inputWaitSeconds: taskData.shape.inputWaitSeconds.default(86400).describe("每个用户回答的等待秒数。保留 ACP 会话时，还受 300 秒上限和剩余会话寿命约束。以问题 expiresAt 和非空 sessionExpiresAt 中较早者为准。"),
});
