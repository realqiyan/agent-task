# 安装与运行

支持 Linux 和 macOS，要求 Node.js **22.19+** 与 npm。安装包包含编译后的服务、worker、Web 资源和操作脚本，不需要源码、TypeScript 或用户自行构建。当前发布状态和平台证据见[验证说明](validation.md#npm-发布候选验证)，发布步骤见[发布说明](release.md)。

## 安装与交互配置

```bash
npm install -g @realqiyan/agent-task
agent-task --version
agent-task setup
agent-task start
```

使用当前用户可写的 npm prefix，不以 root 运行任务服务。若使用 nvm 等版本管理器，先选定后台服务长期使用的 Node 安装；服务记录绝对路径，移除该 Node 或全局包会使它无法启动。

向导收集工作空间、可选执行端、可选协调模型及端口，并询问是否安装后台服务。默认只准备配置，不启动服务、不安装执行端、不请求密钥。取消确认不会写入配置。无终端环境必须明确提供参数：

```bash
agent-task setup --executors none --cwd /absolute/workspace --prepare-only
# 可选：安装 Pi ACP 组件，但仍不授权执行。
agent-task setup --home /absolute/private/agent-task \
  --executors pi --cwd /absolute/workspace \
  --provider deepseek --model deepseek-flash --prepare-only
```

这两个例子是不同的首次安装选择，不要用第二条覆盖已有安装。工作空间须预先存在，且位于安装目录及 npm 包之外。完整选项见 `agent-task setup --help`；执行端固定版本及平台实现见 [install-lib.mjs](../scripts/install-lib.mjs)。

默认私有目录为 Linux 的 `~/.local/share/agent-task` 或 macOS 的 `~/Library/Application Support/agent-task`。setup 输出配置、凭据文件和控制台地址，**不打印 token**。使用自定义 `--home` 时，后续命令也需传同一路径。

配置、凭据和任务数据不写入 npm 包目录。npm 管理应用包；setup 只管理私有目录、选定的 ACP 组件和用户服务。不要移动 npm prefix、Node 或安装目录后直接继续运行；当前不提供既有安装的自动路径重绑。

## 配置与认证

1. 前台运行 `agent-task start`，打开 setup 输出的本机控制台地址。用本地编辑器读取私有 `environment.json` 的 `AGENT_TASK_ADMIN_TOKEN`，在连接表单输入。不要把 token 放进 URL、命令行、Git、截图或日志。
2. 在[控制台](web-console.md)配置协调模型、单独保存模型密钥及注册 ACP 执行端。未配置协调模型时，服务仍可启动和配置，但不能接收可执行任务。
3. 如需安装器提供的执行端，用 setup 输出的专属路径按原生方式认证：[Pi](https://github.com/earendil-works/pi/tree/v1.3.0/packages/coding-agent/docs)、[Codex ACP](https://github.com/agentclientprotocol/codex-acp#readme)、[OpenCode](https://opencode.ai/docs/acp/)。后台服务与原生登录须使用一致的 HOME/配置目录。
4. 停服后审核执行端原生工具、沙箱、凭据传递及结果读取范围，再由管理员明确批准 `unattendedApproved`。安装器从不登录、自动批准或扩大权限；ACP allowlist 不是完整工具授权或 OS 沙箱。
5. 保存后手动重启。正在运行或等待人工回复的任务可能持有 ACP 会话，重启前须核查；不保证无损续接。

后台和托管前台启动都只读取明确的私有环境文件，不自动继承 shell 模型密钥。MCP token、管理员 token、协调模型和执行端凭据必须分开。工作空间校验不是授权。

显式执行握手检查：

```bash
agent-task setup --check --probe
```

这只执行 ACP initialize，不验证模型认证、任务成功或工具权限。普通 Pi CLI 不是 ACP server，需配合 pi-acp。已有执行端也可直接由控制台注册绝对 ACP 命令路径，不必重新安装或使用全局执行端。

## 前台运行与健康检查

```bash
agent-task start
# 另一个终端；自动从私有文件读取 MCP token，不输出凭据。
agent-task status
```

Ctrl-C 停止前台服务。也可显式指定已有的私有文件：

```bash
agent-task start --config /absolute/private/config.json \
  --environment /absolute/private/environment.json
```

文件权限、Web 认证与配置保存约束见[控制台说明](web-console.md)。显式文件模式不会生成安装清单；此时用自己的 MCP 客户端调用 `service_status`，不要使用依赖清单的 `agent-task status`。

配置契约以 [config.example.json](../config.example.json)、[config.ts](../src/config.ts) 为准。开发者仍可 `npm ci --ignore-scripts && npm run build` 后使用 `npm start -- --config ... --environment ...`，但 npm 安装用户不需要这些步骤。

## 后台运行

先停止前台实例，再安装并启动后台服务：

```bash
agent-task service install
agent-task status
```

命令在真实服务管理器中注册服务，并等待带 MCP token 的健康检查。重复安装不会覆盖配置或授权；已有同名但内容不同的服务会被拒绝覆盖。每个 OS 用户只管理一个同名服务。

Linux 需要可连接的 systemd 用户管理器：

```bash
systemctl --user status agent-task.service
systemctl --user stop agent-task.service
systemctl --user restart agent-task.service
journalctl --user -u agent-task.service
```

SSH/容器会话若没有用户 bus，应先配置正常用户会话；不要以 root 启动本服务。注销后运行需要管理员按策略配置 lingering，安装器不会启用。手动部署模板见 [deploy/agent-task.service.example](../deploy/agent-task.service.example)。

macOS 需要已登录的图形用户会话：

```bash
launchctl print gui/$(id -u)/com.agent-task.service
agent-task service remove
agent-task service install
```

remove 停止并卸载服务注册，install 重新加载配置。LaunchAgent 不是系统 LaunchDaemon，不保证用户注销后运行。日志位于 setup 的私有目录内。launchd 不等同于 Linux cgroup；两平台都不保证休眠或关机期间准点执行。

## 重入、更新与卸载

重复 setup 保留配置和授权。中断安装只能显式 `agent-task setup --resume`；所有权、清单或服务状态不明时停止核查，不删除历史或工作空间修复。

本项目仍处于调研阶段，不保证旧数据兼容。更新前阅读发行说明，停止服务并备份私有目录；普通启动不迁移既有数据。更换 Node 或 npm prefix 前先移除服务注册。不要在服务运行期间删除或覆盖应用包。

```bash
agent-task service remove   # 仅停服、移除服务注册；保留组件和数据
agent-task uninstall        # 再移除本安装拥有的 ACP 组件
npm uninstall -g @realqiyan/agent-task # 最后由 npm 移除应用包
```

`agent-task uninstall` 可重复运行，保留配置、凭据、日志、任务历史、工作空间和未入清单文件，不操作全局执行端及原生认证。卸载不是凭据撤销或数据销毁；停服不能回滚已发生的外部操作。实现见 [uninstall.mjs](../scripts/uninstall.mjs)。
