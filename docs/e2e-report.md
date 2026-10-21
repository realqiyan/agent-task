# DeepSeek + Pi ACP 真实 E2E 报告

## 结果

`npm run test:e2e`：1 项通过，0 失败，0 跳过，约 7.3 秒。使用真实外部模型、真实 Pi 进程、pi-acp、HTTP MCP、业务 SQLite 和 durable SQLite，无模拟 provider 或 ACP。

- 模型：协调员和执行端均为 `deepseek / deepseek-flash`。
- Pi / pi-ai / pi-durable：1.3.0；pi-acp：0.0.34。
- 目标：协调员提交单节点计划，让 Pi 计算 `17 * 19` 并附上每次随机生成的标记，再验收和完成。
- Task ID：`1e88d4d9-af68-4a93-99fa-5a38928e28a1`。
- Run ID：`815bd503-dcc7-459f-ba76-82e7274f7f64`。
- ACP Session ID：`01a15f9f-dfb1-72cc-aa1b-fedc3431edaa`。
- 输出与持久交付：`E2E-ce77624489ffc5ba 323`。
- 节点及整轮状态：`succeeded`；错误：null；协调请求：5 次；执行端模型响应：1 次。

## 日志摘要

以下为机器日志中的 UTC 时间，不作为外部授时证明。

| 时间 | 证据 |
| --- | --- |
| 2026-10-21 18:01:12.379 | MCP 创建任务后，提交客户端主动断开 |
| 18:01:12.617 | 协调员开始 |
| 18:01:14.474 | 已提交计划，节点 pending |
| 18:01:15.991 | 节点 running，已记录真实 ACP sessionId |
| 18:01:17.001 | ACP end_turn 后节点 awaiting_review |
| 18:01:18.093 | 协调员接受交付，节点 succeeded |
| 18:01:18.869 | 整轮完成，摘要已持久化 |
| 18:01:19.106 | E2E 断言全部通过 |
| 18:01:19.127 | 服务退出，exitCode=0 |

durable SQLite 中实际模型工具调用依次为：

```text
inspect_run → commit_plan → converse → accept_delivery → finish_run
```

Pi 原生会话记录确认 provider=deepseek、model=deepseek-flash、stopReason=stop，文本为上述交付，usage.totalTokens=530。ACP 将该 turn 映射为 end_turn。E2E 比较原始 turn、接受的交付及磁盘结果文件；不是将协议结束直接判为任务完成。

## 本机原始证据

- 测试输出：`/tmp/agent-task-pi-real-ocRurL/test.log`
- 事件日志：`/tmp/agent-task-real-e2e-MdBEOq/events.jsonl`
- 运行快照：`/tmp/agent-task-real-e2e-MdBEOq/run.json`
- 业务库：`/tmp/agent-task-real-e2e-MdBEOq/state/tasks.sqlite`
- 协调日志：`/tmp/agent-task-real-e2e-MdBEOq/state/coordinators/815bd503-dcc7-459f-ba76-82e7274f7f64.sqlite`
- 交付文件：`/tmp/agent-task-real-e2e-MdBEOq/state/results/815bd503-dcc7-459f-ba76-82e7274f7f64/calc.9c352129-f4b1-471b-b675-5f68b65c34e8.txt`
- Pi 会话：`/tmp/agent-task-pi-real-ocRurL/home/.pi/agent/sessions/--tmp-agent-task-real-e2e-MdBEOq-workspace--/2026-10-21T18-01-15-441Z_01a15f9f-dfb1-72cc-aa1b-fedc3431edaa.jsonl`

这些本机临时文件不纳入 Git，可能被操作系统清理；需长期保留时由管理员安全归档。

## 配置与边界

执行端使用新建私有 HOME、Pi 配置和工作目录。通过 pi-acp 的 PI_ACP_PI_COMMAND 选择本地包装脚本，启动真实 Pi，显式禁用工具、扩展、MCP、技能、提示模板和上下文文件发现，并禁用自动重试。不是仅靠 Prompt 限制操作。

用户授权的测试密钥用于两端：协调员通过环境读取，Pi 通过私有原生 auth.json 读取，执行端不继承协调员密钥或服务 token 环境变量。本次不是独立账户或不同密钥的隔离验收。运行后已清空新建的 Pi auth.json，保留所有会话和任务历史；没有修改用户原有认证文件。

此证据仅证明一次单节点、单 turn、无领域工具的真实闭环，以及提交客户端断开后继续执行。未验证多节点依赖、人工澄清、故障恢复、复杂领域工作、完整沙箱或任意 OpenAI 兼容提供方。复跑入口及前置配置见 README；测试不会自动导入个人认证。
