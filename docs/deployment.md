# 安装与运行

支持 Linux 和 macOS，要求 Node.js **22.19+** 与 npm。安装包包含运行产物，不需要源码或 TypeScript。发布状态和平台证据见[验证说明](validation.md)，发布操作见[发布说明](release.md)。

## 安装与交互配置

```bash
npm install -g @realqiyan/agent-task
agent-task setup
agent-task start
```

使用当前用户可写的 npm prefix，不以 root 运行。

向导收集工作空间、可选执行端、可选协调模型及端口。取消确认不写配置。无终端环境须明确提供参数：

```bash
agent-task setup --executors none --cwd /absolute/workspace
# 另一个首次安装选择：安装 Pi ACP 组件，但不授权执行。
agent-task setup --home /absolute/private/agent-task \
  --executors pi --cwd /absolute/workspace \
  --provider deepseek --model deepseek-flash
```

工作空间须预先存在，且位于安装目录及 npm 包之外。完整选项见 `agent-task setup --help`；组件版本及平台实现见 [install-lib.mjs](../scripts/install-lib.mjs)。安装不执行原生登录或批准任务。

默认安装目录为 Linux 的 `~/.local/share/agent-task` 或 macOS 的 `~/Library/Application Support/agent-task`。自定义 `--home` 后，后续命令也传同一路径。setup 输出私有文件路径和控制台地址，**不打印 token**。

## 数据目录与配置

初始 `dataDir` 是安装目录下的 `data/`。运行配置、私有环境文件、任务和协调会话记录、结果及服务文件日志均位于当前 `dataDir`。配置契约见 [配置契约](../src/configuration/contract.ts)，路径选择与新目录准备见 [startup.ts](../src/application/startup.ts)。

安装目录保留固定的 `launch.json` 定位文件、安装清单、组件及启动器控制资源；它不是另一份运行配置。CLI 通过这个固定入口定位当前数据目录。npm 包、用户工作空间和执行端原生配置不随 `dataDir` 移动。

在 Web 修改数据目录后，下次启动只在目标目录准备已保存的配置和私有环境，并切换定位文件；**不复制任务、会话、结果或日志，不删除旧目录**。目标已有不同启动文件时拒绝覆盖；须停服核对并显式准备目标，不自动合并或修复。新目录没有旧任务，不能把切换目录当成故障恢复或重放许可。

1. 运行 `agent-task start`，打开输出的本机控制台地址。用本地编辑器读取当前 `dataDir/environment.json` 的 `AGENT_TASK_ADMIN_TOKEN`，在连接表单输入。不要把 token 放进 URL、命令行、Git、截图或日志。
2. 在[控制台](web-console.md)或 [CLI](cli.md) 配置协调模型、单独保存模型密钥及注册执行端。两端使用同一管理服务。未配置协调模型时可管理服务，但不能接收可执行任务。
3. 按执行端官方方式准备原生认证及权限：[Pi](https://github.com/earendil-works/pi/tree/v1.3.0/packages/coding-agent/docs)、[Codex ACP](https://github.com/agentclientprotocol/codex-acp#readme)、[Claude ACP](https://github.com/zed-industries/claude-agent-acp)、[OpenCode](https://opencode.ai/docs/acp/)。运行进程与原生登录须使用同一 OS 用户及相应 HOME/配置目录。
4. 审核原生工具、沙箱、凭据和结果文件读取权限后，再明确批准无人值守执行。注册只选类型，不配置命令、参数、环境变量清单或 ACP 工具白名单；系统映射见 [命令映射](../src/integrations/acp/runtime.ts)。额外 ACP 审批请求被拒绝，不自动批准。

服务和协调员的秘密只从私有环境文件加载，不回退到 shell 模型密钥。执行端沿用启动上下文中的用户原生环境，但排除私有文件变量、服务/管理员令牌、协调员凭据及同值别名。不要把执行端原生凭据放入服务的私有环境文件。启动器不执行 shell 启动脚本，也不导入原生认证文件。隔离实现见 [服务环境校验](../src/configuration/environment.ts)、[执行端环境过滤](../src/executors/environment.ts)。这不是同一 OS 用户下的沙箱。

显式握手检查：

```bash
agent-task setup --check --probe
```

这只做 ACP initialize，不验证模型认证、任务成功或原生工具权限。普通 Pi CLI 不是 ACP server，须配合 pi-acp。自行安装的受支持适配器也可使用，只要在服务的原生 PATH 中；无需填写绝对可执行文件路径。

## 前台、重启与健康检查

```bash
agent-task start
# 另一个终端：
agent-task status
agent-task restart
```

Ctrl-C 关闭前台启动器及其运行进程。`restart` 和 Web 的“重启并检查可用性”使用同一启动器：先停止新派发、关闭活动执行并释放数据所有权，再用已保存配置创建新进程。

只有新实例通过带 MCP token 的健康检查才返回成功，并给出新实例标识及地址。端口变化或自动分配端口时，以返回地址为准；Web 不通过链接传递管理员令牌，须重新连接。

重启会关闭 ACP 会话，不保证等待人工回复的运行能无损继续。结果不明的执行保持阻断，不自动重试、重放或改派执行端。请求超时不代表重启没发生，先用 `agent-task status` 核对；不要盲目重复操作。

启动失败不会回滚配置或重放工作。查看当前 `dataDir/service.log`；确认没有运行实例持有数据后，修正私有文件，再显式 `agent-task restart`。启动器也已退出时，用原启动方式重新启动。

源码开发者执行 `npm ci --ignore-scripts && npm run build` 后，可用 `npm run setup -- ...` 和 `npm start -- --home ...`；npm 安装用户不需要构建。内部 `dist/application/main.js` 不是独立的重启入口。

## 更新

重复 setup 保留配置和授权。中断安装只能显式执行 `agent-task setup --resume`；所有权或清单不明时停止核查。

更新前停止运行进程，并备份安装目录和当前数据目录。调研阶段不保证旧数据兼容，普通启动不执行迁移。
