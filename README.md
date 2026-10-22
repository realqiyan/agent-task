# Agent Task

独立的智能任务服务：**MCP 管理任务，pi durable 推进调用方定义的 DAG，ACP 执行端完成领域工作**。协调员负责澄清和交付验收，不拆解任务或修改计划。

当前处于调研阶段，不宣称生产可用，不用于无人值守交易。已有验证结果及适用范围见[验证说明](docs/validation.md)。

## 从哪里开始

| 目的 | 入口 |
| --- | --- |
| 安装、认证、后台运行、卸载 | [部署说明](docs/deployment.md) |
| 本机控制台、配置保存与手动重启 | [控制台说明](docs/web-console.md) |
| 理解产品目标和架构选择 | [总体方案](docs/design-proposal.md) |
| 查找实现与对应测试 | [代码导航](docs/technical-design.md) |
| 查询测试命令、真实验收及缺口 | [验证说明](docs/validation.md) |
| 修改项目 | [开发指南](AGENTS.md)、[架构原则](docs/architecture-guidelines.md) |

文档保留用途、约束和证据；字段、默认值、状态转换及内部流程以代码为准。

## 使用入口

首次安装先阅读部署说明。安装脚本不会替用户登录或批准执行端：

```bash
node scripts/setup.mjs --help
```

服务启动、服务 token 已放入环境后，通过 MCP 查询当前工具及输入 schema：

```bash
node scripts/mcp-call.mjs --list
node scripts/mcp-call.mjs service_status
```

任务由 `task_create` 提交固定 DAG，每个节点选择已注册执行端。具体契约见 [task-contract.ts](src/task-contract.ts)，管理工具见 [mcp.ts](src/mcp.ts)。Prompt、人工回复和工作空间选择都不授予工具权限。
