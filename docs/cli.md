# 本机管理 CLI

CLI 覆盖 Web 的配置、凭据、执行端管理、任务查询、未来触发控制及重启操作。两端通过同一管理 API 使用配置、执行端和任务服务；重启由同一启动器处理。命令入口见 [命令实现](../src/protocol/cli/commands.ts)，管理传输见 [admin-client.ts](../src/protocol/cli/admin-client.ts)。

## 连接与命令

先按[部署说明](deployment.md)安装并启动服务。CLI 通过安装目录定位当前实例，从私有环境文件读取管理员令牌，不需要复制令牌或登录命令。使用自定义安装目录时，每条命令都传入 `--home /absolute/installation`。

```bash
agent-task --help
agent-task config --help
agent-task executor --help
agent-task coordinator --help
agent-task credential --help
agent-task task --help
agent-task run --help
```

逐级帮助是命令与参数的完整入口。管理命令支持 `--json`，结果写入 stdout，预览和诊断写入 stderr；失败退出码非零。非交互保存、适配器升级与任务变更须使用 `--yes`，它只确认本次操作，不授予执行端原生工具权限。

服务不可用时，管理命令失败，不自动离线写文件。首次安装仍使用 `setup`；启动故障按[部署说明](deployment.md#后台前台与健康检查)停服核查。数据升级使用独立离线入口 `agent-task migrate`，见[升级说明](upgrades.md)；管理命令不自动迁移或修复历史。

## 配置流程

交互编辑可用 `agent-task config edit`。编辑器由 `--editor`、`VISUAL` 或 `EDITOR` 指定，值须是可执行文件名或路径，不包含 shell 参数。退出编辑器后先校验并显示影响，再确认保存。

批量编辑使用配置草稿：

```bash
agent-task config export --output /absolute/private/draft.json
# 编辑草稿中的配置，保留编辑令牌。
agent-task config validate --file /absolute/private/draft.json
agent-task config apply --file /absolute/private/draft.json --yes
agent-task config diff
agent-task restart
agent-task config show --running
```

导出文件不包含密钥值，以私有权限创建，拒绝覆盖已有文件。编辑令牌过期、服务重启或任一客户端保存配置/凭据后，旧草稿不能提交；重新读取并人工核对，不自动合并。草稿契约见 [settings-contract.ts](../src/protocol/settings-contract.ts)。

`executor enable/disable` 和 `coordinator` 提供便捷配置操作。配置服务生成候选配置，再走同一预览、校验和保存流程。内置执行端自动发现，无须手工注册、设置默认工作目录或另行批准。自定义 ACP 注册使用下述独立管理入口，不属于下次启动配置。启用与禁用在下次启动生效，不改写已有任务的执行端指派。

配置与凭据均在下次启动生效。影响预览不修改旧任务快照，也不证明模型认证或 ACP 执行成功。保存顺序、端点与凭据隔离、重启影响见[控制台说明](web-console.md#保存与重启)。

## 执行端发现与更新

```bash
agent-task executor list
agent-task executor show codex
agent-task executor refresh
# 仅在需要升级适配器时执行：
agent-task executor upgrade codex --yes
agent-task executor list
```

发现、安装复用、升级影响和原生认证统一见[部署说明](deployment.md#执行端发现与准备)。就绪不证明工具授权或任务成功；PATH 变化也不能仅靠刷新生效。

## 自定义本机 ACP 接入

通过管理员 CLI 注册，不增加任务 MCP 注册工具。注册授权服务启动本机代码；MCP 仍只能查询并选择执行端 ID。Web 使用同一管理 API 和执行端服务。仅接入由服务启动的本机 stdio ACP 进程，不接受远程地址或附着已有服务。

先安装执行程序，在其原生配置中完成认证和无人值守授权。注册文件使用私有权限，不含密钥；格式与限制见 [注册契约](../src/executors/validation.ts)，完整操作引导见 [custom-acp](../plugin/skills/using-agent-task/references/custom-acp.md)。先查 `agent-task executor --help` 确认已安装服务支持此入口，再执行：

```bash
agent-task executor register --file /absolute/private/my-acp.json --yes
agent-task executor show my-acp
# 经确认不再用于后续派发时：
agent-task executor unregister my-acp --yes
```

管理服务须已运行；尚未启动时，在另一终端运行 `agent-task start`。没有内置 CLI 也能注册。命令使用规范绝对路径及参数数组，直接执行而非 shell 展开。注册可选 `cwd`，须为已存在且可访问的规范绝对目录；省略时进程从任务 workspace 启动。该字段仅设置进程启动目录，不覆盖 ACP 会话使用的任务 workspace。执行端使用后台的过滤后原生环境，不继承注册命令所在终端的新环境变量。

**注册和注销持久化后立即生效，无须重启。** 注册只校验本地启动条件，不启动 ACP 或调用模型；`ready` 不证明协议兼容、认证或工具授权。MCP 初始化曾因无执行端失败时，注册后重连 MCP 即可。原生环境变更仍按[部署说明](deployment.md#执行端发现与准备)处理。

同名注册拒绝覆盖。变更启动方式时优先使用新 ID，按需创建经批准的新任务，不改派已有任务或绕过不确定结果。注销只阻止新的派发，不杀死活动进程、不删除历史；后续续接可能被拒绝。旧任务保持原启动快照，即使重新注册相同 ID，命令、参数或 `cwd` 变化也会被拒绝。固定路径不是文件内容完整性保证或沙箱。

注册存于当前 dataDir 的私有文件，随该目录保留；切换数据目录不复制注册。不要在运行时离线编辑。读写实现见 [files.ts](../src/executors/files.ts)，准入与发布顺序见 [registry.ts](../src/executors/registry.ts)。发布结果不明时停止并核查，不盲目重试。

## 凭据与任务

`credential set NAME` 使用隐藏终端输入；自动化通过 `--stdin --yes` 从可信凭据工具或受保护文件传值，不把值写进命令参数。`credential list` 只显示设置状态。执行端原生登录和权限继续由其官方工具管理。

`task show ID` 查看固定 DAG，`run show ID` 查看节点、原始回合、已接受交付及问题回复。`task schedule pause/resume/cancel` 仅控制未来触发，不停止当前运行；恢复不补跑，取消后不可恢复未来触发；有不确定外部结果时也拒绝恢复。操作边界与 Web 一致，见[控制台说明](web-console.md#操作范围)。
