# 智能任务总体方案

本文保留产品目标和当前架构取舍。实现入口见[代码导航](technical-design.md)，实际证据见[验证说明](validation.md)。

Task 会话连续性、可靠输入、Document 记忆与补充交付的设计理由见[会话设计](task-conversation-plan.md)。这些源码能力尚未发布，真实模型验收边界见[验证说明](validation.md#task-持续对话与记忆)。

使用流程简化的决策原因见[请求去重范围](adr/0001-task-request-scope.md)、[工作目录来源](adr/0002-mcp-workspace-source.md)和[适配器安装](adr/0003-adapter-installation.md)。

## 产品目标

- 调用方通过 MCP 提交整体目标、DAG 和每节点的 ACP 执行端指派，支持立即、定时及 Cron 周期执行；Cron 使用五段表达式与显式时区，契约见 [task-contract.ts](../src/protocol/task-contract.ts)。
- 任务不依赖发起客户端持续在线，保留执行、交付、失败和缺少用户事实的记录。
- 初始化由用户确认目录、端口、令牌及协调模型；内置执行端自动发现并按需准备适配器；自定义本机 stdio ACP 由管理员注册，持久化后立即生效，无须重启。stdio 接入连接独立后台，宿主退出后后台继续调度；宿主配置由用户添加，不自动识别宿主当前项目。
- 协调者通过判断与记忆推进既定 DAG，对整体目标负责，解释中间结果、处理证据冲突和澄清并明确验收；领域工作交给 ACP 执行端。固定 DAG 不固定模型的工具调用路线。
- 每个 Task 保留一条持续协调会话，支持主动讨论、补充信息和有来源的任务笔记；对话不等于执行。缺少事实时明确提问，回答后续接原 Run；额外执行与成果复用保留独立意图及不可变历史。
- 提供本机 Web 控制台，管理配置、查看任务，并只控制任务的未来触发；CLI 覆盖全部 Web 管理能力，两端复用同一套服务。配置保存后通过 Web 或 CLI 重启生效；切换数据目录不搬迁或删除旧历史。

Pi Agent、Codex、Claude、OpenCode 是 ACP 集成目标，不是嵌入本服务的领域执行器。声明支持、代码实现和真实验收必须区分。

## 架构选择

```text
MCP 调用方：定义 DAG、指派执行端
                 │
任务服务：时间计划、准入、持久事实与监督
                 │
pi durable：每个 Task 的持续协调会话与记忆
                 │ 受控业务工具
ACP 执行端：原生会话、领域推理和工具操作
```

| 选择 | 原因 |
| --- | --- |
| 调用方固定 DAG，协调员只推进 | 保留调用方对计划和执行端的控制，不引入第二个规划器 |
| 复用 durable 模型循环与检查点 | 不自写模型循环；SDK 的恢复能力仍需按实际版本验证 |
| 确定性服务把守授权、资源和完成前提，承担工程收尾 | 不替模型作业务判断，也不让模型承担回执和资源一致性；具体边界见[会话设计](task-conversation-plan.md) |
| 业务账本与模型会话分开 | 对话和工具记录不能代替派发、交付或外部业务事实 |
| 单节点与多节点共用 Task 模型 | 不维护两套 API、存储适配或调度器 |

时间计划和显式补充意图决定是否准入业务 Run；协调员只在该 Run 的权限与预算内决定节点派发。协议 turn 结束不等于交付完成，只有明确接受的执行端交付才能解锁依赖。

交付由协调员及下游 Agent 阅读，不要求统一 JSON 或固定模板，普通文本和 Markdown 均可。验收关注内容是否满足节点目标；只有调用方明确提出格式要求时才检查格式。协议封装不规定交付正文的格式。

人工回复只补充事实，不授予权限或允许重放。会话丢失、外部结果不明时停止并核对，不能用新任务或新节点绕过。其他安全与持久性要求见[架构原则](architecture-guidelines.md)。

## 当前范围与暂缓能力

数据格式以 `0.1.0` 为基线，后续存储变化提供[显式离线迁移](upgrades.md)。正常启动不转换历史，不通过删除记录或重放工作升级数据。

暂不实现：执行中修改 DAG、自动重试或跨端故障转移、丢失 ACP 会话的重连、人工核对后强制恢复、远程执行、多租户、技能同步及动态 MCP 转发。它们需要独立产品决策，不因引入 durable 自动获得。

启动方式见[部署说明](deployment.md)。[本机控制台](web-console.md)复用任务服务，使用独立管理员认证与浏览器请求边界；不提供文件下载或其他任务写操作。

## 外部依据

- [Pi durable](https://github.com/earendil-works/pi/tree/v1.3.0/packages/durable)
- [ACP 会话](https://agentclientprotocol.com/protocol/v1/session-setup)、[工具与权限](https://agentclientprotocol.com/protocol/v1/tool-calls)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

实际依赖版本以 [package.json](../package.json) 和锁文件为准；协议说明不是验收证据。
