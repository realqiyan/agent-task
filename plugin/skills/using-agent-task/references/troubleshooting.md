# 先核查，再修改

- **命令缺失**：检查宿主 PATH 和用户已知 npm prefix，优先使用已有绝对路径。确认未安装后按[安装说明](installation.md)取得授权。
- **升级后仍运行旧版或提示版本未知**：用相同命令路径和 `--home` 查询 `agent-task status`，核对安装、launcher 与服务版本；通过 MCP `service_status` 查看后台 `serviceVersion`。宿主重连会复用已有后台，`agent-task restart` 也不会更新 launcher；按[升级流程](installation.md#升级已有服务)检查活动工作、确认停服、备份并完整重连。版本未知不等于一致，不自动重装；同版本开发快照仍须手动停服重连。
- **初始化不完整或 home 不正确**：使用 setup 时选择的 home。不泄露私有环境文件、不运行重置脚本或删除历史；续接初始化须明确批准 CLI 的 resume。
- **宿主连接缺失或重复**：检查 MCP 配置和已启用插件。Pi 使用原生注册，Claude/Codex 通常用随包入口。setup 后重连并保留无关配置。自定义 home 见[安装说明](installation.md)。
- **没有执行端或适配器仍在准备**：连接后用 `executor_list`；无法连接时用现有 CLI 管理命令。区分原生 CLI 缺失、禁用、安装中或准备失败。沿用原生登录与授权，不扩大权限让探针通过。
- **自定义 ACP 注册问题**：读取[注册说明](custom-acp.md)，检查 CLI 支持、home、规范路径和原生授权。注册无需重启；只在此前 MCP 初始化失败时重连。ready 不是 ACP 协议验证。
- **已连接但拒绝执行任务**：检查 `service_status` 及错误中的协调配置和执行端状态。管理可用不证明模型可用。不猜测凭据或发任务探测认证。
- **任务失败、响应丢失或结果不明**：先查询已有 Task/Run。不静默重提、更换 requestKey 或执行端。任务与运行控制的区别见[任务使用](tasks.md)。

用同一个自定义 `--home` 调用 `agent-task status` 检查后台。宿主断开或移除插件不停止持久任务。重启可能中断 ACP 会话及等待 Run；stop/restart 前须核查活动工作并确认。
