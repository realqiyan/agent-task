# 验证导航与证据边界

**当前使用流程简化已通过本地基础测试、适配器安装、独立安装包验收，以及单节点与三节点 DAG 的真实模型复验。** 具体版本、环境和证据见下文。项目不宣称生产可用或外部副作用 exactly-once。

## 本地验证

```bash
npm run check
npm test
git diff --check
```

各职责的测试入口见[代码导航](technical-design.md)。基础测试使用真实本地文件、SQLite、进程和 SDK，不调用外部模型，不使用假模型或模拟 provider。失败进程和 no_model 只证明失败路径；结构化状态用例不证明模型语义判断。`check` 同时执行 TypeScript 与[依赖边界检查](../scripts/check-boundaries.mjs)，后者检查模块依赖、循环、SDK 位置和 Run 写入口；它不证明运行时权限或模型语义。

[MCP 服务测试](../tests/service.test.mjs)还通过真实 HTTP `tools/list` 获取全部工具的输出契约，确认嵌套字段均有校验约束，并用 SDK 的 AJV 校验器验证每个工具的成功和参数错误响应、稳定错误 `code`、业务失败、分页、按状态过滤及紧凑任务/运行列表。反例验证缺失字段、错误类型和矛盾的成功/失败封装被拒绝。契约入口见 [mcp-contract.ts](../src/protocol/mcp-contract.ts)。这不替代原警告客户端的复验；其名称和版本尚未提供。

2026-10-23，Linux x64、Node 24.15.0：使用流程简化通过类型与依赖边界检查、49 项基础测试和包清单门禁。重点证据：

- [stdio 进程测试](../tests/stdio.test.mjs)：两个项目并发连接只保留一个后台；目录默认值、显式覆盖及跨项目请求键独立。关闭 stdin 和向客户端进程组发送 SIGHUP 后，后台仍触发未来任务。这些运行因 `no_model` 失败，只证明持续调度与无误派发，不证明 ACP 成功。
- [MCP 服务测试](../tests/service.test.mjs)：没有原生 CLI 时拒绝连接，管理接口可用；安装到已有 PATH 后，下次连接重新发现。直接 HTTP 提交缺少目录时拒绝。
- [执行端测试](../tests/executors.test.mjs)：原生 CLI 与适配器分开检测，禁用不安装，已有安装离线复用；真实失败安装进程不替换已发布组件，关闭时取消等待且不释放其他进程的锁。
- [初始化 PTY 测试](../tests/setup.test.mjs)：目录、端口和令牌须确认，取消不写文件；协调员密钥隐藏输入，生成令牌不输出。初始化不安装执行端。
- [启动锁测试](../tests/sqlite.test.mjs)：四个真实进程同时争用全新锁文件时，只有一个取得所有权；持锁进程强杀后可重新取得锁。修复前曾复现所有启动器同时争锁失败，修复后使用有限的错开重试，不触发任务重放。
- [存储测试](../tests/task-storage.test.mjs)与[任务测试](../tests/tasks.test.mjs)：固定规范工作目录、按目录去重、严格记录拒绝而不修复、事务失败回滚、先持久派发意图再启动真实进程，以及关闭与迟到回调。

当前版本的真实模型证据见 [0.1.0-rc.1 复验](#010-rc1-复验)。本次未运行 macOS 验收。此前模块化重构的 42 项测试及临时源码副本中的依赖违规拒绝实验也已通过，属于本次改造前的证据。

## 控制台验证

[Web/CLI 用例](../tests/web.test.mjs)使用真实本机服务进程验证两端查询与保存的互通、旧草稿拒绝、发现状态和禁用策略一致、凭据引用保护、离线失败不写文件，以及独立管理员认证、Host/Origin/请求类型边界、有限任务写入、密钥不回显或进入日志。也验证重启后的配置差异和目录切换不复制历史。[重启用例](../tests/restart.test.mjs)验证前台 CLI、固定端口进程更换、绑定失败不能报成功，以及持久化的不确定派发在重复重启后仍被阻断。实际任务记录来自业务服务，不使用假模型输出。

[配置用例](../tests/settings.test.mjs)验证私有文件边界、旧编辑拒绝、显式凭据环境、端点与密钥引用分离、服务令牌别名不能作为模型凭据、失败时保留文件，以及关闭后拒绝操作。这些用例不构成断电、磁盘满或目录同步失败窗口的完整证据。

尚未完成真实浏览器交互、CSP 执行和跨浏览器缓存/自动填充验收；CLI 的编辑器交互和隐藏终端凭据输入也未做终端验收，凭据测试使用 stdin。需在浏览器核对：不可信任务文本不执行脚本或加载外链；离开、刷新和退出后无令牌残留；配置草稿不被轮询覆盖；密钥保存与配置保存的提示明确。HTTP 头检查不能替代这些验证，也不证明模型认证或 ACP 执行成功。

### 执行端与安装包

同日使用隔离 HOME，从 npm registry 真实安装 pi-acp 0.0.34、codex-acp 2.2.2 和 claude-agent-acp 0.94.0，再确认后续准备复用同一安装。报告位于 `/tmp/agent-task-adapter-install-T68wMA/report.json`。没有启动原生 CLI、发送 ACP 会话或调用模型；成功下载与准备不等于认证或任务成功。

由当前源码打包的本地 tarball 通过独立 prefix 安装验收，不依赖源码或 TypeScript。前台启动、Web HTTP 保存、Web/CLI 重启、stdio 自动启动后台、执行端发现、客户端断开后后台健康，以及显式 stop 均通过。使用真实失败程序提供可发现的原生路径，未执行 ACP 或模型工作；捕获输出未发现验证凭据。报告位于 `/tmp/agent-task-npm-LD5GQJ/report.json`。临时目录可能被系统清理，长期证据需安全归档。

当前候选的发布状态见下文；历史包验收不代替当前 macOS、真实宿主应用或四种执行端的模型任务复验。

## 真实模型验收入口

仅在获准环境显式运行，会产生模型费用；不使用个人凭据或真实交易：

- 单节点：`npm run test:e2e`。需安全注入 `DEEPSEEK_API_KEY`，并将 `AGENT_TASK_E2E_EXECUTOR` 设为获准的 `pi`、`codex`、`claude` 或 `opencode`。执行端须另行准备原生认证及无领域副作用的配置，不继承协调密钥。连接时准备缺少的适配器。
- DAG 与人工回复：`npm run test:e2e:human -- --quantity 4`。需已安装 Pi 和获准 DeepSeek 测试凭据；适配器在连接时准备。数量由测试客户端提供，不冒充真人回答。
- 真人模式：`npm run test:e2e:human -- --answer-file /absolute/private/path/quantity.txt`。使用新文件，等待旁边的 `.question.json` 出现，再写入答案。

完整前置检查、参数和断言见 [E2E 用例](../tests/e2e/)、[Pi 启动器](../scripts/run-pi-human-e2e.mjs)。Pi 启动器为两端共用获准测试密钥，创建独立原生配置，只启用 read；这不是 OS 沙箱或独立账户隔离。强杀或断电不能保证临时认证清理，需管理员核查。

运行证据保留在命令输出的私有目录，可能包含敏感内容；不自动删除或将一次成功推广为普遍支持。

### 0.1.0-rc.1 复验

2026-10-23，Linux x64、Node 24.15.0，使用已有获准 DeepSeek 测试凭据、`deepseek-flash` 协调员、隔离的只读 Pi 原生配置及连接时安装的 pi-acp 0.0.34。现有单节点和三节点用例各执行一次，均通过；没有修改交付断言或重试任务。

- 单节点约 16.3 秒：真实 ACP 交付包含标识和结果 323，一个会话、一轮执行，结果文件持久化通过。证据：`/tmp/agent-task-real-e2e-Igj91J`；Run：`5d4f2b74-eb41-402c-874e-441b1fb29d91`。
- 三节点约 36.5 秒：测试客户端提供数量 4，结果 1292；同一 Run 等待并接受回复，节点轮数 1 / 2 / 1，已接受的上游不重放，三个交付均保留标识和必需数值。证据：`/tmp/agent-task-real-e2e-oreA3j`；Run：`3e6dd91b-35a5-4038-945c-c9d402d2829f`。

两项测试均在提交任务后断开客户端，再由新连接观察结果。原始测试日志：`/tmp/agent-task-pi-human-6N0Zlj/test-1.log`。服务正常退出，临时原生认证和服务环境文件已清空，任务、会话、结果及验收摘要保留。临时目录可能被系统清理，长期证据需安全归档。

此证据覆盖当前任务契约和适配器准备路径。系统级自启、真实 Pi 宿主退出、模型执行中重启及 Codex、Claude、OpenCode 模型任务未验收；stdio 后台生命周期由本地进程测试覆盖。只读配置不是 OS 沙箱。

### 本机三节点验收

2026-10-22，Linux x64、Node 24.15.0，使用 DeepSeek 协调员和只读 Pi ACP 执行端，此前带 JSON 格式约束的用例运行 `npm run test:e2e:human -- --quantity 4` 一次通过，约 28 秒。数量由测试客户端提供，结果为 1292，不是真人输入。

该次运行验证了固定 DAG 的真实 ACP 交付、人工等待后续接同一运行、同一 ACP 会话内澄清，以及已接受上游不重放。未执行独立单节点用例、真人回答文件模式或重启/故障恢复。

复核业务库、durable 记录和 Pi 原生会话后，确认只有一个 TaskRun、三个 ACP 会话和两次上游文件读取。`audit` 的工具前说明与最终 JSON 被聚合进同一轮输出，导致额外一轮格式澄清；没有重复读取上游文件。

执行端启动时还留下了三次 `npm view @earendil-works/pi-coding-agent version` 记录，来源是 `pi-acp` 的版本检查，Pi 子进程的 `--offline` 未阻止该行为。日志没有查询结果，不能确认 registry 请求是否完成。服务和执行端原始 stderr、完整 ACP 通信未保留，不能据此证明整个执行栈无其他外部访问或诊断错误。

测试日志：`/tmp/agent-task-pi-human-H1OKJO/test-1.log`；Pi 原生会话及 npm 日志位于同目录的 `home/`；运行证据：`/tmp/agent-task-real-e2e-O9N9RY`。临时原生认证已清空。临时文件可能被系统清理，长期留存需管理员安全归档。

### 文本交付复验

同日移除用例中的 JSON 格式要求和固定澄清口令，以相同命令复验一次，约 26 秒。三个节点均输出普通文本或 Markdown，轮数为 1 / 2 / 1；没有为了格式追加澄清，计算结果仍为 1292。

但测试未通过：`audit` 原始输出包含必需标识，协调员接受的片段遗漏了该标识，验收理由仍声称包含它，运行被标为 `succeeded`。[三节点用例](../tests/e2e/human-dag.test.mjs)的内容断言拦住了这一遗漏，没有降低断言或重跑。此结果说明文本传递可执行，但不能把运行成功状态当成完整交付的证据；随后补充了摘录完整性指令，后续复验见下节。交付格式原则见[总体方案](design-proposal.md#架构选择)。

测试日志：`/tmp/agent-task-pi-human-K8huNN/test-1.log`；运行证据：`/tmp/agent-task-real-e2e-XgRgeo`。旧记录保留，临时原生认证已清空。

### 模块化重构后复验

2026-10-23，Linux x64、Node 24.15.0，使用 DeepSeek `deepseek-flash` 协调员、独立只读 Pi 配置和 pi-acp 0.0.34。两项现有用例各执行一次，均通过；没有修改用例断言或重复运行失败任务。

| 用例 | 结果与证据 |
| --- | --- |
| 三节点 DAG 与人工回复 | `npm run test:e2e:human -- --quantity 4`，约 31.4 秒。一个 TaskRun、三个 ACP 会话，节点轮数为 1 / 2 / 1。测试客户端提供数量 4，结果为 1292；等待约 2.1 秒后续接原 Run，在同一 `total` 会话内澄清，已接受的 `price` 记录保持不变。三个交付均保留必需标识，内容断言通过。 |
| 单节点 | 复用同一隔离配置的临时启动器运行现有 `deepseek-acp.test.mjs`，约 7.6 秒。一个 TaskRun、一个 ACP 会话、一轮执行，接受包含标识和结果 323 的交付，验证结果文件已持久化。 |

两次提交后均断开发起 MCP 客户端，再由新连接观察完成。服务均正常退出；本次创建的 Pi 原生认证与测试服务环境文件中的凭据已清空，历史和结果文件保留。

- DAG 日志：`/tmp/agent-task-pi-human-lpMTR3/test-1.log`；证据：`/tmp/agent-task-real-e2e-nwjC0U`；Run：`a42b672f-2f49-4c23-a169-98d25b2b2243`。
- 单节点日志：`/tmp/agent-task-pi-single-lseufC/test-1.log`；证据：`/tmp/agent-task-real-e2e-iV24X1`；Run：`7320bfda-3968-4305-acf6-10d7a9dae4e7`。
- 两个证据目录均保留 `acceptance-summary.json`、`record-audit.json`、业务 SQLite、运行快照及事件记录。临时目录可能被系统清理，长期留存需管理员安全归档。

同日以只读方式交叉核查业务库、durable 库、Pi 原生会话和结果文件。四个数据库的完整性与外键检查通过，业务记录通过严格持久化 schema 校验，最终快照与数据库一致。DAG 只有一个协调会话、两次提交（初始任务与数量回复）、11 次模型生成及 11 次工具调用；单节点为一个会话、一次提交、4 次模型生成及 4 次工具调用。所有调用均完成，无工具错误，协调员活动状态及收件箱为空。等待快照中下游仍为 pending，接受的 price 与最终记录完全一致。

四个节点的逐轮输入输出均与 Pi 原生日志一致，接受的交付全文与末轮输出及结果文件一致，标识和必需数值完整。DAG 原生日志只有两次 read，分别读取已接受的 price、total 文件；单节点没有工具调用。执行端启动另有 3 + 1 次 `npm view @earendil-works/pi-coding-agent version` 记录，来源为本机 pi-acp 的启动版本检查，Pi 的 `--offline` 不阻止该行为；日志没有查询结果，无法确认 registry 请求是否完成。两次服务退出码均为 0，临时认证及服务环境文件均为空对象。

本次通过覆盖了此前失败的交付标识断言，不证明模型始终完整摘录。数量来自声明的测试值，不是真人文件回复；未进行真实模型运行中的重启、故障恢复，或 Codex、Claude、OpenCode 成功路径验收。原生只读配置不是 OS 沙箱；原始 stderr 和完整 ACP 通信未保留，不能据此证明执行栈没有其他外部访问或诊断错误。

## 恢复保证的边界

早期 durable 研究曾在真实 SQLite/文件/SIGKILL 实验中观察到：外部文件写入后、结果提交前崩溃，恢复检查点再次执行了未做幂等保护的写入。这不是 ACP 恢复验收，而是检查点不保证外部副作用 exactly-once 的证据。

## 部署验证

Linux x64、Node 24.15.0 的本机记录：

- 专属目录安装、重复安装及带 token 的 MCP 健康检查通过。
- Pi 1.3.0 + pi-acp 0.0.34、codex-acp 2.2.2、OpenCode 1.19.3 在独立无认证 HOME 下均通过 initialize；没有发送 session/new 或模型任务，也未自动批准执行端。
- 首次安装实验遭遇磁盘满并损坏实验清单；未删除任务数据修复。修正后在新的专属目录完成上述部署复验，不构成业务运行时磁盘满恢复的证据。

证据目录：`/tmp/agent-task-deploy-verified`、`/tmp/agent-task-deploy-final`；工作空间：`/tmp/agent-task-deploy-workspace`；空认证 HOME：`/tmp/agent-task-deploy-native-home`。临时文件可能被系统清理，长期留存需管理员安全归档。


## npm 发布候选验证

### 0.1.0-rc.1（已发布）

本候选包含 stdio 共用后台、本机执行端发现与适配器准备、固定任务目录和按目录去重，以及调度周期调整。初始化须确认目录、端口、令牌及协调模型；普通启动不转换旧配置或业务数据。

2026-10-23，Linux x64、Node 24.15.0：锁定依赖重装、类型与依赖边界检查、49 项基础测试、两项真实模型测试、包清单门禁及独立安装验收均通过。真实模型范围见 [0.1.0-rc.1 复验](#010-rc1-复验)。

本地候选包安装报告：`/tmp/agent-task-npm-SxC74r/report.json`。使用独立 prefix 与原生 HOME，不依赖源码或 TypeScript；前台、Web/CLI 重启、stdio 自动启动、断开后后台健康和 stop 均通过。此次依赖下载使用 npm 镜像；发布后的默认安装须另以 npmjs 验证。报告仅把本机 Linux 记为通过，未执行 macOS 验收。发布完成以工作流结果和 registry 核对为准。

[GitHub 发布运行 40005739943](https://github.com/realqiyan/agent-task/actions/runs/40005739943)验证提交 `b6d138d`：Node 22.19.0/24.x 检查与 49 项测试、包门禁及 Linux 独立安装全部通过。GitHub OIDC 发布步骤成功，npm 随后提示包正在处理；即时 latest 检查仍读到旧版本，导致该运行最终失败。此失败发生在发布后的校验阶段。

后续匿名 npmjs 核对确认 **[@realqiyan/agent-task@0.1.0-rc.1](https://www.npmjs.com/package/@realqiyan/agent-task/v/0.1.0-rc.1)** 存在、`latest=0.1.0-rc.1`，并包含 GitHub provenance。未指定版本的默认全局安装及前台、Web/CLI、stdio 后台验收通过，报告：`/tmp/agent-task-npm-lTc9FG/report.json`。捕获输出未发现验证凭据，无模型或 ACP 工作。发布后校验现已加入有限等待和 `verify_only` 入口，后续复核无需再次上传同一版本。

[仅验证运行 40006683937](https://github.com/realqiyan/agent-task/actions/runs/40006683937)在提交 `3e8e7cd` 上全部通过：Node 22.19.0/24.x 检查和 49 项测试、打包、Linux 独立安装及 npmjs 默认安装复核。该运行跳过发布上传，未重复发布同一版本。

### 0.0.1-rc.3（历史证据）

2026-10-23，[GitHub 发布运行 39980466554](https://github.com/realqiyan/agent-task/actions/runs/39980466554)验证提交 `80b12de`：Node 22.19.0/24.x 类型与依赖检查、基础测试、包清单门禁，以及当前 Linux runner 的独立安装、启动、重启和认证检查均通过。当前发布门禁验证宿主环境；macOS 需在对应环境另行验收。安装报告明确标记其他平台未执行，PTY 用例在缺少终端能力时明确跳过。

发布作业使用 Node 24.21.0、npm 11.19.0 和 GitHub OIDC。包版本检查及 provenance 签名成功，但上传包的 npm PUT 请求返回 E404；发布后的默认安装验证因此未执行。随后 registry 查询未发现 `0.0.1-rc.3`，不能把生成 provenance 当作包已发布。

错误指向 npm 发布授权未生效，需核对该包的 Trusted Publisher 与仓库、工作流、Environment 和允许操作是否匹配。本机凭据读取 trust 设置返回 403，尚未确认具体缺失或不匹配项。GitHub 的 `npm` Environment 已限制为 master；工作流配置与 npm 端授权仍需分别核实，见[发布说明](release.md)。

本机检查与 42 项基础测试通过；独立空工具 PATH 下的真实测试进程确认 PTY 用例明确跳过。发布诊断及已去除下载 URL 查询参数的日志保留于 `/tmp/agent-task-rc3-final-d4tqqpt9`，临时目录可能被系统清理。

2026-10-23 后续匿名 registry 核对确认 `0.0.1-rc.3` 已存在，发布元数据包含 provenance；当时 `latest=0.0.1-rc.3`。上述失败运行是历史记录，不代表后续 registry 状态，也不能单凭元数据判定最终成功发布的操作渠道。

### 0.0.1-rc.2（历史证据）

2026-10-22，`realqiyan` 已将 **[@realqiyan/agent-task@0.0.1-rc.2](https://www.npmjs.com/package/@realqiyan/agent-task/v/0.0.1-rc.2)** 发布到 npmjs。匿名 registry 查询确认版本、发布账号、MIT 许可证及 `latest=0.0.1-rc.2`。本机直接发布了下述 CI 已验收的同一 tarball，没有重新构建，也没有 GitHub provenance。

- [Validate 运行 39829900075](https://github.com/realqiyan/agent-task/actions/runs/39829900075)在提交 `48549ea` 上全部通过：Node 22.19.0/24.x 类型检查、35 项基础测试、构建和包清单门禁。
- Ubuntu x64 与 macOS ARM64 的 Node 22.19.0 安装任务不 checkout 源码，使用同一 CI tarball 验证前台、Web/CLI 重启、启动目录/端口/token 变量名切换、认证健康检查。macOS 证据来自 hosted runner，不包括 Intel Mac、浏览器、休眠或用户注销场景。
- 发布后在 Linux x64、Node 24.15.0 以独立空 npm 配置匿名执行默认 `npm install -g @realqiyan/agent-task`，未指定版本或使用本地 tarball；固定使用 npmjs。前台、Web HTTP 配置、重启、健康检查均通过。

发布后安装报告：`/tmp/agent-task-npm-vseswA/report.json`。捕获输出未发现验证凭据，测试服务已移除。没有模型调用或 ACP 任务，不替代原生认证、权限或真实模型复验。临时目录可能被系统清理；包内文档是打包时快照，后续证据以本仓库为准。

### 0.0.1-rc.1（历史证据）

2026-10-22，`realqiyan` 已将 **[@realqiyan/agent-task@0.0.1-rc.1](https://www.npmjs.com/package/@realqiyan/agent-task/v/0.0.1-rc.1)** 发布到 npmjs。匿名 registry 查询确认版本、发布账号、MIT 许可证及 `latest=0.0.1-rc.1`。本次经授权从本机发布，没有 GitHub provenance。包内文档是打包时快照，后续证据以[仓库中的最新记录](https://github.com/realqiyan/agent-task/blob/master/docs/validation.md#npm-发布候选验证)为准。

npm 因包名保护拒绝了未加 scope 的 `agent-task`：名称被判定与 `agent-base` 过于相似。维护者已明确批准使用 `@realqiyan/agent-task`，安装命令随之改为 `npm install -g @realqiyan/agent-task`，CLI 仍为 `agent-task`。未关闭账号 2FA，也未上传本机凭据。

本次 Linux x64 证据：

- Node 22.19.0 和 24.15.0 的 TypeScript 检查、33 项基础测试及构建均通过；真实 PTY 用例验证 setup 的确认/取消、生成独立 token 和不输出凭据。
- [包清单门禁](../scripts/pack-release.mjs)通过：仅包含预编译 JS、Web 资源、明确列出的操作脚本、示例及公开文档；不包含源码、开发工具、凭据文件、运行数据库或本地记录。
- Node 22.19.0 先验收 scoped tarball，再从 npmjs 按 `npm install -g @realqiyan/agent-task` 的默认版本选择全局安装到独立临时 prefix；没有指定版本或使用本地 tarball 替代 registry 安装。禁用 lifecycle scripts，不使用项目源码或 TypeScript。前台启动、Web HTTP 配置保存/重启及带认证的健康检查均通过。
- tarball 预验收使用 npm 镜像依赖；发布后验收固定使用 `https://registry.npmjs.org/`，通过独立空 npm 配置文件进行匿名安装。复用 npm 下载缓存，没有复制项目 node_modules；不构成空缓存下载时延的保证。

Linux 22.19.0 的发布后 registry 安装报告：`/tmp/agent-task-npm-uM8FT5/report.json`；scoped tarball 预验收报告：`/tmp/agent-task-npm-Zgkggc/report.json`。临时目录包含验证专用随机凭据和空业务库，不上传或打包；报告仅含结果。Node 22.19.0 会输出内置 SQLite 的 experimental warning，这不是认证错误。

同日，[GitHub Validate 运行 39813423968](https://github.com/realqiyan/agent-task/actions/runs/39813423968)在提交 `461a1b0` 上全部通过：Node 22.19.0/24.x 检查、基础测试、构建及包清单门禁；Ubuntu x64 与 macOS ARM64 的 Node 22.19.0 安装任务均不 checkout 源码，使用 CI tarball 完成前台、Web HTTP 配置、认证健康检查验收。报告确认输出无验证凭据，没有模型或 ACP 工作。macOS 的证据来自 hosted runner，不包括 Intel Mac、交互式终端/浏览器、休眠或用户注销场景。

[受控发布工作流](../.github/workflows/publish.yml)已推送，但发布 Environment 审核和 npm 发布 secret 尚未配置，发布作业没有实际执行；本机首发和 Validate 通过不等于 Actions 发布已经验收。

操作和发布条件见[部署说明](deployment.md)、[发布说明](release.md)。此前源码安装的历史部署证据不替代本次 npm 候选包验收。

## 尚未验证

- 复杂任务的语义验收、并行分支与汇合、不同执行端之间的交付。
- 各执行端原生权限、认证续期、沙箱、技能/MCP 发现及文件访问；其他模型和 OpenAI 兼容端点的协议差异。
- 真实模型崩溃窗口、重复收费和预算行为；人工等待期间保留真实 ACP 会话的续答、并发回复、长时间等待及重启。
- 系统级强杀、断电、业务库磁盘满、真实任务的长期监督和原生权限。
- SDK 升级、历史数据转换，以及执行中修改计划等当前未开放能力。

实现和操作入口见[代码导航](technical-design.md)、[部署说明](deployment.md)。
