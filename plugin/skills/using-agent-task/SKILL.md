---
name: using-agent-task
description: 使用 Agent Task。适用于 MCP 连接、提交调用方定义的 DAG、查询运行和交付、持续 Task 对话、显式补充工作、回答用户事实问题、通过管理员 CLI 注册本机 stdio ACP 执行端及排查连接故障。
---

# 使用 Agent Task

## 选择下一步

- **首次使用、服务缺失或安装/连接请求**：读取[安装说明](references/installation.md)。获得确认后，用宿主 shell 工具执行安装，而不是只给出命令。
- **自定义 ACP 执行端**：读取[注册说明](references/custom-acp.md)，确认后使用管理员 CLI。注册无需重启；不通过任务 MCP 工具传递启动命令。
- **已连接并准备提交任务**：读取[任务使用](references/tasks.md)，发现宿主实际工具及当前契约。不要每次提交任务都重新 setup 或安装。
- **连接或执行故障**：读取[故障排查](references/troubleshooting.md)，先核查再修改。不确定结果不授予重放权限。

引用路径相对于本技能目录。引用文件随插件分发，使用引导不依赖另行安装服务包或检出仓库文档。

## 边界

- MCP 调用方定义固定 DAG，并为每个节点选择已就绪 ACP 执行端。
- 直接使用现有 MCP 工具。从实际契约读取字段、默认值和错误，不复制完整契约或创建转发层。
- 凭据不进入聊天、命令参数或宿主 MCP 配置；不把私有环境文件读入模型上下文。
- 协议 turn 结束或提交成功不等于任务完成；分别报告已验收交付、失败和等待用户。
- 不自动重试中断工作、切换执行端、删除历史或清理工作目录来修复状态。

显式调用：Pi `/skill:using-agent-task`；Claude Code `/agent-task:using-agent-task`；Codex `$using-agent-task` 或在 `/skills` 中选择。
