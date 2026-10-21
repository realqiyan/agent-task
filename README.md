# Agent Task

独立的智能任务服务：**MCP 管理任务，pi durable 驱动协调员，ACP Agent 完成具体工作**。

每个 TaskRun 有独立持久协调会话。协调员根据目标提交 DAG、派发节点、处理澄清并验收交付；确定性服务负责授权、预算、状态和进程监督。没有自写模型循环，也没有第二套自动推进节点的调度器。

当前属于调研阶段，直接调整当前接口和数据结构，不做旧版兼容、业务库版本递增或迁移；不删除已有数据。已验证 DeepSeek + Pi ACP 单节点闭环及三节点串行 DAG、人工回复接口和同会话多 turn（见[单节点报告](docs/e2e-report.md)、[多节点报告](docs/human-e2e-report.md)）；复杂任务及并行场景尚未验收，不能用于无人值守交易。

## 文档

- [总体方案](docs/design-proposal.md)：目标、职责和范围。
- [技术设计](docs/technical-design.md)：实际契约、恢复策略和模块。
- [架构原则](docs/architecture-guidelines.md)、[开发指南](AGENTS.md)。
- [验证说明](docs/validation.md)：本地证据及未验证范围。

## 安装与启动

需要 Linux、Node.js 22.19+、util-linux flock。ACP 执行端/适配器需另行安装并准备好原生认证和权限；本项目不读取用户 Pi/Codex 配置。

```bash
npm ci --ignore-scripts
npm run check
npm run build
cp config.example.json config.local.json
```

配置一个新的私有绝对 `dataDir`，并按需配置协调模型：

```json
{
  "dataDir": "/absolute/private/path/agent-task-research",
  "port": 8765,
  "tokenEnv": "AGENT_TASK_TOKEN",
  "coordinator": {"provider": "openai", "model": "YOUR_AVAILABLE_MODEL_ID"},
  "executors": []
}
```

协调员支持 pi-ai 官方 `openai`、`anthropic` 和 `deepseek` provider，模型 ID 必须存在于固定版本 SDK 的模型目录中。对应凭据为 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`DEEPSEEK_API_KEY`。例如：

```json
"coordinator": {"provider": "deepseek", "model": "deepseek-flash"}
```

OpenAI 兼容提供方使用独立配置，不受内置模型目录限制：

```json
"coordinator": {
  "provider": "openai-compatible",
  "api": "openai-completions",
  "baseUrl": "https://your-provider.example/v1",
  "model": "YOUR_MODEL_ID",
  "apiKeyEnv": "COORDINATOR_API_KEY",
  "contextWindow": 32768,
  "maxTokens": 4096,
  "reasoning": false
}
```

`api` 默认为 `openai-completions`（Chat Completions），也支持 `openai-responses`。`baseUrl` 是 API 根地址，不包含 `/chat/completions` 或 `/responses`；仅允许 HTTP(S)，不能包含凭据、查询参数或片段。远程连接应使用 HTTPS。`apiKeyEnv` 仅为环境变量名，不接受明文密钥或命令；无需认证的本地端点也需将该变量设为非空占位值。按供应商实际能力填写上下文及输出上限，`reasoning` 默认 false。自定义模型价格未知，SDK 中的零价格不代表免费。

兼容接入要求端点支持所选 API 的流式响应及工具调用；不保证所有声称 OpenAI 兼容的服务均可直接运行。特殊协议差异需另行验证和适配，不自动切换 API 或模型。DeepSeek 已通过一次单节点真实 E2E；其他兼容端点尚未真实验收。

配置仅由管理员提供，不导入 Pi 的个人配置、不提供交互登录或请求级模型/端点配置。缺少 coordinator 时仍可查询管理接口，但拒绝创建任务。无效模型或认证会明确失败，不替换模型。

```bash
export AGENT_TASK_TOKEN="YOUR_RANDOM_TOKEN_AT_LEAST_32_CHARACTERS"
# 通过安全环境配置准备协调模型及执行端凭据，不写入 Git。
npm start -- --config "$PWD/config.local.json"
```

默认 `http://127.0.0.1:8765/mcp`，Streamable HTTP。每次请求需 `Authorization: Bearer <token>`；拒绝 Origin。客户端断线不取消任务。没有 HTTP 页面、OAuth 或多用户隔离。服务 token 与模型凭据必须分开。

## 注册 ACP 执行端

执行配置只能由管理员设置。停服后运行：

```bash
node dist/admin.js register /absolute/path/config.local.json /absolute/path/profile.json
node dist/admin.js list /absolute/path/config.local.json
```

示例 profile，路径需替换为真实规范绝对路径：

```json
{
  "id": "project-agent",
  "command": "/absolute/path/to/acp-entry",
  "args": [],
  "cwd": "/absolute/path/to/project",
  "envKeys": ["HOME"],
  "permissionAllowlist": [],
  "unattendedApproved": false,
  "resultReadRoots": ["/absolute/private/path/agent-task-research/results"]
}
```

- command 必须是真实 ACP stdio 入口，普通 CLI 不能只改名称当作 ACP server。配置加载时检查执行文件是否可执行；直接配置 `pi` 会被拒绝并提示使用 ACP 适配器。直接配置 `pi-acp` 且未选择 `PI_ACP_PI_COMMAND` 覆盖时，还检查服务 PATH 中是否存在可执行的 `pi`。这不是协议或认证验收，任意包装脚本的内部依赖仍需单独验证。
- 先创建结果目录，再注册读取范围。需要依赖上游结果的执行端必须获准读取该目录。
- 默认只继承 PATH、LANG、LC_ALL、TZ；其他环境变量由 envKeys 明确选择。禁止继承服务 token 和当前协调 provider 的 API key。执行端须使用独立的凭据引用或原生认证配置。
- 审核执行端原生权限后才能将 unattendedApproved 改为 true；它不是隔离证明。
- ACP 请求审批时只按程序化名称精确匹配 permissionAllowlist，最多 allow_once；否则拒绝。该回调不检查所有业务参数，也无法限制不申请审批的原生工具。
- 任务保存执行配置快照。实际派发再次检查管理员配置；配置变化或授权撤销会拒绝执行。
- 执行端的模型认证、技能、MCP 和原生工具由执行端预配置，不动态转发任务提交方的资源。

Pi 的 ACP 适配器需独立安装，不作为本服务的嵌入执行器：

```bash
npm install -g pi-acp@0.0.34 --ignore-scripts
command -v pi
command -v pi-acp
```

将 `command -v pi-acp` 的绝对路径填入执行配置的 command，args 可为空。`pi-acp` 启动 Pi RPC 并将其转换为 ACP；普通 `pi --mode rpc` 不能直接接入。服务不会自动安装、调用交互登录或修改执行端权限。

仅验证握手、不发任务：

```bash
node scripts/probe-agent.mjs config.local.json project-agent
```

握手不是完整任务验收。Pi Agent、Codex、OpenCode 是 ACP 执行端集成目标，不要求在服务内部嵌入这些执行端。

## 真实 E2E 验证（显式运行，会产生模型费用）

`npm test` 不调用外部模型。`npm run test:e2e` 使用真实 DeepSeek 协调员，经 MCP 创建单节点任务，由已审核的 ACP 执行端计算简单算式，再检查会话、原始输出、接受的交付、结果文件和整轮成功；提交客户端断开后仍须完成。

运行前将 `DEEPSEEK_API_KEY` 注入当前进程环境，并准备独立、受限的 ACP 执行配置：

```bash
export AGENT_TASK_E2E_EXECUTOR=/absolute/path/approved-acp-profile.json
# 可选：固定 SDK 目录中的其他 DeepSeek 模型
export AGENT_TASK_E2E_MODEL=deepseek-flash
npm run test:e2e
```

profile 格式同管理员注册，必须 `unattendedApproved: true`。测试将 cwd 改为新建的私有临时工作区，将 resultReadRoots 置空；其他命令、参数及 envKeys 沿用审核配置。执行端凭据须独立准备，不能传入协调员的 `DEEPSEEK_API_KEY`。仅安装 `pi` CLI 不等于具备 ACP 服务，需另行准备真实 ACP 适配器；不能用 `pi --mode rpc` 替代。应使用不加载个人配置、禁用领域工具和外部副作用的执行端原生配置；测试 Prompt 不是沙箱。

测试不读取个人认证文件，不自动安装适配器或放宽权限。缺少前置条件直接失败，不以跳过代替通过。最多 12 次协调请求、每轮 180 秒，但不是费用硬上限。每次运行保留私有临时目录中的配置、业务库、协调日志和交付；终态另存 `run.json`，`events.jsonl` 记录状态变化及验证结果，不记录密钥或原始进程错误输出。输出目录路径用于人工核查，不自动删除，内容可能敏感。该用例只验证单节点基本闭环，不证明多节点、人工澄清或所有端点兼容性。

### 三节点与人工回复的真实用例

新命令会准备私有 Pi 配置和工作目录，直接使用已安装的 `pi`、`pi-acp`，无需手写 profile。**仅用于获准测试环境，会调用真实付费模型**；从当前环境取得 `DEEPSEEK_API_KEY`，两端共用该测试密钥，Pi 使用新建的原生认证文件而不是继承协调密钥环境变量。退出时清空新建认证文件，保留全部会话和运行证据，不读取或覆盖个人 Pi 配置。

```bash
# 在同一 shell 中加载你已审核的凭据配置，再运行：
npm run test:e2e:human -- --repeat 3 --quantity 4
```

这条命令使用明确的人工角色测试输入 `4`，经真实 `task_run_reply` 提交，不把它称为真人回答。`--repeat` 是独立新任务的重复验证（最多 5 次），不是失败重试；任何失败立即停止。不要以三次成功推断所有模型输出都稳定。

流程：`price` 计算单价 323 并接受交付 → 在没有活动 ACP 会话时 `waiting_input` → 提交数量 → `total` 读取单价、在同一 ACP 会话内两轮确认数量并计算 → `audit` 读取总价并独立复核 → 接受全部交付并完成。数量不写入原任务 Prompt，由回复接口引入。测试检查等待期间不调用模型或派发下游、续接同一轮及节点、上游不重跑、直接依赖文件正确、最终 JSON 和金额正确、重复回复不重新执行。

若要由真人决定数量：

```bash
# 使用不存在的新文件，目录应为私有目录。不要提前写入答案。
npm run test:e2e:human -- --answer-file /absolute/private/path/quantity.txt
# 另一个终端：等待 quantity.txt.question.json 出现，查看实际问题，再回答：
printf '5\n' > /absolute/private/path/quantity.txt
```

测试在 `quantity.txt.question.json` 写入实际问题、Run ID、证据目录和测试等待期限；只接受 1–9 的整数。它读取答案后调用 MCP 回复接口，不直接改数据库。手动等待最多 15 分钟，无 ACP 会话五分钟保留限制；超时退出并正常停服，保留证据，不伪造成功。重新运行须使用新的文件路径，拒绝重放旧答案。

Pi 仅启用原生 `read` 工具，禁用写入、Bash、扩展、MCP、技能和自动重试；用例显式批准新建结果目录。**这不是 OS 沙箱，Pi 原生 read 不经过平台 ACP 文件回调**，因此应在受限测试环境使用。日志目录由命令打印，包含每次测试日志和 Pi 会话；每轮业务证据另存私有目录中的 `events.jsonl`、`waiting-run.json`、`question.json`、`run.json`、`latest-run.json`。强制杀死或断电不能保证临时认证清理，需管理员核查。

## 创建智能任务

```bash
node scripts/mcp-call.mjs task_create '{
  "requestKey": "inspect-001",
  "name": "检查项目",
  "prompt": "只读检查项目结构，再检查测试入口，汇总证据。缺少关键资料时明确报告问题。",
  "executorIds": ["project-agent"],
  "schedule": {"type": "now"},
  "maxRunSeconds": 1800,
  "maxSteps": 40,
  "maxNodeTurns": 3,
  "inputWaitSeconds": 86400
}'
```

Prompt 不授予权限。调用者只提供目标和可使用的已注册执行端，不提供命令、目录、凭据或模型配置。

协调员提交一次至多 20 个节点的 DAG，服务检查授权、重复 ID、依赖和环。节点计划包含 prompt、executorId、dependsOn 和 maxRunSeconds。计划提交后不可替换，避免通过新身份重试结果不明的操作。单节点与多节点共用这一条执行路径。

### 完成与交互

- 每节点启动一个受监督 ACP 会话；可以在同一会话内进行多轮 Prompt，不在 turn 结束时关闭进程。
- `end_turn` 只进入 `awaiting_review`，不自动成功，也不生成下游结果。
- 协调员可补充已有可信信息；缺少用户事实时，等待所有 ACP turn 结束，再调用 request_input。服务保存问题 ID、关联节点、问题、已完成工作和期限，进入 `waiting_input`。
- 人工通过 task_run_reply 回答，续接原 TaskRun 和协调会话，保留计划、节点身份及已验收交付。等待时不发起模型请求，不占协调运行名额；保留的 ACP 会话仍占名额。回复不授予权限。
- 协调员必须显式接受最新 turn 的非空原文摘录并说明验收理由。服务保存摘录为交付文件，不将整段对话或协调员编写的替代结果作为节点产物。
- 下游只有在所有直接上游均有已接受交付后才能启动。输入文件范围固定在本轮直接上游。
- 全部计划节点均已接受后，协调员还须显式调用 finish_run；普通最终回答不会标记任务成功。
- 这仍是模型语义验收，不证明内容客观正确。高风险任务需要领域验证，不可只靠协调员判断。

### 人工回复

先通过 task_run_get 读取 questions 中尚未回复的问题，再提交：

```bash
node scripts/mcp-call.mjs task_run_reply '{
  "runId": "RUN_UUID",
  "questionId": "QUESTION_UUID",
  "requestKey": "answer-001",
  "answer": "请使用资料 X；检查范围仅限 Y。"
}'
```

同一轮内 requestKey 去重：相同问题和答案返回现有记录，不重复唤醒；参数冲突、过期问题、已回答问题的新回复及取消后首次回复均拒绝。已收录回复的重试即使在终态也只返回记录，不重启运行。

无未验收 ACP 会话时，等待可跨停服保留。有会话时最多保留 5 分钟，且不超过节点原超时；questions.sessionExpiresAt 显示更早的会话期限。会话断开、停服或保留期结束后整轮 interrupted，不能再用回复强制继续。须先核对外部结果；当前没有会话重连或人工核对后恢复接口，不能以新建任务代替核对。

### 计划和限制

schedule 支持 now、once（带时区的 at）、interval（带时区的 startAt、seconds 至少 60）。未来计划时间必须有效。

- expiresAt 限制新的协调运行和 ACP 节点开始；不主动中止已开始会话。
- maxRunSeconds：本轮协调开始后的墙钟预算，默认 1800 秒，扣除持久人工等待时长；重启不重置。
- inputWaitSeconds：每个问题的独立等待期限，默认 86400 秒，最多 7 天；全轮最多 20 个问题。等待超时则 timed_out，未来周期暂停。
- maxSteps：实际协调模型请求次数上限，含压缩请求，默认 40；不是金额硬上限。
- maxNodeTurns：每节点 turn 上限，默认 3。
- 节点 maxRunSeconds：从启动到关闭会话的时间，包括等待验收和人工回复，最多 3600 秒；人工回复不重置节点计时或 turn 预算。
- 全服务最多 4 个协调运行和 8 个 ACP 会话。容量不足时协调员须先完成/接受已有工作。
- 每 500ms 检查计划。同一 Task 不重叠轮次；人工等待也属于未结束轮次，忙碌或晚于 30 秒的时间槽跳过，不集中补跑。
- 每节点累计输出最多 256 KiB、进展最多 2000 条；ACP 单消息最多 1 MiB，stdout/stderr 合计最多 8 MiB。

## 查询与管理

```bash
node scripts/mcp-call.mjs --list
node scripts/mcp-call.mjs service_status
node scripts/mcp-call.mjs task_run_list '{"taskId":"TASK_UUID"}'
node scripts/mcp-call.mjs task_run_get '{"id":"RUN_UUID"}'
```

| MCP 工具 | 含义 |
| --- | --- |
| service_status / executor_list | 健康、活动运行和可选执行端 |
| task_create / task_list / task_get | 创建及查询任务定义 |
| task_pause / task_resume / task_cancel | 仅控制未来触发，不补跑 |
| task_run_list / task_run_get | 本轮计划、逐 turn 输出、交付、验收理由和错误 |
| task_run_reply | 回答本轮持久问题；同一 requestKey 幂等，不扩大授权 |
| task_run_cancel | 停止本轮，不回滚外部副作用 |

共 12 个工具；列表用 after/limit 分页，响应含 next。相同 requestKey 和相同输入返回同一任务，参数冲突拒绝。无修改/删除接口；修改目标须显式创建新任务。

## 存储与恢复

- `tasks.sqlite`：业务事实唯一来源，WAL + FULL；不维护业务库格式版本号。
- `coordinators/<TaskRun UUID>.sqlite`：该轮独立 durable 会话、工具记录和检查点，WAL + FULL。
- `results/<TaskRun UUID>/...txt`：已接受交付，权限 600。
- 同一 dataDir 由 flock 排他持有。各数据库没有跨库事务；TaskRun ID 决定协调库路径，初始提交使用 run:<Run ID>，每个回复使用 reply:<Question ID>，重试不重复提交。
- 派发前业务库先保存 running 和 turn 意图。结果不明时整轮 interrupted，不重开 ACP、不让模型换节点重试。
- 重启发现 running/awaiting_review 节点，整轮中断并暂停未来周期；仅有 pending/已接受节点的运行可续接原协调检查点；waiting_input 则继续等待，不自动调用模型。
- durable 不重放不安全工具；安全协调恢复仍可能重新请求模型并收费。它不提供外部副作用 exactly-once。
- 正常关闭无 ACP 会话的运行保留协调检查点；有 ACP 会话则中断。无后台 Agent 脱离服务监督。
- 仅空库初始化；现有表和记录按当前结构读取校验，不转换、删除或修复。SDK 固定为 1.3.0，打开旧协调库前检查 schema 和活跃任务/文档版本。以后升级需单独审核和离线方案。
- 协调库包含模型会话内容，可能含思考和工具参数；ACP 只保存公开文本，不保存 thought 和 raw 工具输入输出。所有数据都可能敏感，必须保护整个 dataDir。

## 部署与验证

[systemd 模板](deploy/agent-task.service.example)需自行安装和修改路径。配置私有 EnvironmentFile；若要求注销后继续运行，按系统策略启用用户 lingering。cgroup 是进程清理边界，不是工具沙箱。

```bash
npm run check
npm test
git diff --check
```

只保留关键本地测试，使用真实文件、SQLite、进程和 SDK，不用假模型。当前测试不证明真实模型的规划质量或 ACP 成功执行，详见[验证说明](docs/validation.md)。
