---
name: using-task-conductor
description: 使用 Task Conductor。适用于 MCP 连接、提交调用方定义的 DAG、查询运行和交付、持续 Task 对话、显式补充工作、回答用户事实问题、通过管理员 CLI 注册本机 stdio ACP 执行端及排查连接故障。
---

# 使用 Task Conductor

## 选择下一步

- **首次使用、服务缺失或安装/连接请求**：读取[安装说明](references/installation.md)，按用户授权的范围执行安装和连接配置。
- **自定义 ACP 执行端**：读取[注册说明](references/custom-acp.md)，使用管理员 CLI 注册用户授权的本机程序；注册即时生效。
- **已连接并准备提交任务**：读取[任务使用](references/tasks.md)，通过已连接宿主的实际工具及当前契约提交任务。
- **连接或执行故障**：读取[故障排查](references/troubleshooting.md)，先核查再修改。不确定结果不授予重放权限。

## 边界

- MCP 调用方定义固定 DAG，并为每个节点选择已就绪 ACP 执行端。
- 使用宿主实际提供的 MCP 工具及当前契约；任务写操作通过 MCP 完成。
- 凭据不进入聊天、命令参数或宿主 MCP 配置；不把私有环境文件读入模型上下文。
- 协议 turn 结束或提交成功不等于任务完成；分别报告已验收交付、失败和等待用户。
- 不自动重试中断工作、切换执行端、删除历史或清理工作目录来修复状态。

显式调用：Pi `/skill:using-task-conductor`；Claude Code `/task-conductor:using-task-conductor`；Codex `$using-task-conductor` 或在 `/skills` 中选择。
