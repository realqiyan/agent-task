# 代码导航

本文指向职责入口和对应测试，不复述字段、默认值、状态枚举或内部流程。目标见[总体方案](design-proposal.md)，设计要求见[架构原则](architecture-guidelines.md)。

## 按问题查找

| 问题 | 代码入口 | 基础验证 |
| --- | --- | --- |
| 服务如何装配、启动和关闭 | [main.ts](../src/main.ts)、[launcher.ts](../src/launcher.ts)、[lock.ts](../src/lock.ts) | [restart.test.mjs](../tests/restart.test.mjs)、[service.test.mjs](../tests/service.test.mjs) |
| MCP 有哪些工具、输入是什么 | [mcp.ts](../src/mcp.ts)、[task-contract.ts](../src/task-contract.ts) | [service.test.mjs](../tests/service.test.mjs) |
| Task、Run、节点的数据与推进规则 | [task-model.ts](../src/task-model.ts)、[tasks.ts](../src/tasks.ts) | [tasks.test.mjs](../tests/tasks.test.mjs) |
| 人工等待、回复及续接 | [human-input.ts](../src/human-input.ts) | [human-input.test.mjs](../tests/human-input.test.mjs) |
| durable 工具与模型接入 | [coordinator.ts](../src/coordinator.ts)、[coordinator-provider.ts](../src/coordinator-provider.ts) | [coordinator-provider.test.mjs](../tests/coordinator-provider.test.mjs) |
| 持久数据校验和提交 | [task-storage.ts](../src/task-storage.ts)、[coordinator-storage.ts](../src/coordinator-storage.ts) | [durable.test.mjs](../tests/durable.test.mjs)、[tasks.test.mjs](../tests/tasks.test.mjs) |
| ACP、worker 和进程关闭 | [acp.ts](../src/acp.ts)、[node-execution.ts](../src/node-execution.ts)、[worker.ts](../src/worker.ts) | [execution.test.mjs](../tests/execution.test.mjs)、[tasks.test.mjs](../tests/tasks.test.mjs) |
| 审批、环境与结果文件范围 | [permissions.ts](../src/permissions.ts)、[executor-runtime.ts](../src/executor-runtime.ts)、[results.ts](../src/results.ts) | [policy.test.mjs](../tests/policy.test.mjs)、[results.test.mjs](../tests/results.test.mjs) |
| 配置、管理员注册和工作空间 | [config.ts](../src/config.ts)、[model.ts](../src/model.ts)、[settings.ts](../src/settings.ts)、[workspace.ts](../src/workspace.ts) | [config-preflight.test.mjs](../tests/config-preflight.test.mjs)、[tasks.test.mjs](../tests/tasks.test.mjs) |
| 控制台 HTTP 边界与页面 | [web.ts](../src/web.ts)、[http-auth.ts](../src/http-auth.ts)、[页面模块](../src/web/) | [web.test.mjs](../tests/web.test.mjs) |
| 配置和凭据的校验、保存与下次启动 | [settings.ts](../src/settings.ts)、[settings-management.ts](../src/settings-management.ts)、[settings-contract.ts](../src/settings-contract.ts)、[startup.ts](../src/startup.ts)、[private-files.ts](../src/private-files.ts)、[environment.ts](../src/environment.ts) | [settings.test.mjs](../tests/settings.test.mjs)、[web.test.mjs](../tests/web.test.mjs) |
| CLI 管理命令与本机认证传输 | [cli.ts](../src/cli.ts)、[admin-client.ts](../src/admin-client.ts) | [web.test.mjs](../tests/web.test.mjs) |
| npm 命令、安装与启动环境 | [agent-task.mjs](../bin/agent-task.mjs)、[setup-wizard.mjs](../scripts/setup-wizard.mjs)、[setup.mjs](../scripts/setup.mjs)、[install-lib.mjs](../scripts/install-lib.mjs)、[service-runner.mjs](../scripts/service-runner.mjs) | [install.test.mjs](../tests/install.test.mjs)、[setup.test.mjs](../tests/setup.test.mjs)、[verify-install.mjs](../scripts/verify-install.mjs) |
| npm 包清单与发布门禁 | [package.json](../package.json)、[pack-release.mjs](../scripts/pack-release.mjs)、[工作流](../.github/workflows/) | [发布说明](release.md) |

配置示例见 [config.example.json](../config.example.json)，命令和依赖版本见 [package.json](../package.json)。测试只说明各自验证的风险，不能把失败进程或结构化状态测试当成真实模型成功执行。

## 当前架构差距

- `tasks.ts` 同时承担业务状态、时间触发和运行监督，尚未完成目标职责拆分。
- `model.ts` 混合类型与 schema；持久 schema 复用输入契约；`results.ts` 混合路径授权与文件操作。
- 尚无依赖边界检查器。后续按实际功能修改收敛，不为分层增加空壳。

## 集成与验收入口

- [probe-agent.mjs](../scripts/probe-agent.mjs)：只做 ACP initialize。
- [单节点用例](../tests/e2e/deepseek-acp.test.mjs)、[人工回复 DAG 用例](../tests/e2e/human-dag.test.mjs)：真实模型验收。
- [E2E harness](../tests/e2e/harness.mjs)、[Pi 验收启动器](../scripts/run-pi-human-e2e.mjs)：环境准备、服务生命周期和证据保存。

操作前置条件和已验证范围见[部署说明](deployment.md)、[验证说明](validation.md)。握手、任务成功和权限隔离是不同证据。
