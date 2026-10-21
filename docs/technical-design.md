# 当前技术设计

当前为 pi durable 协调员 + ACP 执行端的研究实现。目标见[总体方案](design-proposal.md)，证据见[验证说明](validation.md)。没有旧执行引擎或兼容通道。

## 1. 领域与责任

- Task 保存用户目标、允许的执行端及快照、计划、截止和预算。
- TaskRun 是一个时间槽的独立执行实例，保存协调状态、计划、节点和最终声明。
- NodeRun 保存不可替换的节点身份、依赖、ACP sessionId、逐 turn 文本、验收理由及交付引用。
- durable Conversation 是协调对话。当前每轮单独一个 SQLite/Harness，使用其 root；不同轮不会共享上下文。
- ACP Session 属于节点，从首次 Prompt 到验收或整轮停止，跨 turn 保留。不是 durable Conversation，也不是业务账本。

外层时钟只创建 TaskRun。协调员决定计划、派发、澄清及验收；服务强制授权、依赖、预算、截止、状态及恢复约束。模型循环由 SDK 提供，不自写循环。

## 2. 执行契约

公开 task_create 接收 prompt、executorIds、schedule、expiresAt、maxRunSeconds、maxSteps、maxNodeTurns、inputWaitSeconds。由协调员提交最多 20 节点的 DAG，拒绝环、重复 ID、无效依赖及未授权执行端。

计划只提交一次，不支持执行中替换节点或自动重试。单节点与多节点共用这一机制。暂未提供动态修改已提交计划或自定义结果验证器。

节点状态：

```text
pending → running → awaiting_review → running（有限澄清）
                              └──→ succeeded（显式接受交付）
整轮停止：未开始节点 blocked；活动/待验收节点 interrupted
```

- converse 首次只能发送已提交的节点 prompt；后续只能发送到原会话。
- 派发前检查本轮直接上游均 succeeded 且交付文件可读，随后持久保存 running 和 turn 意图，再启动 worker。
- end_turn 只生成待验收 turn，不生成结果文件。
- accept_delivery 只接受最新 end_turn 输出中的非空精确摘录，并记录验收理由。保存文件并 fsync 后才写 succeeded，随后关闭 ACP 会话。
- 文件写入与数据库提交没有跨系统事务；失败可能留下未引用文件，不自动删除或当作成功证据。
- finish_run 要求非空计划全部 succeeded，并保存摘要。协调员自然回答、durable Submission.done 都不能直接完成业务任务。
- request_input 只允许在没有 running 节点时调用。保存具体问题及期限后进入 waiting_input，节点和交付不变；不是等待权限审批。
- 节点调用抛错、会话断开等不确定结果停止整轮；错误的后续工具请求不能重新派发或修改计划绕过终态。

精确摘录只证明来源，验收理由只是模型判断。内容是否真实完成目标尚无独立领域验证；不宣称自动识别所有问题、拒绝或伪造证据。

## 3. 调度、限额和取消

now / once / interval，固定间隔至少 60 秒。游标与新轮次在业务库同一事务提交。相同请求去重、相同时间槽唯一；同 Task 不重叠，忙碌及晚于 30 秒的槽跳过，不补跑。

最多 4 个活动协调员、8 个 ACP 会话。人工等待不占协调名额，保留的 ACP 会话占名额。总运行超时从 coordinatorStartedAt 开始，包含非等待状态的重启时间，扣除 waitedMs。节点会话计时包括启动、执行、等待验收和人工回复，回复不重置。expiresAt 禁止新的协调员或节点开始，不取消已开始会话的后续 turn。

maxSteps 在实际 provider.streamSimple 入口检查并持久计数，涵盖生成和压缩；不用会吞掉普通异常的 beforeRequest hook 做强制门禁。关闭可配置的模型错误重试；压缩和重启重发仍可能产生新请求。该计数不是费用硬上限，也不能精确核对崩溃时尚未返回的供应商账单。

取消先保存业务终态，关闭后续工具入口，再中止协调员和 ACP 会话。worker 断开 IPC 时关闭 ACP 进程组，必要时 TERM/KILL。资源关闭幂等。取消不回滚外部操作。

### 人工输入

TaskRun.questions 保存问题 ID、可选 nodeId、question、completedWork、createdAt、expiresAt、sessionExpiresAt 和回复。全轮最多 20 个问题，一次只有一个待答问题。inputWaitSeconds 默认一天、最多七天；没有 ACP 会话的等待可跨重启保留。有待验收会话时最多保留五分钟，且不超过节点原期限。等待超时为 timed_out；会话丢失或保留到期为 interrupted。两者均关闭会话、阻塞未完成节点并暂停未来周期。

task_run_reply 接收 runId、questionId、requestKey、answer。先检查问题期限，再核对问题身份、去重、业务状态、执行授权及原 ACP 会话；回复和 running 转换在同一事务提交。相同回复重试只返回记录，即使运行已终止；冲突、新的重复回复和过期/取消后的首次回复拒绝。accepted 结果、计划和执行身份不变。

等待时停止本轮总计时器，不再发起模型请求。回复唤醒同一协调库，重新计算剩余预算。旧协调调用绑定自己的输入 ID，不能在快速回复后继续修改状态或将新输入误判为失败。waiting_input 也参与同 Task 不重叠判定，后续时间槽跳过。

人工回复只补充事实。权限拒绝、任务失败和外部结果不明不是可回复问题。当前没有 ACP 重连或人工核对后强制恢复接口。

## 4. 两类存储与恢复

业务唯一事实源为 tasks.sqlite（WAL/FULL）。定义、游标、轮次和节点状态由 TaskStore 保存。调研阶段直接修改当前数据结构，不维护业务库格式版本号，也不提供兼容或迁移路径。仅空库初始化；已有表和记录按当前结构校验，错误直接报告，不改写历史。

协调日志为 coordinators/<TaskRun ID>.sqlite，固定 pi durable 1.3.0，WAL/FULL。SDK schema=1；打开现存库前检查 schema、非终态内建任务版本和文档版本，防止 SDK 自动迁移旧数据。新库独立初始化。不支持旧业务库、旧协调库的隐式转换。

全目录由应用 flock 独占。每轮业务 ID 决定协调库路径；root 创建与稳定 requestId 的提交可以在崩溃后重新查找；初始输入为 run:<Run ID>，每个回复为 reply:<Question ID>。没有跨库原子事务：

1. 业务轮次先保存，协调库后创建；中断时仍能找到同一轮。
2. 派发意图先写业务库，ACP 才能开始。
3. 协调工具记录丢失不改变业务库中的已接受交付或终态。
4. 回复先写业务库，再送入同一协调会话。新回复尚未被 durable 接收时，先用 SDK abort 结束遗留旧 generation，保留会话历史；此阶段模型和工具入口均关闭。若该回复已有 durable 提交，则恢复该提交，不能 abort 或重复创建。
5. 重启先核对业务状态，再决定是否打开对应 Harness；不会对所有旧协调库执行 resume。

存在 running 或 awaiting_review 节点时，原 ACP 连接已不能可信续接，整轮 interrupted，pending 节点 blocked，未来周期暂停。仅有 pending 或已接受节点时可重开同一协调日志、重获同一输入 Submission；waiting_input 仍等待人工，不自动打开 Harness。正常停服也按此边界保存或中断。

所有变更型协调工具声明 replay=unsafe。即使模型恢复后发起新调用，也必须通过业务入口检查；不能依赖 unsafe 标志或 Prompt 防重复。

结果文件、业务记录和协调日志都保留；不自动清理历史。协调日志可能包含模型思考、参数和敏感内容，不能按 ACP 的公开输出投影假设它已脱敏。

## 5. 实际模块

| 文件 | 责任 |
| --- | --- |
| main.ts | 配置、装配、HTTP/MCP transport、锁及关闭顺序 |
| mcp.ts / task-contract.ts | 管理协议与输入数据契约 |
| tasks.ts | 业务状态、时钟触发、协调能力、派发准入、验收和监督 |
| human-input.ts | 人工问题、等待期限、回复去重、状态转换及稳定协调输入 |
| task-model.ts | 普通领域数据和窄 CoordinatorActions / Coordinate / OpenExecution 能力 |
| coordinator.ts / coordinator-provider.ts | durable 工具适配、运行指令、provider 接入和 SDK 生命周期 |
| coordinator-storage.ts | 固定 SDK 存储预检及初始化 |
| task-storage.ts | 业务 SQLite 事务和持久数据校验 |
| permissions.ts | 无 SDK 类型的审批选择策略 |
| acp.ts | 官方 ACP SDK、多轮会话和进程组 |
| node-execution.ts / worker.ts | 每节点独立 worker、IPC 确认、关闭及断连清理 |
| results.ts | 交付文件保存及限定输入文件读取 |
| config.ts / admin.ts / lock.ts | 配置、管理员注册和排他所有权 |

服务不依赖 durable/ACP/MCP SDK；协调接入只有业务窄能力，无通用 Bash/文件写入工具。审批策略已独立于 ACP 类型。

仍为扁平布局：tasks.ts 集中了日历和运行监督；model.ts 混合 schema/类型；results.ts 混合路径授权及文件操作；持久 schema 复用输入契约。尚无依赖边界检查器，不宣称已完成目标分层。

## 6. 外部入口与安全

MCP 提供 12 个 task 管理工具，包含 task_run_reply，绑定回环、Bearer 校验、拒绝 Origin。没有页面、事件分页或文件下载。task_run_get 返回计划、逐 turn 输出、验收和问题。

协调配置只由管理员提供，支持官方 openai/anthropic/deepseek 模型目录及环境凭据；openai-compatible 通过 SDK 的 Chat Completions 或 Responses 接入管理员指定的 baseUrl、模型 ID、上下文/输出上限和 apiKeyEnv。自定义模型仅声明文本输入，价格未知；协议兼容和工具调用能力须另行验收。provider 接入独立于 durable 工具装配，所有 provider 仍通过同一步数门禁。不导入交互式 Pi 配置。未配置协调员时拒绝创建任务。执行端仅允许注册的本机 stdio 命令，环境按 envKeys 选择，不继承服务 token 或当前协调 provider 的 API key；自定义凭据变量同样禁止与 token 或默认继承变量重用。

ACP request_permission 只覆盖收到的审批请求：程序化工具名精确匹配且 rawInput 存在时最多 allow_once，否则 reject_once 或 cancelled。它不是参数级授权、OS 隔离或所有工具入口的控制。执行端原生权限、认证和沙箱仍须真实验收。

## 7. 依据

- [pi durable 1.3.0](https://github.com/earendil-works/pi/tree/v1.3.0/packages/durable)
- [ACP v1](https://agentclientprotocol.com/protocol/v1/session-setup)
- [验证范围](validation.md)
