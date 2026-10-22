# 安装与运行入口

面向 macOS 和 Linux。运行时要求及开发命令见 [package.json](../package.json)。Linux 已有本机部署证据；macOS 尚未实机验收，详见[验证说明](validation.md#部署验证)。

## 安装

从源码目录执行，先准备组件，再完成认证和权限审核：

```bash
node scripts/setup.mjs --executors pi --cwd /absolute/workspace \
  --provider deepseek --model deepseek-flash --prepare-only
```

选项见 `node scripts/setup.mjs --help`；安装版本和平台实现见 [install-lib.mjs](../scripts/install-lib.mjs)。使用自定义 `--home` 时，后续 setup/uninstall 也需传同一路径。工作空间应在安装目录外。

手动前台运行入口：

```bash
npm ci --ignore-scripts
npm run build
cp config.example.json config.local.json
# 编辑配置，安全注入服务 token 和协调模型凭据后启动：
npm start -- --config "$PWD/config.local.json"
```

配置以 [config.example.json](../config.example.json) 和 [config.ts](../src/config.ts) 为准；模型接入见 [coordinator-provider.ts](../src/coordinator-provider.ts)。不要使用命令行参数或 Git 保存凭据。

以上前台命令为 MCP 使用方式。本机 Web 控制台需要独立管理员令牌和显式环境文件；启用、私有文件要求及保存流程见[控制台说明](web-console.md)。

## 认证与授权交接

1. 使用 setup 输出的执行文件路径，按执行端原生方式登录和配置权限：[Pi](https://github.com/earendil-works/pi/tree/v1.3.0/packages/coding-agent/docs)、[Codex ACP](https://github.com/agentclientprotocol/codex-acp#readme)、[OpenCode](https://opencode.ai/docs/acp/)。
2. 在 setup 输出的私有配置位置或[控制台](web-console.md)准备协调模型凭据；后台环境由 `environment.json` 提供，不自动继承当前 shell 的密钥。原生登录与后台运行须使用一致的 HOME/配置目录。
3. 停服后审核执行端原生工具、沙箱和结果读取范围，再批准 `unattendedApproved`。setup 不替用户登录或批准执行；ACP 审批不是完整工具授权。
4. 使用显式握手检查确认接入，但不能把 initialize 成功当作模型或任务成功：

```bash
node scripts/setup.mjs --check --probe
node scripts/setup.mjs
```

普通 Pi CLI 不是 ACP server，需使用 [pi-acp](https://github.com/svkozak/pi-acp#readme)。其他执行端同样必须提供真正的 ACP 入口。已有 profile 的手动注册入口见 [admin.ts](../src/admin.ts)，真实任务验收见[验证说明](validation.md)。

## 后台管理

Linux 使用 systemd 用户服务：

```bash
systemctl --user status agent-task.service
systemctl --user stop agent-task.service
systemctl --user restart agent-task.service
```

注销后运行需要管理员按策略配置 lingering，安装器不会自动启用。手动部署可参考 [systemd 模板](../deploy/agent-task.service.example)。

macOS 使用登录用户的 LaunchAgent：

```bash
launchctl print gui/$(id -u)/com.agent-task.service
launchctl bootout gui/$(id -u)/com.agent-task.service
# 停止并修改配置后，使用 setup 重新加载。
```

LaunchAgent 不保证注销后运行；两平台均不保证休眠或关机期间准点执行。launchd 不等同于 Linux cgroup，进程监督也不是工具沙箱。

## 重入与卸载

重复 setup 不覆盖已有配置和授权；安装中断只能显式 `--resume`。清单、所有权或服务状态无法确认时应停下核查，不删除历史或工作空间来修复安装。

```bash
node scripts/uninstall.mjs
```

卸载只清理本安装拥有的服务和组件，保留配置、凭据、日志、任务历史及工作空间，不操作全局执行端。专属组件若被其他应用引用，须先解除依赖再卸载。具体检查与清理范围见 [uninstall.mjs](../scripts/uninstall.mjs)。卸载不是凭据撤销或数据销毁；停服也不能回滚已经发生的外部操作。
