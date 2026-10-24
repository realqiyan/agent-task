# Agent Task

独立的智能任务服务：**MCP 管理任务，pi durable 推进调用方定义的 DAG，ACP 执行端完成领域工作**。协调员负责澄清和交付验收，不拆解任务或修改计划。

当前处于调研阶段，不宣称生产可用，不用于无人值守交易。已有验证结果及适用范围见[验证说明](docs/validation.md)。

## 从哪里开始

| 目的 | 入口 |
| --- | --- |
| 安装、配置、运行 | [部署说明](docs/deployment.md) |
| 本机控制台、配置保存与 Web/CLI 重启 | [控制台说明](docs/web-console.md) |
| 命令行配置、凭据和任务管理 | [CLI 说明](docs/cli.md) |
| 理解产品目标和架构选择 | [总体方案](docs/design-proposal.md) |
| 查询项目术语 | [词汇表](CONTEXT.md) |
| 查找实现与对应测试 | [代码导航](docs/technical-design.md) |
| 查询测试命令、真实验收及缺口 | [验证说明](docs/validation.md) |
| npm 候选验收、GitHub Actions 与受控发布 | [发布说明](docs/release.md) |
| 修改项目 | [开发指南](AGENTS.md)、[架构原则](docs/architecture-guidelines.md) |

文档保留用途、约束和证据；字段、默认值、状态转换及内部流程以代码为准。

## 使用入口

Linux/macOS，Node.js **22.19+**。以下为当前源码的使用入口；安装包自带运行产物。实际发布状态及平台验收范围见[发布证据](docs/validation.md#npm-发布候选验证)。

```bash
npm install -g @realqiyan/agent-task
agent-task setup
# 在 MCP 宿主中配置 command: agent-task，args: [mcp]
# 连接后可查询后台状态：
agent-task status
# 应用已保存配置并确认新实例可用：
agent-task restart
```

setup 确认本机配置；MCP 连接自动启动或复用独立后台，宿主退出后后台继续运行。首次使用须安装至少一种原生执行 CLI 并准备其认证。完整接入配置、执行端准备与服务管理见[部署说明](docs/deployment.md)。

任务由 `task_create` 提交固定 DAG，每个节点选择已就绪执行端。显式工作目录优先，否则 stdio 入口补入自己的启动目录；直接 HTTP 调用必须提供目录。具体契约见 [task-contract.ts](src/protocol/task-contract.ts)，管理工具见 [mcp.ts](src/protocol/mcp.ts)。Prompt、人工回复和工作空间选择都不授予工具权限。

## CLI 命令索引

完整命令与参数使用 `agent-task --help`、`agent-task <命令> --help` 查询，不在文档中维护副本。

- 安装与运行：`setup`、`mcp`、`start`、`stop`、`restart`、`status`，见[部署说明](docs/deployment.md)。
- 配置与凭据：`config`、`executor`、`coordinator`、`credential`；任务与运行：`task`、`run`，见 [CLI 说明](docs/cli.md)。

## 许可证

[MIT](LICENSE)，Copyright (c) 2026 realqiyan。依赖及执行端仍遵循各自许可证。
