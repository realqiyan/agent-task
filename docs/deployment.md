# 安装与运行

支持 Linux 和 macOS，要求 Node.js **22.19+** 与 npm。安装包包含运行产物，不需要源码或 TypeScript。本文描述当前实现；已发布版本和平台证据见[验证说明](validation.md)，发布操作见[发布说明](release.md)。

## 安装与初始化

```bash
npm install -g @realqiyan/agent-task
agent-task setup
```

使用当前用户可写的 npm prefix。向导要求确认安装目录、数据目录、端口、令牌配置及协调员 provider；选择 provider 后收集模型和凭据。令牌可以确认后随机生成，也可以从私有 JSON 文件提供。取消确认不写配置，密钥输入不回显。未配置 provider 时仍可管理服务，但不能接收可执行任务。

无终端环境必须明确确认这些初始化选项。例如，私有凭据文件已包含协调员密钥时：

```bash
agent-task setup --home /absolute/private/agent-task \
  --data-dir /absolute/private/agent-task/data --port 8765 \
  --provider deepseek --model deepseek-flash \
  --credentials-file /absolute/private/coordinator.json \
  --generate-tokens --yes
```

此例从文件读取协调员密钥，并生成独立的服务和管理员令牌。已有服务令牌和管理员令牌时，由同一私有文件提供，省略 `--generate-tokens`。不通过命令参数传密钥值。完整选项见 `agent-task setup --help`，凭据文件约束见 [environment.ts](../src/configuration/environment.ts)。

安装目录和数据目录须属于当前用户，使用规范绝对路径和私有权限。setup 输出文件路径，不打印 token。自定义 `--home` 后，后续命令及 MCP 配置使用同一路径。初始化不安装执行 CLI 或 ACP 适配器，不执行原生登录。

## MCP 接入与工作目录

Pi、Claude Code 和 Codex 可使用[可安装接入包](host-integrations.md)先安装使用引导，再经确认安装服务、完成 setup 和宿主配置。以下是其他宿主或手工配置的通用入口。

在宿主的 MCP 配置中添加命令，例如采用 `mcpServers` 格式的宿主：

```json
{
  "mcpServers": {
    "agent-task": {
      "command": "agent-task",
      "args": ["mcp"]
    }
  }
}
```

自定义安装目录时，参数改为 `["mcp", "--home", "/absolute/private/agent-task"]`。宿主找不到命令时，使用已安装 `agent-task` 的绝对路径。配置文件位置和外层结构由宿主决定，本服务不自动修改宿主配置或识别宿主当前项目。

`agent-task mcp` 通过 stdio 接入，自动启动或连接同一安装目录的共用后台，并从私有文件读取内部服务 token。无需先执行 `start`，也无需把端口和 token 复制到 MCP 配置。stdout 仅传输 MCP 消息。

任务显式提供 `workspace` 时使用该目录；省略时使用本次 stdio 进程的启动目录。宿主须从目标项目目录启动命令，或在创建任务时明确传目录。服务不使用共用后台的启动目录猜测项目，也不根据 MCP roots 或宿主名称推断。直接 HTTP 接入需自行携带服务 token，并在 `task_create` 中指定目录。

创建时校验目录存在并规范化，随后固定到任务；周期执行也使用同一目录。需要修改目录时取消旧任务的未来触发，再创建新任务。创建请求按最终目录和 `requestKey` 去重，不同项目可独立使用同一请求键。契约见 [task-contract.ts](../src/protocol/task-contract.ts)，决策原因见[目录来源](adr/0002-mcp-workspace-source.md)与[请求去重](adr/0001-task-request-scope.md)。

## 执行端发现与准备

每次 MCP 连接初始化时，后台从自己的原生 PATH 检测 pi、codex、claude 和 opencode。没有这四种 CLI 且没有就绪的自定义执行端时，拒绝 MCP 连接；CLI/Web 管理入口仍可使用。自定义本机 stdio ACP 可通过[管理员注册入口](cli.md#自定义本机-acp-接入)接入，注册无须重启。安装和认证由对应官方工具负责：[Pi](https://github.com/earendil-works/pi/tree/v1.3.0/packages/coding-agent/docs)、[Codex](https://github.com/openai/codex)、[Claude Code](https://code.claude.com/docs/en/overview)、[OpenCode](https://opencode.ai/docs/)。

发现原生 CLI 后，后台为缺少 ACP 适配器的执行端安装当时最新版，已有安装直接复用；OpenCode 使用原生 ACP 命令。安装在后台进行，可用 MCP `executor_list`、`agent-task executor list` 或 Web 查看准备结果。任务只能选择就绪执行端。适配器安装失败时保留管理入口和其他就绪执行端，修正原因后显式刷新或升级。包映射和安装实现见 [discovery.ts](../src/integrations/acp/discovery.ts)。

适配器保存在安装目录的私有 `adapters/` 中，不修改全局 npm 包或执行 CLI 的原生配置。普通重连不访问 registry 升级已有适配器。显式更新使用 `agent-task executor upgrade codex --yes`，再查询状态；升级期间暂停向该执行端派发新工作，新版本发布成功前保留原安装，活动 ACP 进程不因升级被重启。重新检测和升级直接作用于当前执行端目录，无需重启，也不保存启动配置。OpenCode 通过原生 CLI 的安装渠道更新。命令入口见 [CLI 说明](cli.md#执行端发现与更新)。

后台的原生环境来自启动它的进程，不随不同 MCP 客户端切换。新 CLI 位于已有 PATH 时可用 `executor refresh` 重新检测；PATH 本身变化时先停止后台，再从正确环境连接或启动。原生登录须与后台使用同一 OS 用户及 HOME/配置目录。

就绪只表示启动依赖已准备，不证明原生认证、模型或工具权限可用。服务沿用执行端原生授权，不另设手工批准开关；额外 ACP 审批请求一律拒绝，不自动扩大权限。服务和协调员秘密只从私有环境文件加载。执行端继承用户原生环境前，过滤私有文件变量、服务令牌、协调员凭据及同值别名；不要将执行端原生凭据放入服务的私有文件。过滤实现见 [environment.ts](../src/executors/environment.ts)，它不构成同一用户下的沙箱。

## 后台、前台与健康检查

```bash
agent-task status
agent-task restart
agent-task stop
# 需要前台管理时：
agent-task start
```

stdio 退出只关闭当前连接。由 `mcp` 启动的后台使用独立进程组，宿主关闭或原终端退出后，已提交任务继续调度；没有自动空闲退出。`stop` 显式关闭后台和活动执行。`start` 是前台入口，Ctrl-C 关闭该启动器及其运行进程。

独立后台不保证机器关机、系统清理用户进程或后台自身故障后继续运行，也不配置开机自启。再次启动后读取持久任务；已中断且结果不明的执行保持阻断，不自动重试、重放或改派。

`restart` 与 Web 的重启入口使用同一启动器，应用已保存配置。只有新实例通过带 MCP token 的健康检查才返回成功，并给出实例标识及地址。端口变化时以该地址为准。重启关闭 ACP 会话，不保证等待人工回复的运行能无损继续。请求超时先用 `status` 核对，不盲目重复操作。

服务包升级须完整停止后台、备份、安装，再由宿主重新建立 MCP 连接；仅宿主重连会复用旧后台，仅 `restart` 不更新 launcher 或宿主 stdio 进程。完整操作见[升级引导](../plugin/skills/using-agent-task/references/installation.md#升级已有服务)。`agent-task status` 显示安装、launcher 和服务版本及是否需要重启；MCP `service_status` 显示后台启动版本。缺少版本信息保持未知；同版本覆盖安装不能靠版本号识别。契约见 [CLI](../src/protocol/cli/commands.ts) 和 [MCP](../src/protocol/mcp-contract.ts)。

MCP 接入不会自动重启一个已存在但不可用的后台。故障时查看安装目录的 `launcher.log` 和当前数据目录的 `service.log`；修正私有启动文件后显式重启，启动器已退出时重新连接或运行 `start`。启动失败不会回滚配置或重放工作。

## 数据目录与管理

运行配置、私有环境文件、自定义 ACP 注册、任务和协调会话记录、结果及服务日志位于当前 `dataDir`。安装目录保留 `launch.json` 定位文件、初始化清单、适配器及启动器控制资源。npm 包、项目工作空间和执行端原生配置与数据目录分开。路径实现见 [startup.ts](../src/application/startup.ts)。

Web 访问 `status` 返回地址同源的 `/admin/`，连接与令牌保护见[控制台说明](web-console.md#启用与连接)；命令行管理见 [CLI 说明](cli.md)。两端使用同一管理服务。

修改数据目录后，下次启动只准备目标配置和私有环境，并切换定位文件；不复制任务、会话、结果或日志，不删除旧目录。目标已有不同启动文件时拒绝覆盖，须停服核对并显式准备目标。新目录没有旧任务，目录切换不是恢复或重放许可。

`agent-task setup --check --json`（自定义安装附加相同 `--home`）只读检查初始化状态，不启动后台、不写锁或修复文件。它不验证模型登录、执行端授权或实时 MCP 健康；摘要契约见 [setup](../scripts/setup.mjs)。

重复 setup 保留已有配置。初始化中断后须显式执行 `setup --resume`，它只接续已保存且一致的初始化文件；缺少凭据或所有权不明时停止核查，不猜测修复。更新前停止后台并备份安装目录和数据目录。调研阶段不保证旧配置或数据兼容，普通启动不迁移历史。Task 持续对话与模型请求额度重构后的源码不接受此前业务库或旧 `maxSteps` 契约；试用时使用独立的新安装和数据目录，保留旧目录，不靠删除历史或重放任务修复。

源码开发者执行 `npm ci --ignore-scripts && npm run build` 后，可用 `node bin/agent-task.mjs setup`、`node bin/agent-task.mjs mcp` 或 `npm start -- --home ...`。内部 `dist/application/main.js` 不是独立的重启入口。
