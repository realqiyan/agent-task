# Agent Task

独立的智能任务服务：**MCP 管理任务，pi durable 推进调用方定义的 DAG，ACP 执行端完成领域工作**。协调员负责澄清和交付验收，不拆解任务或修改计划。

当前处于调研阶段，不宣称生产可用，不用于无人值守交易。已有验证结果及适用范围见[验证说明](docs/validation.md)。

## 从哪里开始

| 目的 | 入口 |
| --- | --- |
| 安装、认证、后台运行、卸载 | [部署说明](docs/deployment.md) |
| 本机控制台、配置保存与 Web/CLI 重启 | [控制台说明](docs/web-console.md) |
| 理解产品目标和架构选择 | [总体方案](docs/design-proposal.md) |
| 查找实现与对应测试 | [代码导航](docs/technical-design.md) |
| 查询测试命令、真实验收及缺口 | [验证说明](docs/validation.md) |
| npm 候选验收、GitHub Actions 与受控发布 | [发布说明](docs/release.md) |
| 修改项目 | [开发指南](AGENTS.md)、[架构原则](docs/architecture-guidelines.md) |

文档保留用途、约束和证据；字段、默认值、状态转换及内部流程以代码为准。

## 使用入口

Linux/macOS，Node.js **22.19+**。安装包自带运行产物，无需克隆或编译。`latest` 指向的已发布版本及平台验收范围见[发布证据](docs/validation.md#npm-发布候选验证)。

```bash
npm install -g @realqiyan/agent-task
agent-task setup
agent-task start
# 另一个终端进行带认证的健康检查：
agent-task status
# 应用已保存配置并确认新实例可用：
agent-task restart
```

npm 包名为 `@realqiyan/agent-task`，安装后的命令仍为 `agent-task`。setup 提供交互配置；启动后可使用本机 Web 控制台。先停止前台实例，再用 `agent-task service install` 安装并启动用户后台服务。安装器不会替用户登录或批准执行端；详细操作见[部署说明](docs/deployment.md)。

MCP 客户端使用独立服务 token。源码开发辅助命令（凭据须安全注入环境，不写命令行）：

```bash
node scripts/mcp-call.mjs --list
node scripts/mcp-call.mjs service_status
```

任务由 `task_create` 提交固定 DAG，每个节点选择已注册执行端。具体契约见 [task-contract.ts](src/task-contract.ts)，管理工具见 [mcp.ts](src/mcp.ts)。Prompt、人工回复和工作空间选择都不授予工具权限。

## 许可证

[MIT](LICENSE)，Copyright (c) 2026 realqiyan。依赖及执行端仍遵循各自许可证。
