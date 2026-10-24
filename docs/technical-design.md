# 代码导航

本文指向职责入口、依赖边界和资源所有者，不复述字段、默认值或状态枚举。目标见[总体方案](design-proposal.md)，设计要求见[架构原则](architecture-guidelines.md)。

## 模块与公开能力

按业务能力组织 `tasks`、`executors`、`configuration` 和 `results`。各模块用普通数据模型表达内部数据，服务通过构造参数接收依赖。没有服务定位器或统一转发门面。协议入口只获得[公开业务能力](../src/protocol/services.ts)。

| 责任 | 实现入口 | 基础验证 |
| --- | --- | --- |
| 任务定义、执行端快照、未来触发控制 | [TaskDefinitions](../src/tasks/definitions.ts)、[图校验](../src/tasks/graph.ts)、[时间规则](../src/tasks/schedule.ts)、[Cron 解析](../src/tasks/cron.ts) | [tasks.test.mjs](../tests/tasks.test.mjs)、[schedule.test.mjs](../tests/schedule.test.mjs) |
| Run 与节点状态的业务修改入口、派发与提交顺序 | [TaskRuns](../src/tasks/runs.ts)、[数据模型](../src/tasks/model.ts)、[窄能力契约](../src/tasks/ports.ts) | [tasks.test.mjs](../tests/tasks.test.mjs)、[task-storage.test.mjs](../tests/task-storage.test.mjs) |
| 时钟、协调会话监督、取消与收尾 | [RunSupervisor](../src/tasks/supervisor.ts)、[NodeSessions](../src/tasks/sessions.ts) | [tasks.test.mjs](../tests/tasks.test.mjs)、[restart.test.mjs](../tests/restart.test.mjs) |
| 人工事实等待与回复 | [纯状态规则](../src/tasks/human-input.ts)、[TaskRuns](../src/tasks/runs.ts) | [human-input.test.mjs](../tests/human-input.test.mjs) |
| 本机执行端目录、准入比较、凭据隔离 | [ExecutorRegistry](../src/executors/registry.ts)、[发现与安装](../src/integrations/acp/discovery.ts)、[环境过滤](../src/executors/environment.ts)、[审批策略](../src/executors/permissions.ts) | [executors.test.mjs](../tests/executors.test.mjs)、[policy.test.mjs](../tests/policy.test.mjs)、[config-preflight.test.mjs](../tests/config-preflight.test.mjs) |
| 配置与凭据编辑、发布顺序、影响预览 | [Settings](../src/configuration/settings.ts)、[配置规则](../src/configuration/policy.ts)、[预览组合](../src/configuration/management.ts) | [settings.test.mjs](../tests/settings.test.mjs)、[web.test.mjs](../tests/web.test.mjs) |
| 请求规范化、内部数据与严格记录校验 | [任务请求](../src/protocol/task-contract.ts)、[配置请求](../src/protocol/settings-contract.ts)、[内部数据校验](../src/tasks/validation.ts)、[持久记录](../src/tasks/storage/records.ts) | [task-storage.test.mjs](../tests/task-storage.test.mjs) |
| 持久读写与事务 | [TaskStore](../src/tasks/storage/store.ts)、[配置文件](../src/configuration/files.ts)、[私有文件操作](../src/infrastructure/private-files.ts) | [task-storage.test.mjs](../tests/task-storage.test.mjs)、[settings.test.mjs](../tests/settings.test.mjs) |
| 结果文件授权与文件持久化 | [Results](../src/results/service.ts)、[文件能力](../src/results/ports.ts)、[文件实现](../src/results/files.ts) | [results.test.mjs](../tests/results.test.mjs) |
| ACP、worker 与进程协议 | [ACP 连接](../src/integrations/acp/connection.ts)、[worker 监督](../src/integrations/acp/execution.ts)、[worker 入口](../src/integrations/acp/worker.ts)、[命令映射](../src/integrations/acp/runtime.ts) | [execution.test.mjs](../tests/execution.test.mjs)、[tasks.test.mjs](../tests/tasks.test.mjs) |
| durable 工具、模型与会话存储 | [协调适配](../src/integrations/coordinator/coordinator.ts)、[provider](../src/integrations/coordinator/provider.ts)、[存储](../src/integrations/coordinator/storage.ts) | [coordinator-provider.test.mjs](../tests/coordinator-provider.test.mjs)、[durable.test.mjs](../tests/durable.test.mjs) |
| MCP、HTTP 与 Web | [MCP 工具](../src/protocol/mcp.ts)、[输出契约](../src/protocol/mcp-contract.ts)、[stdio 接入](../src/protocol/stdio.ts)、[HTTP 服务](../src/protocol/http/server.ts)、[Web 路由](../src/protocol/http/web.ts)、[页面](../src/web/) | [service.test.mjs](../tests/service.test.mjs)、[web.test.mjs](../tests/web.test.mjs) |
| CLI 与本机控制协议 | [CLI](../src/protocol/cli/commands.ts)、[管理客户端](../src/protocol/cli/admin-client.ts)、[启动器客户端](../src/integrations/local-service/control.ts) | [web.test.mjs](../tests/web.test.mjs)、[restart.test.mjs](../tests/restart.test.mjs) |
| 装配、启动、关闭与重启 | [main](../src/application/main.ts)、[MCP 后台启动](../src/application/mcp-entry.ts)、[业务运行实例](../src/application/task-runtime.ts)、[launcher](../src/application/launcher.ts)、[启动准备](../src/application/startup.ts) | [stdio.test.mjs](../tests/stdio.test.mjs)、[restart.test.mjs](../tests/restart.test.mjs)、[service.test.mjs](../tests/service.test.mjs) |
| 安装与发布 | [命令入口](../bin/agent-task.mjs)、[setup](../scripts/setup.mjs)、[安装库](../scripts/install-lib.mjs)、[包门禁](../scripts/pack-release.mjs)、[发布准入](../scripts/check-release.mjs)、[工作流](../.github/workflows/) | [install.test.mjs](../tests/install.test.mjs)、[setup.test.mjs](../tests/setup.test.mjs)、[release.test.mjs](../tests/release.test.mjs)、[发布说明](release.md) |

宿主安装资产位于 [plugin](../plugin/)，包含原生插件清单、MCP 连接声明、`using-agent-task` 使用引导和只读启动检查，不进入服务运行时依赖图。检查通过 CLI 摘要复用 setup 校验；[检查测试](../tests/host-preflight.test.mjs)验证无写入、故障分类和凭据不回显。[独立包门禁](../scripts/pack-plugin.mjs)不构建或安装服务；[接入测试](../tests/host-integrations.test.mjs)验证无服务依赖的离线安装、清单契约和真实 stdio 工具调用；宿主原生流程见[接入说明](host-integrations.md)。

## 依赖与一致性边界

依赖方向由[架构原则](architecture-guidelines.md#职责与依赖)定义，[依赖检查器](../scripts/check-boundaries.mjs)随 `npm run check` 执行。模块分类、允许引用及 Run 写入口检查以该脚本为准；新增文件须明确归属。

[TaskRuns](../src/tasks/runs.ts)是 Run 状态的唯一业务写入口。状态转换与提交顺序在该服务维护，事务实现在 [TaskStore](../src/tasks/storage/store.ts)。[持久记录校验](../src/tasks/storage/records.ts)严格拒绝缺失或非规范记录，不使用请求默认值修复；管理员提供的下次启动配置另用[配置请求契约](../src/protocol/settings-contract.ts)解析。

检查器约束源码依赖，不是权限沙箱，也不证明运行时副作用安全。真实模型和执行端的证据边界见[验证说明](validation.md)。

## 资源所有权

| 资源 | 创建与关闭责任 |
| --- | --- |
| 数据目录排他锁 | 应用入口取得，在业务与网络资源收尾后释放 |
| 业务 SQLite 与业务服务 | `createTaskRuntime` 创建；关闭先停止业务入口与监督，再关闭存储 |
| 协调调用、时钟与取消信号 | `RunSupervisor` 创建并等待其结束；`TaskRuns` 不持有进程或 SDK 对象 |
| 节点会话句柄、超时与等待期间的会话 | `NodeSessions` 持有；关闭调用共用同一个完成结果 |
| 适配器安装进程与安装锁 | `ExecutorRegistry` 管理安装准入与取消，`LocalExecutors` 持有进程和锁；发布后保留旧组件，关闭时等待安装退出 |
| stdio 接入与共享后台 | `mcp-entry` 连接或启动独立 launcher；stdio 关闭只释放本连接，后台由显式 stop 或服务管理器关闭 |
| worker 与 ACP 进程组 | ACP 接入创建与回收；监督器只持有窄会话能力 |
| durable storage 与 Harness | 每次协调调用创建；打开失败关闭存储，成功后由 Harness 关闭其存储 |
| HTTP listener 与 MCP transport/server | `HttpServer` 持有；请求断开只释放请求资源，应用关闭停止新请求并收尾 |
| 配置和结果文件描述符 | 文件适配器在单次操作内打开，并在 `finally` 中关闭 |

关闭接口幂等。关闭开始后拒绝新的业务操作；未验收的外部执行被中断并阻断后续自动派发。进程组回收与文件事务不能证明无孤儿进程、断电恢复或外部副作用 exactly-once。

## 集成与验收入口

- [probe-agent.mjs](../scripts/probe-agent.mjs)：只做 ACP initialize。
- [单节点用例](../tests/e2e/deepseek-acp.test.mjs)、[人工回复 DAG 用例](../tests/e2e/human-dag.test.mjs)：真实模型验收。
- [E2E harness](../tests/e2e/harness.mjs)、[Pi 启动器](../scripts/run-pi-human-e2e.mjs)：环境准备、服务生命周期和证据保存。

配置示例见 [config.example.json](../config.example.json)，命令和依赖版本见 [package.json](../package.json)。操作前置条件与已验证范围见[部署说明](deployment.md)、[验证说明](validation.md)。
