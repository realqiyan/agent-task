# Task Conductor

[English](README.md) | 简体中文

独立的智能任务服务：**MCP 管理任务，pi durable 推进调用方定义的 DAG，ACP 执行端完成领域工作**。协调者凭判断与记忆对整体目标负责，服务保障准入、账本与收尾；不拆解任务或修改计划，也不由程序替代业务判断。

当前处于调研阶段，不宣称生产可用，不用于无人值守交易。已有验证结果及适用范围见[验证说明](docs/validation.md)。

## 从哪里开始

| 目的 | 入口 |
| --- | --- |
| 安装、配置、运行 | [部署说明](docs/deployment.md) |
| 数据格式检查与离线迁移 | [升级说明](docs/upgrades.md) |
| Pi、Claude Code、Codex 接入包与 using-task-conductor 使用引导 | [宿主接入](docs/host-integrations.md) |
| 本机控制台、配置保存与 Web/CLI 重启 | [控制台说明](docs/web-console.md) |
| 命令行配置、凭据和任务管理 | [CLI 说明](docs/cli.md) |
| 理解产品目标和架构选择 | [总体方案](docs/design-proposal.md) |
| Pi 原会话自动通知、身份与可靠补读 | [通知设计与使用](docs/notifications.md) |
| Task 持续对话、Document 记忆与补充交付 | [会话设计](docs/task-conversation-plan.md) |
| 查询项目术语 | [词汇表](CONTEXT.md) |
| 查找实现与对应测试 | [代码导航](docs/technical-design.md) |
| 查询测试命令、真实验收及缺口 | [验证说明](docs/validation.md) |
| npm 候选验收、GitHub Actions 与受控发布 | [发布说明](docs/release.md) |
| 修改项目 | [开发指南](AGENTS.md)、[架构原则](docs/architecture-guidelines.md) |

默认仓库首页为英文，本页提供中文说明。详细文档、CLI 输出和内置使用引导目前以中文为主。文档保留用途、约束和证据；字段、默认值、状态转换及内部流程以代码为准。

## 使用入口

Linux/macOS，Node.js **22.19+**。npm 安装包自带运行产物，无需从源码构建。实际发布状态及平台验收范围见[发布证据](docs/validation.md#npm-发布候选验证)。

```bash
npm install -g task-conductor
task-conductor setup
# 在 MCP 宿主中配置 command: task-conductor，args: [mcp]
# 连接后可查询后台状态：
task-conductor status
# 应用已保存配置并确认新实例可用：
task-conductor restart
```

setup 确认本机配置；MCP 连接自动启动或复用独立后台，宿主退出后后台继续运行。首次使用须安装至少一种原生执行 CLI，或[注册自定义本机 stdio ACP](docs/cli.md#自定义本机-acp-接入)，并准备其原生认证。Pi、Claude Code 和 Codex 可先安装[接入包](docs/host-integrations.md)，再通过 `using-task-conductor` 引导安装服务、完成 setup 和使用现有 MCP 工具。执行端准备与服务管理见[部署说明](docs/deployment.md)。

采用 `mcpServers` 格式的宿主可添加以下配置；文件位置和外层结构由宿主决定：

```json
{
  "mcpServers": {
    "task-conductor": {
      "command": "task-conductor",
      "args": ["mcp"]
    }
  }
}
```

宿主找不到命令时使用绝对路径；自定义安装目录时使用 `["mcp", "--home", "/absolute/private/task-conductor"]`。无需预先执行 `start`。本机 Web 控制台位于 `status` 返回地址的 `/admin/`，使用独立管理员令牌。

任务由 `task_create` 提交固定 DAG，每个节点选择已就绪执行端。每个 Task 保留一条协调会话，Run 单独记录执行；普通消息不启动空闲 ACP 工作，也不代替明确的问题回答。对话与补充执行入口见[会话设计](docs/task-conversation-plan.md#使用与实现入口)。显式工作目录优先，否则 stdio 入口补入自己的启动目录；直接 HTTP 调用必须提供目录。具体契约见 [task-contract.ts](src/protocol/task-contract.ts)，管理工具见 [mcp.ts](src/protocol/mcp.ts)。Prompt、人工回复和工作空间选择都不授予工具权限。

## CLI 命令索引

完整命令与参数使用 `task-conductor --help`、`task-conductor <命令> --help` 查询，不在文档中维护副本。

- 安装与运行：`setup`、`mcp`、`start`、`stop`、`restart`、`status`，见[部署说明](docs/deployment.md)；离线升级使用 `migrate`，见[升级说明](docs/upgrades.md)。
- 配置与凭据：`config`、`executor`、`coordinator`、`credential`；任务与运行：`task`、`run`，见 [CLI 说明](docs/cli.md)。

## 运行与安全边界

- 协议 turn 结束不等于任务完成；只有明确验收的交付才能解锁依赖。支持立即、定时及 Cron 任务，单节点与多节点共用 API。
- 普通讨论不授权额外工作；补充执行必须有明确意图，已验收交付与终结 Run 不可变。
- 外部工作中断或结果不明时阻止新派发，不自动重试、重放副作用或切换执行端。
- 沿用执行端原生授权，拒绝额外 ACP 审批请求。目录校验和环境过滤不是 OS 沙箱；日志和 Agent 输出可能敏感。
- `task-conductor stop` 停止后台及活动执行；重启关闭 ACP 会话，可能中断待回答 Run。客户端断开不等于停服或取消任务。
- 升级服务前停止后台、备份私有数据、安装目标包、检查数据格式，再重新连接 MCP；正常启动不迁移历史。见[升级说明](docs/upgrades.md)。

## 开发

```bash
npm ci --ignore-scripts
npm run check
npm test
git diff --check
```

基础测试使用真实本机文件、SQLite、进程和 SDK；真实模型验收需要另行获准的环境，基础测试不证明 ACP 任务成功。

## 许可证

[MIT](LICENSE)，Copyright (c) 2026 realqiyan。依赖及执行端仍遵循各自许可证。
