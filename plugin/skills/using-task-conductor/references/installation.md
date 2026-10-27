# 安装与连接 Task Conductor

## 检查与安装

1. 确认宿主、操作系统、安装位置和配置范围。要求 Linux/macOS、Node.js 22.19+ 和 npm；检查 `node --version`、`npm --version`、`command -v task-conductor`，已找到时查询 `task-conductor --version`。不把插件目录当 workspace。
2. 先检查已有安装、自定义 --home 和 MCP 连接。命令不在 PATH 时查询用户已知安装与 `npm prefix -g`；PATH 问题不需要第二份安装。
3. 确认缺失后，说明安装会把 npm 包下载到当前用户的全局 prefix，取得安装 `task-conductor` 的确认。用户指定版本时先核实版本，不虚构版本或假定插件同版服务已发布。
4. 获准后用宿主 shell 工具**执行** `npm install -g task-conductor`，遵循原生权限检查。不自动 sudo、更改 prefix 或放宽安全策略。权限/网络不足时报告失败，提供相同命令供用户终端执行，不扩大权限重试。
5. 检查退出码及安装版本；必要时使用确认 prefix 下 bin/ 的绝对路径。未经明确批准不升级已有安装。

## 升级已有服务

1. 核对已有命令路径、npm prefix、安装版本及同一个 `--home`，确认目标版本和升级授权。不要另装一份来修复 PATH。
2. 用 `task-conductor status` 和现有 Task/Run 查询检查活动协调、ACP 会话及待回答 Run；仅看活动调用列表不能证明没有待回答工作。说明停服影响并取得确认，确认前不停止服务。
3. 执行 `task-conductor stop`，确认后台已停止，再由用户安全备份安装目录和数据目录；备份不读入聊天。后台原已停止时不为升级启动它。
4. 使用已确认的 npm prefix 执行 `npm install -g task-conductor`；指定版本须先核实。检查退出码及 `task-conductor --version`。不重复 setup、不自动删除历史或重放任务；安装失败后停止流程并报告现状。继续保持宿主断开，用同一 `--home` 执行 `task-conductor migrate --check`。需要迁移时先读 `migrate --help`，确认备份位置后执行 `task-conductor migrate --backup /absolute/private/backup --yes`；中断时核查备份并明确使用 `--resume --yes`。格式未知、缺表或校验失败时停止，不手工补表。
5. 请用户在宿主中重新建立 MCP 连接：Pi `/reload`；Claude Code 在 `/mcp` 重连或新开会话；Codex 新开会话。连接会启动新版后台。`task-conductor restart` 只重启服务运行进程，不能代替 launcher 的完整停服和宿主 stdio 进程重连。
6. 用同一命令路径和 home 查询 `task-conductor status`，核对安装、launcher 和服务版本一致且 `restartRequired=false`；再通过实际 MCP 调用 `service_status` 核对 `serviceVersion`，并调用 `executor_list` 验证只读连接。不为验证创建任务或调用模型。

仅 npm 安装成功时报告“安装完成，尚待重连验证”，不能报告升级完成。旧进程不提供版本信息时报告无法确认，不从安装版本推断运行版本。同版本覆盖安装也不能靠版本号识别，开发快照仍须完整停服重连。自定义安装的所有管理命令使用相同 `--home`；保留现有 MCP 注册，不重新添加连接。

## 使用现有 CLI 初始化

请用户在自己的终端运行 `task-conductor setup`，自定义安装使用 `task-conductor setup --home /absolute/private/task-conductor`。由用户确认目录、端口、独立服务/管理员令牌及协调 provider/model。不在聊天索要秘密、不打印凭据文件、不复用宿主模型登录作为协调凭据。

用户要求非交互 setup 时，先读 `task-conductor setup --help`，只使用已确认选项和用户准备的私有凭据文件，确认后可代执行。不猜模型配置，不未经同意生成令牌，不在参数放秘密。未配置协调者时可以管理，但不能接收可执行任务。

保留已有配置；中断初始化须明确批准 --resume，不删除历史或猜测修复。后台至少能发现原生 pi、codex、claude、opencode 中的一种，或已有[自定义就绪 ACP 执行端](custom-acp.md)。各执行端使用自己的原生登录和授权。连接前说明 MCP 初始化可能下载缺失的 ACP 适配器；就绪不证明认证和完整工具权限。

## 启动检查与信任

插件通过有时长和输出限制的 `task-conductor setup --check --json` 只读检查；配置有效后，用 `task-conductor status --json` 查询已有后台的运行版本。不自动启动、重启或修复。失败或不支持时只能报告不确定；已初始化但停止的后台不是未安装。启动检查不是持续监控，当前会话中升级仍须按上述流程完成重连验证。

根据提示行动前核对命令和 home。配置自定义 MCP 时，经确认在宿主启动环境设置 `TASK_CONDUCTOR_PREFLIGHT_COMMAND` 与 `TASK_CONDUCTOR_PREFLIGHT_HOME`。它们是非敏感的诊断目标，不配置 MCP 或服务；不写入服务凭据，也不假设插件识别了手工宿主配置。

Codex 需要用户在 /hooks 审查并信任 hook，不绕过信任。hook/扩展禁用或 Node 无法启动时使用显式技能入口；没有提示不证明就绪。用户可以禁用检查而保留技能。

## 注册或重连

使用 setup 对应的 OS 用户、原生环境与 home。stdio 私下读取服务凭据，不把令牌或端口复制到宿主配置。修改前检查已有条目、保留其他设置，仅保留一条 Task Conductor 连接。

### Pi 1.4.0+ 原生 MCP

确认目标项目目录后，在该目录执行：

```bash
pi mcp add --local task-conductor -- task-conductor mcp
pi mcp list
```

自定义安装改用：

```bash
pi mcp add --local task-conductor -- /absolute/bin/task-conductor mcp --home /absolute/private/task-conductor
```

默认用 `--local` 将 MCP 条目写入本项目的 `.pi/mcp.json`；仅在用户明确选择用户范围时省略 `--local`。add 会替换同名条目。使用 /reload 或新会话重载。若其他扩展替代了原生 MCP，应先询问保留哪种接入，不再安装第二座桥接。

### Claude Code 与 Codex 插件

启用的插件已声明 `task-conductor mcp`，默认安装不要再手工添加。setup 后开启新会话；Claude Code 也可在 /mcp 重连。核查新会话的 /mcp 状态。

自定义 home 或程序路径时保留技能，先禁用随包 MCP 再手工注册；不修改更新管理的插件缓存。

Claude Code：请用户在 /mcp 禁用插件的 Task Conductor 服务，确认后执行：

```bash
claude mcp add --transport stdio --scope user task-conductor -- /absolute/bin/task-conductor mcp --home /absolute/private/task-conductor
```

Codex：确认后只合并以下表，保留其他配置，再注册连接：

```toml
[plugins."task-conductor@task-conductor".mcp_servers.task-conductor]
enabled = false
```

```bash
codex mcp add task-conductor -- /absolute/bin/task-conductor mcp --home /absolute/private/task-conductor
```

重启会话并核对只有目标连接启用。GUI 宿主也须能找到 Node 和原生执行 CLI。

## 不执行领域工作的验证

1. 确认宿主实际连接并列出工具；静态配置列表不证明连接。
2. 通过实际 MCP 命名空间发现并调用 `executor_list({})`、`task_list({})`。Pi 默认使用原生工具搜索/codemode。
3. 分别报告连接、只读调用与执行端就绪；适配器准备中则稍后查询，不为验证安装提交任务或调用收费模型。

后续 CLI 使用相同 --home。`task-conductor mcp` 启动或复用共享后台，宿主退出不停止它。停止或重启活动工作前须确认。
