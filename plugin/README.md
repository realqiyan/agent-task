# Agent Task 宿主接入

不含服务依赖的 Pi 接入包及 Claude Code/Codex 插件。插件名为 `agent-task`，技能名为 `using-agent-task`，用于引导安装、初始化、MCP 连接和日常任务操作。任务操作使用现有 Agent Task MCP 工具。

## 安装接入包

服务与插件在同一仓库开发，作为两个 npm 包独立分发。插件包为 `@realqiyan/agent-task-plugin`，不要将服务包 `@realqiyan/agent-task` 当作 Pi 插件安装。

```bash
pi install npm:@realqiyan/agent-task-plugin
# Claude Code：先获取 marketplace 索引，再安装 npm 插件
claude plugin marketplace add https://raw.githubusercontent.com/realqiyan/agent-task/master/.claude-plugin/marketplace.json
claude plugin install agent-task@agent-task --scope user
# Codex：稀疏检出索引，再安装 npm 插件
codex plugin marketplace add realqiyan/agent-task --sparse .agents/plugins
codex plugin add agent-task@agent-task
```

marketplace 固定插件版本。发布状态与验收范围见[验证说明](https://github.com/realqiyan/agent-task/blob/master/docs/validation.md#宿主接入包)。Codex 稀疏检出仍可能下载 Git 元数据及根目录文件。

未发布源码可由 Pi 直接安装仓库的 `plugin/` 目录。Claude Code/Codex 开发者在仓库运行 `node scripts/create-plugin-marketplace.mjs`，注册输出目录，再安装 `agent-task@agent-task-dev`。开发快照使用本地来源；不要同时启用开发版与正式版。

插件没有 npm 安装 hook，不自动安装服务。新会话中调用：

- Pi：`/skill:using-agent-task`
- Claude Code：`/agent-task:using-agent-task`
- Codex：`$using-agent-task`，或在 `/skills` 中选择。

技能先检查已有安装，取得确认后通过宿主 shell 安装服务，再引导运行 `agent-task setup`。凭据只在用户终端或私有文件中处理，不进入聊天。服务要求 Linux/macOS、Node.js 22.19+ 和 npm；运行技能还需要宿主自己的模型访问能力。

Pi 在 setup 完成后注册本项目 MCP。Claude Code/Codex 插件已声明 MCP；服务缺失或初始化未完成时连接失败是预期行为。完成 setup 后重连或新开会话，不重复添加连接。

## 启动检查

Pi 扩展和 Claude Code/Codex 的 `SessionStart` hook 独立于 MCP 连接检查安装状态。异常时显示技能入口并提供简短上下文；正常时保持安静，不触发模型、安装、修复或服务启动。

检查先调用 `agent-task setup --check --json`，配置有效后调用 `agent-task status --json`。两步共享时限，输出受限。状态查询只访问已有本机后台，比较安装、launcher 和服务版本，不启动或重启后台。插件不读取私有配置，不转发子进程原始诊断；版本缺失或检查失败不能视为未安装或版本一致。

检查只在会话启动时运行，不持续监控，也不验证宿主 MCP 连接。当前会话内升级后仍须主动重连验证。

自定义 MCP 命令或 home 时，在宿主启动环境设置 `AGENT_TASK_PREFLIGHT_COMMAND` 和 `AGENT_TASK_PREFLIGHT_HOME`；它们只选择检查目标，MCP 须另行配置相同程序和 home。不需要检查或使用其他连接时，可在宿主中禁用对应 hook/扩展。

Codex hook 须先在 `/hooks` 中审查并信任。不绕过信任。检查禁用、未获信任或 Node 无法启动时，技能仍可显式调用。

## 使用引导

- [安装、升级与连接](skills/using-agent-task/references/installation.md)
- [提交任务、查看交付和回答问题](skills/using-agent-task/references/tasks.md)
- [故障排查](skills/using-agent-task/references/troubleshooting.md)
- [宿主安装与移除](https://github.com/realqiyan/agent-task/blob/master/docs/host-integrations.md)

卸载插件不会停止共享服务或删除任务历史。Pi 中单独注册的 MCP 连接须另行移除。安装插件或使用技能不授予执行端工具权限。
