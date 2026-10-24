# 验证导航与证据边界

项目处于调研阶段，不宣称生产可用或外部副作用 exactly-once。以下结论只适用于所列版本、环境和用例；安装、协议连接与真实任务成功是不同证据，不能互相替代。

## 本地验证

```bash
npm run check
npm test
git diff --check
```

基础测试使用真实本地文件、SQLite、进程和 SDK，不调用外部模型，不使用假模型或模拟 provider。各职责的测试入口统一见[代码导航](technical-design.md)。失败进程和 `no_model` 只证明失败路径；结构化状态断言不证明模型语义判断。静态依赖检查不证明运行时权限或外部副作用安全。

[MCP 服务测试](../tests/service.test.mjs)通过真实 HTTP 和 SDK 校验器检查输入/输出契约、成功与失败响应及列表查询。契约不使用数组形式的 `type`，可空字段仍必填并接受 `null`；实现见 [mcp-contract.ts](../src/protocol/mcp-contract.ts)。这不替代曾报告契约警告的客户端复验，其名称和版本尚未提供。

## 宿主接入包

`0.1.0-rc.4` 基线上的接入资产，Linux x64、Node 24.15.0，在无个人凭据的隔离 HOME/宿主配置中验证：未安装服务时，Pi 1.4.0、Claude Code 2.1.302、Codex CLI 0.164.0 均可安装本地接入包并发现 `using-agent-task`。随后用本地构建服务完成 setup，Pi 工具发现、Claude MCP 健康连接、Codex app-server 连接及 `executor_list`、`task_list` 调用通过。证据：`/tmp/agent-task-native-hosts-TvywpQ/report.json`、同目录 `codex-runtime.json`。这是本地资产验证，不表示已发布到 npm 或远端 marketplace。

同一环境中，Pi RPC 发出缺少命令的通知并保留模型上下文，未触发模型运行（`pi-preflight.jsonl`）；Claude headless 原生 SessionStart 执行并返回用户提示和上下文（`claude-hook.jsonl`，MCP 被显式关闭以验证独立性）。Codex 发现同步 hook 且无清单错误，但标记为未信任；未绕过审查执行。

[接入测试](../tests/host-integrations.test.mjs)从真实 tarball、空 npm 缓存离线安装独立接入包，并通过真实 setup、stdio 与官方 MCP SDK 调用上述只读工具。[启动检查测试](../tests/host-preflight.test.mjs)检查配置缺失/损坏、失败进程、输出限制与取消、无目录/锁写入及私密值不回显；hook 故障输出不阻塞会话，正常状态不输出通知。[独立包门禁](../scripts/pack-hosts.mjs)与[服务包门禁](../scripts/pack-release.mjs)检查实际包包含 hook、扩展、清单和 skill。原生宿主不是基础测试依赖。

`@realqiyan/agent-task-hosts@0.1.0-rc.5` 已发布到 npmjs，`latest` 指向该版本；本机发布，无 GitHub provenance。Linux 隔离 HOME/空 npm 缓存中，Pi 从 npm 默认安装、skill 发现和启动通知通过，未运行模型。证据：`/tmp/agent-task-rc5-pi-registry-VbshgS/report.json`。同版本的 Claude/Codex marketplace 及插件清单已推送到远端。

未执行三种宿主的模型驱动安装/setup/日常使用会话、Pi/Claude 模型侧工具调用、真实 TUI 告警展示、Codex 用户信任后的 hook 调用、macOS 接入或自定义 home 的宿主 UI 禁用流程。探针不运行模型或 ACP 领域工作；可发现的真实失败程序只提供连接前置条件，不证明执行端能完成任务。操作入口见[宿主接入](host-integrations.md)。

## 控制台验证

[Web/CLI](../tests/web.test.mjs)、[配置](../tests/settings.test.mjs)和[重启](../tests/restart.test.mjs)测试覆盖真实本机服务的管理互通、旧编辑拒绝、凭据隔离、浏览器请求边界、配置生效与目录切换，以及重启后不确定派发仍被阻断。配置文件测试不构成断电、磁盘满或目录同步失败窗口的完整证据。

尚未完成真实浏览器交互、CSP 执行和跨浏览器缓存/自动填充验收。仍需核对不可信文本不执行脚本或加载外链、离开页面后无令牌残留、配置草稿不被轮询覆盖，以及密钥与配置保存的提示。HTTP 头检查不能替代这些验证。CLI 编辑器交互和隐藏终端凭据输入也未做终端验收，凭据测试使用 stdin。

## 真实模型验收入口

仅在获准环境显式运行，会产生模型费用；不使用个人凭据或真实交易：

- 单节点：`npm run test:e2e`。需安全注入 `DEEPSEEK_API_KEY`，并将 `AGENT_TASK_E2E_EXECUTOR` 设为获准的 `pi`、`codex`、`claude` 或 `opencode`。执行端须另行准备原生认证及无领域副作用的配置，不继承协调密钥。连接时准备缺少的适配器。
- DAG 与人工回复：`npm run test:e2e:human -- --quantity 4`。需已安装 Pi 和获准 DeepSeek 测试凭据；适配器在连接时准备。数量由测试客户端提供，不冒充真人回答。
- 真人模式：`npm run test:e2e:human -- --answer-file /absolute/private/path/quantity.txt`。使用新文件，等待旁边的 `.question.json` 出现，再写入答案。

完整前置检查、参数和断言见 [E2E 用例](../tests/e2e/)、[Pi 启动器](../scripts/run-pi-human-e2e.mjs)。Pi 启动器为两端共用获准测试密钥，创建独立原生配置，只启用 read；这不是 OS 沙箱或独立账户隔离。强杀或断电不能保证临时认证清理，需管理员核查。

### 已验证结论

`0.1.0-rc.1`：2026-10-23，Linux x64、Node 24.15.0，DeepSeek `deepseek-flash` 协调员、隔离的只读 Pi 原生配置及连接时安装的 pi-acp 0.0.34。单节点和三节点 DAG 用例均通过内容断言：

| 范围 | 结论 | 证据目录 |
| --- | --- | --- |
| 单节点 | 真实 ACP 交付保留必需标识与数值，结果文件持久化成功 | `/tmp/agent-task-real-e2e-Igj91J` |
| 三节点 DAG 与人工回复 | 等待后续接同一 Run，在同一节点会话内澄清；已接受上游不重放，文本交付保留必需内容 | `/tmp/agent-task-real-e2e-oreA3j` |

两项用例均在提交后断开客户端，再由新连接观察结果。原始测试日志：`/tmp/agent-task-pi-human-6N0Zlj/test-1.log`。数量来自测试客户端，不是真人文件回复。此证据不代表后续版本已完成模型复验，也不覆盖 Codex、Claude、OpenCode 的模型任务、真实宿主退出或模型执行中重启。

### 必须保留的限制

- **运行成功状态不证明交付完整。** 文本交付验收曾发现：原始输出含必需标识，但协调员接受的摘录遗漏标识，仍将运行标为 `succeeded`；内容断言拒绝了该结果。后续通过不能证明模型始终完整摘录。反例证据：`/tmp/agent-task-real-e2e-XgRgeo`。
- **原生只读配置和 `--offline` 不证明整个执行栈无外部访问。** Pi ACP 验收留下适配器启动时的 `npm view` 版本检查记录；日志没有查询结果，不能确认 registry 请求是否完成。原生记录：`/tmp/agent-task-pi-human-lpMTR3/home/`。原始 stderr 与完整 ACP 通信未保留，也不能据此排除其他访问或诊断错误。
- **检查点不保证外部副作用 exactly-once。** 早期 durable 的真实 SQLite/文件/SIGKILL 研究曾观察到，外部写入后、结果提交前崩溃会使恢复重复写入。这不是 ACP 恢复验收；原记录未提供实验附件链接，不能据此扩大恢复保证。

## 执行端准备与协议连接

Linux x64、Node 24.15.0 的隔离环境证据：

| 范围 | 结论与条件 | 证据 |
| --- | --- | --- |
| 适配器安装 | pi-acp 0.0.34、codex-acp 2.2.2、claude-agent-acp 0.94.0 从 npm registry 安装并复用成功；未启动原生 CLI 或模型 | `/tmp/agent-task-adapter-install-T68wMA/report.json` |
| ACP initialize | Pi 1.3.0 + pi-acp 0.0.34、codex-acp 2.2.2、OpenCode 1.19.3 在无认证 HOME 下通过；未发送 `session/new` 或模型任务 | `/tmp/agent-task-deploy-verified`、`/tmp/agent-task-deploy-final` |

下载成功与 initialize 不证明原生认证、工具授权或任务成功。

## npm 发布候选验证

发布与安装操作由[发布说明](release.md)维护。此处只保留有适用范围的证据，不逐版记录发布过程。

| 范围 | 结论 | 证据 |
| --- | --- | --- |
| `0.1.0-rc.5`，提交 `0ef200f` | Node 22.19.0/24.x 基础检查、包门禁、Linux 独立安装、GitHub OIDC 发布及 npmjs 默认安装验收通过；公开包有 provenance，latest 指向该版本 | [发布运行](https://github.com/realqiyan/agent-task/actions/runs/40104773771)、[npm 版本](https://www.npmjs.com/package/@realqiyan/agent-task/v/0.1.0-rc.5) |
| 同版本，Linux x64、Node 24.15.0 | 从 npmjs 默认安装到独立 prefix，通过前台、Web/CLI 重启、stdio 后台、断开后健康及 stop 检查；捕获输出未发现验证凭据 | `/tmp/agent-task-npm-PmUzGG/report.json` |
| `0.0.1-rc.2`，提交 `48549ea`，历史平台证据 | Ubuntu x64 与 macOS ARM64 hosted runner 在 Node 22.19.0 下使用 CI tarball、无源码完成安装、前台、重启及认证检查 | [Validate 运行](https://github.com/realqiyan/agent-task/actions/runs/39829900075) |

`0.1.0-rc.5` 的发布验收未执行 macOS、浏览器或真实模型/ACP 任务；旧 macOS 证据不覆盖当前版本、Intel Mac、休眠或用户注销。安装检查使用真实失败程序提供可发现路径，不证明成功 ACP 执行。PTY 能力不可用时测试明确跳过，跳过不是通过。

上述发布状态是验收时的事实，不是实时 registry 查询；包内文档是发布提交的快照。

## 证据保管与未验证边界

本地证据目录可能含敏感的任务、会话和原生配置，不上传到 Git 或 npm，也不自动删除。`/tmp` 路径是原始证据定位，不保证仍存在；需长期复核时由管理员安全归档。测试入口说明可验证什么，不等于已经执行。

除各节限制外，以下尚未完成真实验收：

- 复杂任务语义、并行分支与汇合、跨执行端交付；其他模型及 OpenAI 兼容端点差异。
- 各执行端原生权限、认证续期、沙箱、技能/MCP 发现及文件访问边界。
- 真人回答文件模式、并发回复，以及长时间等待或重启后的真实 ACP 会话续答。
- 真实模型崩溃窗口、重复收费和预算行为；系统级强杀、断电、业务库磁盘满、系统自启及真实任务长期监督。
- SDK 升级和历史数据转换；[当前未开放能力](design-proposal.md#当前范围与暂缓能力)不因已有测试通过而获得保证。
