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

服务不可用时，管理命令失败，不自动离线写文件。首次安装仍使用 `setup`；启动故障按[部署说明](deployment.md#后台前台与健康检查)停服核查。CLI 不迁移数据或修复历史。

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

`executor enable/disable` 和 `coordinator` 提供便捷配置操作。配置服务生成候选配置，再走同一预览、校验和保存流程。执行端自动发现，无须手工注册、设置默认工作目录或另行批准。启用与禁用在下次启动生效，不改写已有任务的执行端指派。

配置与凭据均在下次启动生效。影响预览不修改旧任务快照，也不证明模型认证或 ACP 执行成功。保存顺序、端点与凭据隔离、重启影响见[控制台说明](web-console.md#保存与重启)。

## 执行端发现与更新

`agent-task executor list` 查看当前发现和准备结果；`executor show codex` 查看单个执行端。安装新的原生 CLI 后，运行 `executor refresh` 重新检测并在后台准备缺少的 ACP 适配器。该操作无需重启。准备失败时先检查报告的原因，修正后显式刷新或升级。

已准备的适配器不会随普通启动或刷新自动升级。需要更新时运行 `agent-task executor upgrade codex --yes`，再用 `executor list` 检查结果。升级期间暂停向该执行端派发新工作；它不修改已有任务指派。OpenCode 使用原生 ACP 命令，通过原生 CLI 的安装渠道更新。

就绪状态只表示启动依赖已准备。原生登录和权限仍由执行端管理；首次准备、版本来源及运行边界见[部署说明](deployment.md)。

## 凭据与任务

`credential set NAME` 使用隐藏终端输入；自动化通过 `--stdin --yes` 从可信凭据工具或受保护文件传值，不把值写进命令参数。`credential list` 只显示设置状态。执行端原生登录和权限继续由其官方工具管理。

`task show ID` 查看固定 DAG，`run show ID` 查看节点、原始回合、已接受交付及问题回复。`task pause/resume/cancel` 仅控制未来触发，不停止当前运行；恢复不补跑，取消后不可恢复未来触发；有不确定外部结果时也拒绝恢复。操作边界与 Web 一致，见[控制台说明](web-console.md#操作范围)。
