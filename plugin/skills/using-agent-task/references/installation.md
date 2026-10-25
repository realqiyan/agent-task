# 安装与连接 Agent Task

## 检查与安装

1. 确认宿主、操作系统、安装位置和配置范围。要求 Linux/macOS、Node.js 22.19+ 和 npm；检查 `node --version`、`npm --version`、`command -v agent-task`，已找到时查询 `agent-task --version`。不把插件目录当 workspace。
2. 先检查已有安装、自定义 --home 和 MCP 连接。命令不在 PATH 时查询用户已知安装与 `npm prefix -g`；PATH 问题不需要第二份安装。
3. 确认缺失后，说明安装会把 npm 包下载到当前用户的全局 prefix，取得安装 `@realqiyan/agent-task` 的确认。用户指定版本时先核实版本，不虚构版本或假定插件同版服务已发布。
4. 获准后用宿主 shell 工具**执行** `npm install -g @realqiyan/agent-task`，遵循原生权限检查。不自动 sudo、更改 prefix 或放宽安全策略。权限/网络不足时报告失败，提供相同命令供用户终端执行，不扩大权限重试。
5. 检查退出码及安装版本；必要时使用确认 prefix 下 bin/ 的绝对路径。未经明确批准不升级已有安装。

## 使用现有 CLI 初始化

请用户在自己的终端运行 `agent-task setup`，自定义安装使用 `agent-task setup --home /absolute/private/agent-task`。由用户确认目录、端口、独立服务/管理员令牌及协调 provider/model。不在聊天索要秘密、不打印凭据文件、不复用宿主模型登录作为协调凭据。

用户要求非交互 setup 时，先读 `agent-task setup --help`，只使用已确认选项和用户准备的私有凭据文件，确认后可代执行。不猜模型配置，不未经同意生成令牌，不在参数放秘密。未配置协调者时可以管理，但不能接收可执行任务。

保留已有配置；中断初始化须明确批准 --resume，不删除历史或猜测修复。后台至少能发现原生 pi、codex、claude、opencode 中的一种，或已有[自定义就绪 ACP 执行端](custom-acp.md)。各执行端使用自己的原生登录和授权。连接前说明 MCP 初始化可能下载缺失的 ACP 适配器；就绪不证明认证和完整工具权限。

## 启动检查与信任

插件通过有时长和输出限制的 `agent-task setup --check --json` 只读检查，不自动修复。失败或不支持时只能报告不确定；已初始化但停止的后台不是未安装。

根据提示行动前核对命令和 home。配置自定义 MCP 时，经确认在宿主启动环境设置 `AGENT_TASK_PREFLIGHT_COMMAND` 与 `AGENT_TASK_PREFLIGHT_HOME`。它们是非敏感的诊断目标，不配置 MCP 或服务；不写入服务凭据，也不假设插件识别了手工宿主配置。

Codex 需要用户在 /hooks 审查并信任 hook，不绕过信任。hook/扩展禁用或 Node 无法启动时使用显式技能入口；没有提示不证明就绪。用户可以禁用检查而保留技能。

## 注册或重连

使用 setup 对应的 OS 用户、原生环境与 home。stdio 私下读取服务凭据，不把令牌或端口复制到宿主配置。修改前检查已有条目、保留其他设置，仅保留一条 Agent Task 连接。

### Pi 1.4.0+ 原生 MCP

确认后执行：

```bash
pi mcp add agent-task -- agent-task mcp
pi mcp list
```

自定义安装改用：

```bash
pi mcp add agent-task -- /absolute/bin/agent-task mcp --home /absolute/private/agent-task
```

这是用户级条目；仅在用户选择项目范围时用 --local。add 会替换同名条目。使用 /reload 或新会话重载。若其他扩展替代了原生 MCP，应先询问保留哪种接入，不再安装第二座桥接。

### Claude Code 与 Codex 插件

启用的插件已声明 `agent-task mcp`，默认安装不要再手工添加。setup 后开启新会话；Claude Code 也可在 /mcp 重连。核查新会话的 /mcp 状态。

自定义 home 或程序路径时保留技能，先禁用随包 MCP 再手工注册；不修改更新管理的插件缓存。

Claude Code：请用户在 /mcp 禁用插件的 Agent Task 服务，确认后执行：

```bash
claude mcp add --transport stdio --scope user agent-task -- /absolute/bin/agent-task mcp --home /absolute/private/agent-task
```

Codex：确认后只合并以下表，保留其他配置，再注册连接：

```toml
[plugins."agent-task@agent-task".mcp_servers.agent-task]
enabled = false
```

```bash
codex mcp add agent-task -- /absolute/bin/agent-task mcp --home /absolute/private/agent-task
```

重启会话并核对只有目标连接启用。GUI 宿主也须能找到 Node 和原生执行 CLI。

## 不执行领域工作的验证

1. 确认宿主实际连接并列出工具；静态配置列表不证明连接。
2. 通过实际 MCP 命名空间发现并调用 `executor_list({})`、`task_list({})`。Pi 默认使用原生工具搜索/codemode。
3. 分别报告连接、只读调用与执行端就绪；适配器准备中则稍后查询，不为验证安装提交任务或调用收费模型。

后续 CLI 使用相同 --home。`agent-task mcp` 启动或复用共享后台，宿主退出不停止它。停止或重启活动工作前须确认。
