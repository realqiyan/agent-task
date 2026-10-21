# 三节点 DAG 与人工回复接口：真实 E2E

## 场景与运行方式

使用真实 DeepSeek `deepseek-flash` 协调员、Pi 1.3.0、pi-acp 0.0.34、HTTP MCP 和两类 SQLite。没有假模型、模拟 ACP 或预填执行结果。

```text
price：计算 17 × 19，接受单价 JSON
  ↓
waiting_input：请求数量；total / audit 未启动，没有保留中的 ACP 会话
  ↓ task_run_reply
 total：读取 price 交付 → 请求补充数量 → 同会话第二 turn 计算总价
  ↓ 接受 total 交付
 audit：读取 total 交付，独立复核 → 接受 JSON → finish_run
```

重复验证命令：

```bash
npm run test:e2e:human -- --repeat 3 --quantity 4
```

输入 `4` 由测试客户端以人工角色经真实 MCP 回复接口提交，**不是声称现场真人答复**。数量未写入任务目标或已提交计划。手动输入模式使用 `--answer-file`，实际问题出现后由操作者写入答案；使用方法见 README。

## 真实结果

修正一项不必要的逐字输出断言后，连续三个新 TaskRun 全部通过，没有失败重试或自动切换模型。每轮三个不同 ACP Session，turn 数分别为 1、2、1；协调请求均为 12 次。总价均为 `323 × 4 = 1292`，最终 `verified=true`。

| 次数 | Run ID | E2E 耗时 | 证据目录 |
| --- | --- | --- | --- |
| 1 | eb73c435-cd90-4156-9245-8e9a04b050f2 | 25.9 秒 | /tmp/agent-task-real-e2e-xAYHwv |
| 2 | ee5aa995-9dd8-45b5-ba93-00352c84d45a | 23.1 秒 | /tmp/agent-task-real-e2e-3BaraF |
| 3 | efb97ecc-6fc9-4e53-886f-e29391546d0e | 25.1 秒 | /tmp/agent-task-real-e2e-rKNdE2 |

测试输出：`/tmp/agent-task-pi-human-s3vBp1/test-1.log` 至 `test-3.log`。该目录下私有 Pi sessions 保留模型响应及真实 `read` 调用，核对到 total 读取本轮 price 结果文件、audit 读取本轮 total 结果文件。不是仅根据模型自报“已读取”作判断。

每轮证据目录包含：

- `events.jsonl`：带时间的任务、等待、回复和状态事件。
- `waiting-run.json`：人工回复前的完整节点和问题记录。
- `run.json`：最终 succeeded、交付、会话和回复记录。
- `state/tasks.sqlite`、`state/coordinators/*.sqlite`：业务事实及真实协调工具记录。
- `state/results/`：接受的原文交付。

## 真人回复验证

随后启动手动模式，由用户在聊天中明确回复 `5`，操作端将该值写入新建答案文件，测试通过真实 `task_run_reply` 提交。没有替用户选择数量。

- Run：`d92f72b0-044a-475c-9568-ae4718ac28f6`，Task：`e8e2cc64-3d0f-46dd-af11-18fade693d17`。
- 实际等待约 114.8 秒；问题无 ACP sessionExpiresAt；等待期间无后续模型或节点启动。
- 回复接收时间：2026-10-21 18:40:47.175 UTC；整轮完成时间：18:40:58.074 UTC（机器日志时间）。
- price / total / audit 全部 succeeded；单价 323、数量 5、总价 1615，复核 verified=true。
- 保持同一 TaskRun、同一计划和节点身份，price 不重跑；total 在同一 ACP 会话内完成两 turn。
- E2E 全部断言通过，总时长约 134.2 秒，包含真人等待；协调请求 12 次。
- 测试日志：`/tmp/agent-task-pi-human-cIeNsW/test-1.log`。
- 事件及完整快照：`/tmp/agent-task-real-e2e-6fepBE/events.jsonl`、`run.json`。
- 运行结束已清空该轮临时 Pi 原生认证，保留所有证据。

## 关键断言

- 在已接受 price 后才提问；其余节点 pending、无 sessionId、无 turn。
- 人工等待至少两秒，步数、节点和交付不变化；问题无 sessionExpiresAt。
- 回复持久化后 TaskRun ID、计划和所有节点 ID 不变。
- price 完整记录与回复前相同，不重算、不替换交付。
- total 的第一 turn 只报告缺少数量，不被接受为计算结果；第二 turn 在同一节点会话中产出正确 JSON。
- total / audit 各自只使用直接上游交付文件引用；最终原文、接受结果和磁盘文件一致。
- 重复相同回复保持相同接收时间；完成后重复回复不重新激活任务。

## 保留的首次失败

最初批次 `/tmp/agent-task-pi-human-CtsUD0`：第一轮通过，第二轮业务 succeeded，但测试断言失败。Pi 附带了工具调用说明和缺少数量的解释，输出不逐字等于 `NEED_QUANTITY`。

修正只允许缺少数量标记旁存在说明文字，不放宽金额、最终 JSON、交付来源、人工等待、同会话续接或不重跑规则。失败记录保留在 `test-2.log` 和 `/tmp/agent-task-real-e2e-VU7coo/run.json`。

## 证据限制

这是串行 DAG 的基本正确性证据，三次通过不构成长期可靠性保证。未验收并行分支、人工等待中重启、长时间真实人工等待、故障恢复、复杂领域任务或其他提供方。

两端共用用户授权的测试密钥，Pi 通过新建原生认证读取，不继承协调密钥环境变量；不证明独立账户隔离。运行结束已清空测试 Pi auth.json，未删除会话和工作目录。只启用原生 read，不是 OS 文件隔离；观察到一次 price 节点尝试读取不存在的 package.json，也说明 Prompt 不是权限边界。测试不执行购买、交易或其他外部业务副作用。

原始证据位于本机 /tmp，不纳入 Git，可能被系统清理；需要长期留存时由管理员安全归档。
