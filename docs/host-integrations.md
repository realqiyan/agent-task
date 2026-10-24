# Pi、Claude Code 与 Codex 接入包

**先安装接入包，再由 `using-agent-task` 引导安装、初始化和使用服务。** 插件名仍为 `agent-task`。skill 只指导使用现有 CLI/MCP，不增加任务 API、执行器或业务规则。

入口：[共享包](../hosts/agent-task/)、[使用引导](../hosts/agent-task/skills/using-agent-task/SKILL.md)、[Claude marketplace](../.claude-plugin/marketplace.json)、[Codex marketplace](../.agents/plugins/marketplace.json)。

Agent Task 支持 Linux/macOS、Node.js 22.19+ 与 npm。Pi 需要 1.4.0+ 的原生 MCP；Claude Code 需要插件支持；Codex CLI 需要 `plugin marketplace add` 和 `plugin add`。不承诺 Codex IDE、云端或其他同名插件系统可用。核验版本与限制见[验证说明](validation.md#宿主接入包)。

## 不预装服务的本地入口

当前源码可直接安装接入包，**不需要先执行服务的 `npm ci`、build、link 或 setup**。在包含本次接入资产的仓库根目录设置：

```bash
AGENT_TASK_SOURCE="$(pwd -P)"
```

然后只执行对应宿主的安装命令。保留被引用的本地目录；接入包与服务安装目录是两个概念。

### Pi

```bash
pi install "$AGENT_TASK_SOURCE/hosts/agent-task"
```

启动 Pi（已有会话先 `/reload`），调用 `/skill:using-agent-task`。Pi package 安装 skill 和只读启动检查扩展，首次引导会在 setup 完成并取得确认后，执行原生 `pi mcp add` 注册连接。已有同名连接时先核对，不盲目替换。需要项目作用域时，分别为 package 安装和 MCP 注册选择 `--local` 并审查项目信任设置。

### Claude Code

```bash
claude plugin marketplace add "$AGENT_TASK_SOURCE"
claude plugin install agent-task@agent-task --scope user
```

在新会话调用 `/agent-task:using-agent-task`。插件已声明 `agent-task mcp`，不要重复执行 `claude mcp add`。服务未安装或 setup 未完成时，MCP 连接失败是预期行为，不妨碍使用引导。初始化后重开会话或在 `/mcp` 重连。

### Codex CLI

```bash
codex plugin marketplace add "$AGENT_TASK_SOURCE"
codex plugin add agent-task@agent-task
```

在新会话调用 `$using-agent-task`，或在 `/skills` 中选择它。支持原生 onboarding 的界面也指向同一 skill。插件已声明 `agent-task mcp`，不要重复执行 `codex mcp add`。初始化后开新会话，在 `/mcp` 检查连接；`codex mcp list` 的静态配置输出本身不证明连接成功。

安装接入资产不需要服务凭据；让宿主模型执行 skill 仍需宿主自身的模型认证。

## 分发入口与发布边界

独立轻量 npm 包名为 `@realqiyan/agent-task-hosts`，不依赖服务或 SDK，也没有 npm 安装 hook。Pi 可直接使用：

```bash
pi install npm:@realqiyan/agent-task-hosts
```

Claude Code/Codex 可将上文 marketplace add 参数替换为 `realqiyan/agent-task`，无需预装服务或克隆源码。

npm 接入包和远端 marketplace 已提供；适用版本及安装验收见[验证说明](validation.md#宿主接入包)。独立包的打包、发布要求见[发布说明](release.md#独立接入包)。包含接入资产的服务 npm 发行版仍可提供同一目录，已安装服务的用户可将 `AGENT_TASK_SOURCE` 设为 `$(npm root -g)/@realqiyan/agent-task`；这不是首次接入的前提。

## 启动提醒与检查边界

接入包的检查独立于 MCP 连接：Pi 在会话启动时显示通知并加入简短模型上下文；Claude Code/Codex 的同步 `SessionStart` hook 返回用户可见的 `systemMessage` 和模型上下文。异常提示给出对应的 `using-agent-task` 入口，状态正常时保持安静；不会自动调用模型或执行安装。

检查复用服务的 `agent-task setup --check --json`，不解析私有配置。该服务命令只在自己的进程内校验初始化和凭据文件，返回不含路径、密钥或原始异常的摘要；不创建目录/SQLite 锁、不修复文件、不启动服务、联网或发现执行端。检查有时间与输出限制，失败不会阻塞整个宿主会话。未安装、初始化未完成、配置异常、协调模型未配置和检查本身失败分别提示；无法启动命令也可能是 PATH 或 Node 问题，不等于应当重装。

这是安装状态检查，**不是实时 MCP 健康检查**。后台停止不等于未初始化；端口冲突、执行端准备和连接错误仍需查看宿主 MCP 状态。服务 MCP 启动失败的 stderr 也附带 skill 入口，但 stderr 不保证直接展示给用户。对不支持此只读命令的服务版本只报告检查失败，不回退到可能写锁的旧检查路径。

检查默认使用宿主 PATH 的 `agent-task` 和默认 home。自定义 MCP 命令/home 时，在启动宿主的环境中同步设置以下非敏感变量：

```bash
export AGENT_TASK_PREFLIGHT_COMMAND=/absolute/bin/agent-task
export AGENT_TASK_PREFLIGHT_HOME=/absolute/private/agent-task
```

这些变量**只选择检查目标，不修改 MCP 连接**，也不推断或改写宿主配置。已关闭插件 MCP、改用远程连接或不需要此提示时，可在宿主原生设置中禁用该 hook/扩展，保留 skill。

Codex 插件 hook 必须先在 `/hooks` 中审查并信任；安装插件不自动授权 hook。Claude Code/Pi 也须允许插件 hook/扩展运行。禁用、未信任或 Node 无法启动时，不能保证出现自定义提示，仍可显式调用上述 skill。不要通过绕过信任或扩大权限来消除提示。程序入口见 [preflight](../hosts/agent-task/scripts/preflight.mjs)、[Pi 扩展](../hosts/agent-task/pi-extension.js)、[hook 入口](../hosts/agent-task/scripts/session-start.mjs)。

## 引导如何安装服务

调用 skill 后先检查已有命令、Node/npm、安装目录和连接配置。服务确实缺失时，宿主说明安装影响，取得用户确认，然后通过自身 shell 工具执行：

```bash
npm install -g @realqiyan/agent-task
```

这不是安装插件时静默执行，也不是每次连接运行 `npx`。已有安装不自动升级，PATH 问题不重复安装；权限不足时停止并给出用户终端操作，不使用 sudo 或扩大宿主权限。

随后引导用户在自己的终端执行 `agent-task setup`，让凭据通过隐藏输入收集。用户明确选择非交互初始化时，可由宿主执行已确认的参数和私有凭据文件方式，但不将秘密放入会话或命令参数。setup 和执行端准备的服务规则由[部署说明](deployment.md)维护。

## 使用与验收

引导按需读取包内参考文件，复制到插件缓存或独立安装后不依赖仓库文档：

- [安装与连接](../hosts/agent-task/skills/using-agent-task/references/installation.md)：setup、原生 MCP 注册、自定义 home/绝对命令路径和连接验证。
- [日常使用](../hosts/agent-task/skills/using-agent-task/references/tasks.md)：通过现有 MCP 提交固定 DAG、查看运行与交付、回答事实问题、区分未来触发控制和当前运行取消。
- [排障](../hosts/agent-task/skills/using-agent-task/references/troubleshooting.md)：区分安装、连接、配置、适配器准备和执行结果不明，不盲目重试。

安装验收只需宿主显示已连接，并成功调用 `executor_list({})`、`task_list({})`。Pi 默认通过原生 codemode/tool search 发现工具；使用实际宿主命名空间。不为验收创建任务或执行付费模型/领域工作。连接成功、执行端 ready、原生授权和真实交付是不同证据。

创建任务建议明确给出目标项目的绝对 `workspace`，不把插件缓存目录当成工作目录。MCP token 不写入插件配置，事实回复不授予权限。自定义 home 时，setup、MCP 和后续 CLI 命令必须使用同一目录；Claude/Codex 先禁用插件自带 MCP 项再添加手工连接，不能同时保留两条有效连接。

## 更新与移除

接入包与服务使用同一项目版本，但分别安装。接入包更新不升级服务、不执行 setup、不迁移数据；更新服务前按[部署说明](deployment.md#数据目录与管理)停服并备份。使用宿主原生 package/marketplace 更新入口刷新接入资产，再重开会话。

- Pi 本地安装：`pi remove "$AGENT_TASK_SOURCE/hosts/agent-task"`；npm 安装：`pi remove npm:@realqiyan/agent-task-hosts`。另用 `pi mcp remove agent-task` 移除引导注册的 MCP 连接。
- Claude Code：`claude plugin uninstall agent-task@agent-task`。
- Codex：`codex plugin remove agent-task@agent-task`。
- 另行添加的手工 MCP 连接需单独移除。

宿主退出或卸载插件不停止已提交任务。`agent-task status` 查看共享后台，`agent-task stop` 显式停止；先核对活动工作，自定义安装附加相同 `--home`。卸载接入包不删除服务、历史、工作空间或原生执行端配置。

## 原生机制依据

- Pi：[packages](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md)、[MCP](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/mcp.md)。
- Claude Code：[marketplace](https://code.claude.com/docs/en/plugin-marketplaces)、[插件清单](https://code.claude.com/docs/en/plugins-reference)。
- Codex：[插件包与 marketplace](https://developers.openai.com/plugins/build/plugins)。使用已核验 CLI 支持的 `.codex-plugin/plugin.json`，不依赖 Claude 清单回退。
