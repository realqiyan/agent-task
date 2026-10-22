# 验证导航与证据边界

**三节点 DAG 已有真实模型运行证据；最新文本交付验收未通过，原因见下文。** 项目不宣称生产可用或外部副作用 exactly-once。

## 本地验证

```bash
npm run check
npm test
git diff --check
```

各职责的测试入口见[代码导航](technical-design.md)。基础测试使用真实本地文件、SQLite、进程和 SDK，不调用外部模型，不使用假模型或模拟 provider。失败进程和 no_model 只证明失败路径；结构化状态用例不证明模型语义判断。check 仅检查 TypeScript，不检查依赖边界。

## 控制台验证

[HTTP 用例](../tests/web.test.mjs)使用真实本机服务进程验证独立管理员认证、Host/Origin/请求类型边界、有限任务写入、密钥不回显或进入日志，以及保存前后和重启后的配置差异。实际任务记录来自业务服务，不使用假模型输出。

[配置用例](../tests/settings.test.mjs)验证私有文件边界、旧编辑拒绝、显式凭据环境、端点与密钥引用分离、失败时保留文件，以及关闭后拒绝操作。这些用例不构成断电、磁盘满或目录同步失败窗口的完整证据。

尚未完成真实浏览器交互、CSP 执行和跨浏览器缓存/自动填充验收。需在浏览器核对：不可信任务文本不执行脚本或加载外链；离开、刷新和退出后无令牌残留；配置草稿不被轮询覆盖；密钥保存与配置保存的提示明确。HTTP 头检查不能替代这些验证，也不证明模型认证或 ACP 执行成功。

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

但测试未通过：`audit` 原始输出包含必需标识，协调员接受的片段遗漏了该标识，验收理由仍声称包含它，运行被标为 `succeeded`。[三节点用例](../tests/e2e/human-dag.test.mjs)的内容断言拦住了这一遗漏，没有降低断言或重跑。此结果说明文本传递可执行，但不能把运行成功状态当成完整交付的证据；已补充摘录完整性指令，尚待真实模型复验。交付格式原则见[总体方案](design-proposal.md#架构选择)。

测试日志：`/tmp/agent-task-pi-human-K8huNN/test-1.log`；运行证据：`/tmp/agent-task-real-e2e-XgRgeo`。旧记录保留，临时原生认证已清空。

## 恢复保证的边界

早期 durable 研究曾在真实 SQLite/文件/SIGKILL 实验中观察到：外部文件写入后、结果提交前崩溃，恢复检查点再次执行了未做幂等保护的写入。这不是 ACP 恢复验收，而是检查点不保证外部副作用 exactly-once 的证据。

## 部署验证

Linux x64、Node 24.15.0 的本机记录：

- 专属目录安装、重复安装、真实 systemd 用户服务及带 token 的 MCP 健康检查通过。
- Pi 1.3.0 + pi-acp 0.0.34、codex-acp 2.2.2、OpenCode 1.19.3 在独立无认证 HOME 下均通过 initialize；没有发送 session/new 或模型任务，也未自动批准执行端。
- 经 MCP 保存并暂停未来任务，两次卸载后保留任务记录、配置、环境、工作空间和未入清单文件；服务已移除。
- 首次安装实验遭遇磁盘满并损坏实验清单；未删除任务数据修复。修正后在新的专属目录完成上述部署复验，不构成业务运行时磁盘满恢复的证据。

证据目录：`/tmp/agent-task-deploy-verified`、`/tmp/agent-task-deploy-final`；工作空间：`/tmp/agent-task-deploy-workspace`；空认证 HOME：`/tmp/agent-task-deploy-native-home`。临时文件可能被系统清理，长期留存需管理员安全归档。

macOS 已有 launchd 实现，但没有安装、后台运行、任务执行或卸载的实机证据。待验收重点是原生认证与权限、关闭终端后的任务存续、取消及进程清理、重复卸载的数据保留；模板生成和 Linux 测试不能替代。

## npm 发布候选验证

2026-10-22，`realqiyan` 已将 **[@realqiyan/agent-task@0.0.1-rc.1](https://www.npmjs.com/package/@realqiyan/agent-task/v/0.0.1-rc.1)** 发布到 npmjs。匿名 registry 查询确认版本、发布账号、MIT 许可证及 `latest=0.0.1-rc.1`。本次经授权从本机发布，没有 GitHub provenance。包内文档是打包时快照，后续证据以[仓库中的最新记录](https://github.com/realqiyan/agent-task/blob/master/docs/validation.md#npm-发布候选验证)为准。

npm 因包名保护拒绝了未加 scope 的 `agent-task`：名称被判定与 `agent-base` 过于相似。维护者已明确批准使用 `@realqiyan/agent-task`，安装命令随之改为 `npm install -g @realqiyan/agent-task`，CLI 仍为 `agent-task`。未关闭账号 2FA，也未上传本机凭据。

本次 Linux x64 证据：

- Node 22.19.0 和 24.15.0 的 TypeScript 检查、33 项基础测试及构建均通过；真实 PTY 用例验证 setup 的确认/取消、生成独立 token 和不输出凭据。
- [包清单门禁](../scripts/pack-release.mjs)通过：仅包含预编译 JS、Web 资源、明确列出的操作脚本、示例及公开文档；不包含源码、开发工具、凭据文件、运行数据库或本地记录。
- Node 22.19.0 先验收 scoped tarball，再从 npmjs 按 `npm install -g @realqiyan/agent-task` 的默认版本选择全局安装到独立临时 prefix；没有指定版本或使用本地 tarball 替代 registry 安装。禁用 lifecycle scripts，不使用项目源码或 TypeScript。前台启动、Web HTTP 配置保存/重启、真实 systemd 用户服务及带认证的健康检查均通过。
- 重复 setup 保留 token；重复卸载保留配置、凭据、任务库和工作空间。显式注册的执行端仍未授权，没有 ACP 工作或模型调用。捕获的命令、前台输出及用户服务日志未出现验证用凭据，测试服务已移除。
- tarball 预验收使用 npm 镜像依赖；发布后验收固定使用 `https://registry.npmjs.org/`，通过独立空 npm 配置文件进行匿名安装。复用 npm 下载缓存，没有复制项目 node_modules；不构成空缓存下载时延的保证。

Linux 22.19.0 的发布后 registry 安装报告：`/tmp/agent-task-npm-uM8FT5/report.json`；scoped tarball 预验收报告：`/tmp/agent-task-npm-Zgkggc/report.json`。临时目录包含验证专用随机凭据和空业务库，不上传或打包；报告仅含结果。Node 22.19.0 会输出内置 SQLite 的 experimental warning，这不是认证错误。

已添加 [CI](../.github/workflows/ci.yml) 和[受控发布工作流](../.github/workflows/publish.yml)。GitHub CI、macOS LaunchAgent 及真实浏览器交互尚待实际运行证据；工作流定义不能代替验收。发布 Environment 审核和 npm 发布 secret 尚未配置，发布工作流没有实际执行；本机首发不等于 Actions 发布已经验收。

操作和发布条件见[部署说明](deployment.md)、[发布说明](release.md)。此前源码安装的历史部署证据不替代本次 npm 候选包验收。

## 尚未验证

- 独立单节点用例在当前接口上的真实模型复验、复杂任务的语义验收、并行分支与汇合、不同执行端之间的交付。
- 各执行端原生权限、认证续期、沙箱、技能/MCP 发现及文件访问；其他模型和 OpenAI 兼容端点的协议差异。
- 真实模型崩溃窗口、重复收费和预算行为；人工等待期间保留真实 ACP 会话的续答、并发回复、长时间等待及重启。
- 系统级强杀、断电、业务库磁盘满、Linux 注销/重启与 cgroup 清理，以及 macOS 部署和监督。
- SDK 升级、历史数据转换，以及执行中修改计划等当前未开放能力。

实现和操作入口见[代码导航](technical-design.md)、[部署说明](deployment.md)。
