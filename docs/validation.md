# 验证导航与证据边界

**模块化重构后，单节点与三节点 DAG 的真实模型 E2E 均一次通过，详见下文复验记录。** 项目不宣称生产可用或外部副作用 exactly-once。

## 本地验证

```bash
npm run check
npm test
git diff --check
```

各职责的测试入口见[代码导航](technical-design.md)。基础测试使用真实本地文件、SQLite、进程和 SDK，不调用外部模型，不使用假模型或模拟 provider。失败进程和 no_model 只证明失败路径；结构化状态用例不证明模型语义判断。`check` 同时执行 TypeScript 与[依赖边界检查](../scripts/check-boundaries.mjs)，后者检查模块依赖、循环、SDK 位置和 Run 写入口；它不证明运行时权限或模型语义。

2026-10-23，Linux x64、Node 24.15.0：模块化重构通过类型与依赖边界检查、42 项基础测试和本地包清单门禁。关键新增证据见 [存储测试](../tests/task-storage.test.mjs)与[任务测试](../tests/tasks.test.mjs)：严格记录拒绝而不修复、事务失败回滚触发游标、派发提交先于真实进程执行，以及关闭、取消与迟到回调。临时源码副本中的越层导入、循环依赖和绕过 Run 写入口均被检查器拒绝。

本地测试不证明真实模型或 ACP 成功路径；后续真实验收见[模块化重构后复验](#模块化重构后复验)。本次未重新执行跨平台安装验收。

## 控制台验证

[Web/CLI 用例](../tests/web.test.mjs)使用真实本机服务进程验证两端查询与保存的互通、旧草稿拒绝、执行端授权清除、凭据引用保护、离线失败不写文件，以及独立管理员认证、Host/Origin/请求类型边界、有限任务写入、密钥不回显或进入日志。也验证重启后的配置差异和目录切换不复制历史。[重启用例](../tests/restart.test.mjs)验证前台 CLI、固定端口进程更换、绑定失败不能报成功，以及持久化的不确定派发在重复重启后仍被阻断。实际任务记录来自业务服务，不使用假模型输出。

[配置用例](../tests/settings.test.mjs)验证私有文件边界、旧编辑拒绝、显式凭据环境、端点与密钥引用分离、服务令牌别名不能作为模型凭据、失败时保留文件，以及关闭后拒绝操作。这些用例不构成断电、磁盘满或目录同步失败窗口的完整证据。

尚未完成真实浏览器交互、CSP 执行和跨浏览器缓存/自动填充验收；CLI 的编辑器交互和隐藏终端凭据输入也未做终端验收，凭据测试使用 stdin。需在浏览器核对：不可信任务文本不执行脚本或加载外链；离开、刷新和退出后无令牌残留；配置草稿不被轮询覆盖；密钥保存与配置保存的提示明确。HTTP 头检查不能替代这些验证，也不证明模型认证或 ACP 执行成功。

### 启动与注册调整

Web/CLI 重启证据见下文 [rc.2 发布验收](#001-rc2当前-latest)。四类执行端的固定命令映射和凭据过滤有本地契约测试；Claude ACP 新增注册目标没有真实握手、认证或任务证据。其他执行端的历史结果也不能代替新原生环境和审批策略下的真实复验。

## 真实模型验收入口

仅在获准环境显式运行，会产生模型费用；不使用个人凭据或真实交易：

- 单节点：`npm run test:e2e`。需安全注入 `DEEPSEEK_API_KEY`，并将 `AGENT_TASK_E2E_EXECUTOR` 指向已审核的 ACP profile。执行端须另行准备原生认证及无领域副作用的配置，不继承协调密钥。
- DAG 与人工回复：`npm run test:e2e:human -- --quantity 4`。需已安装 Pi、pi-acp 和获准 DeepSeek 测试凭据；数量由测试客户端提供，不冒充真人回答。
- 真人模式：`npm run test:e2e:human -- --answer-file /absolute/private/path/quantity.txt`。使用新文件，等待旁边的 `.question.json` 出现，再写入答案。

完整前置检查、参数和断言见 [E2E 用例](../tests/e2e/)、[Pi 启动器](../scripts/run-pi-human-e2e.mjs)。Pi 启动器为两端共用获准测试密钥，创建独立原生配置，只启用 read；这不是 OS 沙箱或独立账户隔离。强杀或断电不能保证临时认证清理，需管理员核查。

运行证据保留在命令输出的私有目录，可能包含敏感内容；不自动删除或将一次成功推广为普遍支持。

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

### 0.0.1-rc.2（当前 latest）

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
