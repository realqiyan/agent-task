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

## 数据升级与运行提示

`0.1.0` 的[迁移测试](../tests/migration.test.mjs)使用真实文件、SQLite 和 CLI 验证独占拒绝、备份、格式登记、记录与会话保留、持久阶段续接，以及缺表和不安全路径拒绝。[SQLite 测试](../tests/sqlite.test.mjs)验证真实 SDK 存储加载不输出 SQLite 实验性提示，其他警告仍可见。Linux x64、Node 22.19.0 与 24.15.0 已通过这些检查。支持格式和操作步骤见[数据升级](upgrades.md)；未验证断电、磁盘满或其他数据格式转换，不据此推导模型或 ACP 工作可恢复。

## Task 持续对话与记忆

`0.1.0`（pi durable 1.3.0）的[对话测试](../tests/task-conversations.test.mjs)、[人工输入测试](../tests/human-input.test.mjs)和[持久化测试](../tests/task-storage.test.mjs)覆盖可靠输入、待决问题隔离、旧准入拒绝、未处理消息屏障、不可变交付、显式补充与不确定结果阻断。交付与观察状态使用结构化账本输入，只验证业务规则，不冒充 ACP 成功。

[durable 测试](../tests/durable.test.mjs)以真实 SQLite/SDK 验证同一 Task 的提交去重及 conversation-scoped Document 关闭重开后保留，不同 Task 隔离。[对话测试](../tests/task-conversations.test.mjs)还验证已绑定会话文件丢失时不创建空替代，以及终结 Run 的只读对账不调度待运行 SDK 任务。原生 SDK 向已关闭本机端口请求的失败路径验证了输入观察边界、记忆 hook 失败后阻断 provider，以及业务存储失败向应用所有者上报；没有模拟 provider 或成功模型响应。新增资源与收尾测试使用真实 SDK 和本机 TCP 连接验证：耗尽模型额度后不发起下一次请求，本轮本地决定不重复计数；预算停止、连接等待中的取消和停服先终止 SDK，回执保留原因且无活动任务遗留。TCP 测试不实现模型协议或生成响应。这些失败路径不证明模型或记忆工具成功运行。

[真实对话用例](../tests/e2e/task-conversation.test.mjs)已验证模型写入笔记、空闲服务重启后读取、普通讨论与执行隔离，以及补充 Run 的新交付和下游复核。适用环境、证据和模型引用错误统一见[真实模型结论](#已验证结论)及[限制](#必须保留的限制)；不据此推导自动压缩、活动 ACP 恢复或记忆维护普遍可靠。

## 宿主接入包

`0.1.0-rc.4` 基线上的接入资产，Linux x64、Node 24.15.0，在无个人凭据的隔离 HOME/宿主配置中验证：未安装服务时，Pi 1.4.0、Claude Code 2.1.302、Codex CLI 0.164.0 均可安装本地接入包并发现使用引导。随后用本地构建服务完成 setup，Pi 工具发现、Claude MCP 健康连接、Codex app-server 连接及 `executor_list`、`task_list` 调用通过。证据：`/tmp/agent-task-native-hosts-TvywpQ/report.json`、同目录 `codex-runtime.json`。这是本地资产验证，不表示已发布到 npm 或远端 marketplace。

同一环境中，Pi RPC 发出缺少命令的通知并保留模型上下文，未触发模型运行（`pi-preflight.jsonl`）；Claude headless 原生 SessionStart 执行并返回用户提示和上下文（`claude-hook.jsonl`，MCP 被显式关闭以验证独立性）。Codex 发现同步 hook 且无清单错误，但标记为未信任；未绕过审查执行。

[接入测试](../tests/host-integrations.test.mjs)从真实 tarball、空 npm 缓存离线安装独立接入包，并通过真实 setup、stdio 与官方 MCP SDK 调用上述只读工具。[启动检查测试](../tests/host-preflight.test.mjs)检查配置缺失/损坏、失败进程、输出限制与取消、无目录/锁写入及私密值不回显；hook 故障输出不阻塞会话，正常状态不输出通知。[插件包门禁](../scripts/pack-plugin.mjs)检查实际包包含 hook、扩展、清单和 skill，并验证两个 npm marketplace 的版本；[服务包门禁](../scripts/pack-release.mjs)拒绝混入插件资产。原生宿主不是基础测试依赖。

`task-conductor-plugin@0.1.0` 已发布，npmjs latest 指向该版本；本机发布，无 GitHub provenance。Linux x64、Node 24.15.0 下，公开 registry 安装与宿主清单检查通过，证据：`/tmp/task-conductor-plugin-install-GkbIjx/report.json`。当前源码的离线打包安装与 stdio 工具调用通过；三种宿主的原生安装及真实模型任务尚未复验。

以下为 `0.1.0-rc.6` 的历史宿主分发证据，不代表正式版复验：Linux x64、Node 24.15.0 的隔离 HOME/空 npm 缓存中，Pi 1.4.0 的 npm 安装、Claude Code 2.1.302 的清单 URL → npm 安装、Codex CLI 0.164.0 的同仓稀疏索引 → npm 安装均通过。Pi 的 skill 发现和缺少服务命令时的通知、Codex 的 skill/hook 发现通过；没有授予 hook 信任或调用模型。证据：`/tmp/agent-task-rc6-native-b6lchl/remote-report.json`、同目录 `report.json`、`pi-runtime.jsonl`、`codex-runtime.json`。本地开发快照的安装证据为 `/tmp/agent-task-npm-source-nNH1U9/local-report.json`。本次 npm 分发验收不代替上文的 MCP 连接证据或真实任务验收。

未执行三种宿主的模型驱动安装/setup/日常使用会话、Pi/Claude 模型侧工具调用、真实 TUI 告警展示、Codex 用户信任后的 hook 调用、macOS 接入或自定义 home 的宿主 UI 禁用流程。探针不运行模型或 ACP 领域工作；可发现的真实失败程序只提供连接前置条件，不证明执行端能完成任务。操作入口见[宿主接入](host-integrations.md)。

## Pi 会话通知

`0.1.0-rc.9` 候选源码，Linux、Node 24.15.0、原生 Pi SDK 1.4.0：[通知测试](../tests/notifications.test.mjs)验证真实 SQLite 的事件/Run 原子提交、确认回滚、租约接续、会话隔离、Cron 独立事件、真实 MCP 创建绑定及 HTTP 认证边界；真实 Git/文件测试验证项目身份初始化与复用。

[原生 Pi 用例](../tests/pi-notifications.test.mjs)验证 followUp 排队尚无磁盘回执、空闲唤醒后自定义消息保存、恢复去重和不同会话标识隔离；实际 tool_call 扩展事件与 MCP 调用验证创建前注入身份。端到端用例通过真实 setup、后台、CLI 轮询和 Pi 扩展收到协调认证缺失产生的失败事件，并检查消息落盘后服务才保存渠道确认。

这些用例不使用个人凭据或成功模型响应；Pi 模型请求仅连接本机无响应 TCP 服务。未验证模型最终汇报质量、真实 TUI 展示、macOS、远程/多用户部署、极端租约竞争、完整原生 fork/会话切换 UI 流程。基础测试未配置原生 SDK 路径时明确跳过原生用例；运行方式及设计边界见[通知说明](notifications.md)。

## 控制台验证

[Web/CLI](../tests/web.test.mjs)、[配置](../tests/settings.test.mjs)和[重启](../tests/restart.test.mjs)测试覆盖真实本机服务的管理互通、旧编辑拒绝、凭据隔离、浏览器请求边界、配置生效与目录切换，以及重启后不确定派发仍被阻断。配置文件测试不构成断电、磁盘满或目录同步失败窗口的完整证据。

尚未完成真实浏览器交互、CSP 执行和跨浏览器缓存/自动填充验收。仍需核对不可信文本不执行脚本或加载外链、离开页面后无令牌残留、配置草稿不被轮询覆盖，以及密钥与配置保存的提示。HTTP 头检查不能替代这些验证。CLI 编辑器交互和隐藏终端凭据输入也未做终端验收，凭据测试使用 stdin。

## 真实模型验收入口

仅在获准环境显式运行，会产生模型费用；不使用个人凭据或真实交易：

需安全注入获准的 `DEEPSEEK_API_KEY`。隔离 Pi 验收使用已安装的 Pi，适配器在连接时准备：

- 单节点：`npm run test:e2e:human -- --suite single`。
- DAG 与问题回答：`npm run test:e2e:human -- --quantity 4`。数量由测试客户端提供，不冒充真人回答。
- 持续对话、记忆重开与补充执行：`npm run test:e2e:human -- --suite conversation`。用例仅在无活动协调或 ACP 工作时重启自己的隔离服务；SDK 观察器不写记忆、不恢复任务，也不提供模型响应。
- 真人模式：`npm run test:e2e:human -- --answer-file /absolute/private/path/quantity.txt`。使用新文件，等待旁边的 `.question.json` 出现，再写入答案。

其他已获准且原生认证与无领域副作用配置已准备的执行端可用 `npm run test:e2e`，将 `TASK_CONDUCTOR_E2E_EXECUTOR` 设为对应类型。此入口不代为隔离原生配置，不继承协调密钥；就绪不代表授权或成功。

当前三组 E2E 使用中文要求、标识回传与字面字段传递，不再要求算术或开放式审计。调用方明确要求的简单 JSON 对象由测试直接比对；真实模型、ACP、依赖读取、等待续答、记忆重开和补充交付仍走原有流程。简化只降低领域推理噪声，不保证模型稳定调用工具，也不验证复杂领域判断。

完整前置检查、参数和断言见 [E2E 用例](../tests/e2e/)、[Pi 启动器](../scripts/run-pi-human-e2e.mjs)。Pi 启动器为两端共用获准测试密钥，创建独立原生配置，只启用 read；这不是 OS 沙箱或独立账户隔离。强杀或断电不能保证临时认证清理，需管理员核查。

### 已验证结论

`0.1.0-rc.9` 通知功能候选工作树，Linux x64、Node 24.15.0，协调者与隔离原生 Pi 均使用 DeepSeek `deepseek-flash`：单节点、人工续答 DAG（测试数量 3）、持续对话三组真实 E2E 各一次全部通过，临时原生凭据已清理。证据分别为 `/tmp/agent-task-pi-human-JCNSBo/test-1.log`、`/tmp/agent-task-pi-human-mTZ7BV/test-1.log`、`/tmp/agent-task-pi-human-UB32Hm/test-1.log`。同一工作树的 91 项基础测试（含三项原生 Pi 通知用例）全部通过，无跳过；不据此推导模型稳定性、真实 TUI 或其他平台已验收。

发布前的中文协调重构工作树（`0.1.0-rc.6`，基于 `459f46b`），Linux x64、Node 24.15.0、pi durable 1.3.0，协调者与原生 Pi 均使用 DeepSeek `deepseek-flash`：三组字面字段 E2E 各执行一次均通过。单节点使用 3/6 次模型请求，人工续答 DAG 使用 11/18，持续对话两次 Run 使用 6/25、5/25。只读核查 6 个库、4 个 Run、8 个原生会话及 9 个 turn，交付、依赖文件读取、旧记录保留和来源引用一致；9 个 SDK 输入全部 done，无活动 SDK 任务或工具错误。证据：`/tmp/agent-task-coordinator-refactor-jJBkc9/audit.json`。这是一次通过，不证明稳定性或复杂领域判断；新模型请求单位不能与旧混合步数直接比较。

以下旧模型结果属于混合步数机制，用于保留不同失败边界，不证明新资源和收尾机制。

2026-10-25，未发布的 Task 会话重构工作树（包版本 `0.1.0-rc.6`，基于提交 `a185e2a`）：Linux x64、Node 24.15.0、pi durable 1.3.0、Pi 1.4.0、pi-acp 0.0.34；协调员和执行端均用 DeepSeek `deepseek-flash`，独立 HOME/数据目录，原生工具仅 read。三组真实用例检查内容与持久状态，保留成功及失败结果，不以成功标签替代交付检查。以下为结构化来源接口的证据：

| 范围 | 结论 | 证据目录 |
| --- | --- | --- |
| 单节点 | 真实 ACP 输出保留标识与正确乘积 323，验收文本与持久结果一致 | `/tmp/agent-task-real-e2e-ALJyUL` |
| 三节点 DAG 与问题回答 | 有成功样例：同一 Run/ACP 会话续接，上游只重验证，最终数值 1292；最终重复验收因 35 步预算耗尽失败，不能宣称稳定完成 | 成功 `/tmp/agent-task-real-e2e-hGnB7A`；失败 `/tmp/agent-task-real-e2e-NNsCbz` |
| 持续对话、记忆与补充 | 普通讨论不启动 ACP 或回答问题；有来源的笔记重启后被实际读取；补充节点同时选用 Task 级与本轮消息，新交付为 1615，旧 Run 的 969 及旧文件不变；此次无工具错误 | `/tmp/agent-task-real-e2e-Lm1NrB` |

适用接口、结果及原始日志定位：`/tmp/agent-task-real-e2e-Lm1NrB/acceptance-report.json`。DAG 成功样例在读取参数名称统一前完成；最终重复失败另列，未重放或覆盖。记忆快照、工具结果和原生会话保留在报告指向的私有目录。临时原生认证与服务凭据已清理。数量和消息来自声明的测试客户端，不是真人回答。

同一模型与原生环境、基于 `459f46b` 的未发布工作树改用字面字段传递后，持续对话用例通过，覆盖两次 Run、记忆重开、实际下游读取与旧交付不变；单节点和三节点 DAG 的交付均已验收，但完成前分别耗尽 12/35 步预算，不能宣称三组全通过。证据：`/tmp/agent-task-simple-e2e-FbSVEV/audit.json`。简化领域任务不消除额外记忆操作和模型参数错误的开销。

这些结果不代表已发布包、其他执行端或模型、自动历史压缩、已验收 ACP 活动会话内的补充工作、模型执行中重启或外部写操作已验收。

### 必须保留的限制

- **引用正确不证明笔记语义正确。** 旧接口曾出现来源 ID 类型混用及上下文规则过度概括，证据为 `/tmp/agent-task-real-e2e-aqywJK/coordinator-evidence.json`。结构化引用和可选上下文列表改善了选择，但笔记的陈述/推断归类及适用范围仍由模型判断，不构成用户确认；新对话证据中，本次数量仍被写成 Task 级笔记。中文字面传递验收也仍有范围过宽的会话失效教训，以及未明确标注时间的历史“尚未生成交付”陈述；见新机制审计中的 memory。定向记忆写入与重开读取不证明自主记忆维护可靠。
- **模型参数错误会消耗执行预算。** 最终 DAG 复验中，模型添加了未声明的记忆字段，校验拒绝后纠正；随后耗尽 35 步预算，audit 输出虽已完成却未验收，Run 失败。证据为该失败目录的 `coordinator-evidence.json`、`latest-run.json`。预算阻断有效，不代表该预算下任务稳定完成。
- **模型复核可能把正确结果判错。** 会话复验中，原始交付正确计算 `17×19=323`，下游却声称结果为 289；协调员接受错误审计并写入记忆。重跑已验收节点被授权门禁拒绝后，模型用事实问题请求执行授权，Run 留在 `waiting_input`；SDK 输入均正常结束。证据：`/tmp/agent-task-recheck-NXU1M4/review.json`。这是领域判断和工具语义使用的失败，不是等待收尾异常；结构化记忆来源不能保证内容正确。
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

自定义本机 stdio ACP 的源码测试入口：[执行端测试](../tests/executors.test.mjs)、[Web/CLI](../tests/web.test.mjs)、[MCP](../tests/service.test.mjs)。它们校验私有注册持久化、即时准入、重启保留、启动快照不被替换、仅自定义执行端时的 MCP 接入及管理员/MCP 权限分离；[任务测试](../tests/tasks.test.mjs)另以真实失败进程验证可选启动 `cwd` 及任务 workspace 保持不变。真实本地程序只证明参数直传、启动目录与失败路径，不证明自定义 ACP 兼容或任务交付。自定义执行端尚未进行真实 ACP/模型验收。

## npm 发布候选验证

发布与安装操作由[发布说明](release.md)维护。此处只保留有适用范围的证据，不逐版记录发布过程。

| 范围 | 结论 | 证据 |
| --- | --- | --- |
| `task-conductor@0.1.0`，Linux x64、Node 24.15.0 | TypeScript、依赖边界、包门禁、隔离 tarball 与 npmjs 默认安装通过；基础测试及原生 Pi 1.4.0 通知用例共 91 项全部通过；latest 指向该版本，本机发布，无 GitHub provenance | `/tmp/task-conductor-npm-oODcC0/report.json`、`/tmp/task-conductor-npm-YlKO9H/report.json`、`/tmp/task-conductor-final-tests.log` |
| `0.0.1-rc.2`，提交 `48549ea`，历史平台证据 | Ubuntu x64 与 macOS ARM64 hosted runner 在 Node 22.19.0 下使用 CI tarball、无源码完成安装、前台、重启及认证检查 | [Validate 运行](https://github.com/realqiyan/task-conductor/actions/runs/39829900075) |

当前发布验收未执行 macOS、浏览器或真实模型/ACP 任务；旧 macOS 证据不覆盖当前版本、Intel Mac、休眠或用户注销。安装检查使用真实失败程序提供可发现路径，不证明成功 ACP 执行。PTY 能力不可用时测试明确跳过，跳过不是通过。

上述发布状态是验收时的事实，不是实时 registry 查询；包内文档是发布提交的快照。

## 证据保管与未验证边界

本地证据目录可能含敏感的任务、会话和原生配置，不上传到 Git 或 npm，也不自动删除。`/tmp` 路径是原始证据定位，不保证仍存在；需长期复核时由管理员安全归档。测试入口说明可验证什么，不等于已经执行。

除各节限制外，以下尚未完成真实验收：

- 复杂任务语义、并行分支与汇合、跨执行端交付；其他模型及 OpenAI 兼容端点差异。
- 各执行端原生权限、认证续期、沙箱、技能/MCP 发现及文件访问边界。
- 真人回答文件模式、并发回复，以及长时间等待或重启后的真实 ACP 会话续答。
- 真实模型崩溃窗口、重复收费和预算行为；系统级强杀、断电、业务库磁盘满、系统自启及真实任务长期监督。
- SDK 升级和历史数据转换；[当前未开放能力](design-proposal.md#当前范围与暂缓能力)不因已有测试通过而获得保证。
