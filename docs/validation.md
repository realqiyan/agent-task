# 研究验证与限制

本文只记录证据边界。架构见[总体方案](design-proposal.md)，实现见[技术设计](technical-design.md)。

## 基础关键测试

使用 node:test、真实本地文件、SQLite、Node 子进程、MCP SDK 与 pi durable 1.3.0，不使用假模型、mock、stub 或模拟 provider。

- 真实 durable SQLite 提交后关闭/重开，固定 requestId 找回同一提交，不同 TaskRun 存储隔离。
- 用 SDK 提交未执行的 generation/compaction 任务，关闭后重开保留身份、pending 状态和检查点；未知类型/版本仍拒绝且不改写记录。该用例在修复前复现版本误判：SDK 的 kind 索引列是 JSON 编码字符串，预检现从 record 解码 kind 与 version。此测试不证明真实模型崩溃后续答成功。
- 没有模型配置的真实 SDK 返回 no_model；它只验证错误路径及持久提交，不证明模型执行成功。
- MCP 认证/Origin 边界；客户端断开后任务仍触发；无效协调模型明确失败，未派发 ACP，也不误报成功。
- 结构化业务记录验证：问题文本的 end_turn 不自动生成交付，不解锁依赖；只接受最新 turn 的原文摘录；未完成计划不能 finish。
- 计划图、授权、提交去重、步数预算，以及不可替换执行身份。
- 人工等待跨业务库重开保留、跳过重叠时间槽；回复保留交付及节点身份，相同回复幂等，冲突/过期/取消后的新回复拒绝。
- 回复落库前后重开真实 durable SQLite，同一会话保留初始提交及唯一回复提交；仅验证 no_model 路径，不证明成功模型续答。
- 快速回复不会被旧协调调用结束误判为失败；MCP 回复接口能唤醒等待轮次并返回幂等记录。
- 结构化会话记录验证：原 ACP 会话缺失、重启或保留期限结束时 interrupted，不接受回复重发操作。
- 恢复时有活动/待验收 ACP 节点则 interrupted，无外部会话的运行保留可恢复状态。
- 真实 /usr/bin/false 证明执行失败后停止整轮；真实 /usr/bin/sleep 证明取消和超时能关闭等待中的进程。两者都不是 ACP Agent。
- worker 在 readiness 前关闭，不启动 ACP，关闭幂等。
- 审批仅精确匹配，缺元数据拒绝，不选择永久允许；公开 ACP 输出不含 thought/raw 工具数据。
- 结果读取须同时满足本次精确文件集合和管理员范围；拒绝符号链接和越界输入。
- 管理员注册、排他锁、配置原子保存；不相关的数据库拒绝打开且保留原记录。
- DeepSeek 内置目录及自定义 Chat Completions/Responses 模型注册、配置约束、协调凭据与 token/执行端隔离；不发网络请求。

测试按研究阶段保留基础关键边界，不追求穷举或覆盖率。结构化 turn/验收记录的测试不伪装成真实 Agent 输出或语义判断。

运行命令：npm run check、npm test、git diff --check。check 仅检查 TypeScript，未实现依赖边界检查。

## 真实 E2E 入口与当前结果

`npm run test:e2e` 单独运行 `tests/e2e/deepseek-acp.test.mjs`，不包含在基础测试中。它要求实际 DeepSeek 环境凭据及管理员审核的 ACP profile，经 MCP 提交简单算式任务，并验证真实 sessionId、end_turn 输出、接受交付、结果文件和 succeeded 状态。它不使用假模型或模拟 ACP，不自动读取个人认证或安装适配器，运行证据保留在私有临时目录。

已使用用户授权的 DeepSeek 凭据，完成一次真实 DeepSeek 协调员 → MCP 任务 → pi-acp 0.0.34 → Pi 1.3.0 → 接受交付 → succeeded 的单节点闭环。两端模型均为 deepseek-flash，协调请求 5 次，执行端响应 1 次；提交客户端断开后继续完成，1 项 E2E 测试通过。原始 turn、交付文件、业务库和 durable 工具调用均已核对。日志、运行身份、认证配置及验收限制见[真实 E2E 报告](e2e-report.md)。运行准备见 README。

`npm run test:e2e:human -- --repeat 3 --quantity 4` 使用真实 Pi 与 DeepSeek，三个独立三节点串行 DAG 连续通过。测试客户端经真实人工回复接口提供数量，等待期间无活动 ACP 会话；回复后保留上游交付，total 同会话两轮澄清，audit 读取真实交付复核。该输入是明确的测试夹具，不冒充真人。原始证据、首次逐字断言失败及修正见[多节点 E2E 报告](human-e2e-report.md)。`--answer-file` 手动模式也已真实通过：用户回复 5，等待约 114.8 秒后续接同一 TaskRun，三个节点完成并复核总价 1615；见同一报告中的真人回复证据。

配置前置测试覆盖执行文件缺失时的安装提示、误用 Pi RPC 时的拒绝，以及直接配置 pi-acp 时缺少 Pi PATH 依赖的提示。任意包装脚本依赖、认证和模型工具调用不在这些静态检查的证明范围内。

## 前期研究证据

- 官方 @agentclientprotocol/codex-acp 2.2.2 曾在空临时 HOME/CODEX_HOME 下完成 ACP v1 initialize，未使用个人认证，未发送 session/new 或 session/prompt。只证明握手。
- pi durable 1.3.0 曾在临时目录进行真实 SQLite/文件/SIGKILL 实验：外部文件写入后、结果提交前崩溃，恢复检查点导致未做幂等保护的文件写入再次发生。证明检查点不提供外部副作用 exactly-once，不是 ACP 恢复验收。

## 尚未验证

- 超出已验证单节点与三节点算式任务的复杂目标验收、其他模型及 OpenAI 兼容端点的协议差异。
- 并行分支和汇合、不同执行端间的依赖交付闭环。
- 协调员对问题、拒绝、不完整结果的语义判定质量；精确摘录和验收理由并不证明正确。
- 各执行端原生权限、认证续期、沙箱、技能/MCP 发现及跨端结果文件访问。
- 真实模型请求/工具调用各崩溃窗口的恢复、重复收费和预算行为。
- 系统级强制终止、断电、磁盘满和 systemd 用户注销/重启/cgroup 清理。
- 人工等待期间保留真实 ACP 会话的续答、并发回复、长时间等待及崩溃窗口；已验证用例在无活动 ACP 会话时等待。
- SDK 升级、历史数据转换和执行中修改计划。

真实验收必须使用获准环境、受限目录和最小凭据。没有使用个人凭据或真实交易。当前不宣称生产可用、所有工具完全授权或外部操作 exactly-once。
