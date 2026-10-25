# Pi、Claude Code 与 Codex 接入包

**先安装接入包，再由 `using-agent-task` 引导安装、初始化和使用服务。** 插件名仍为 `agent-task`。skill 只指导使用现有 CLI/MCP，不增加任务 API、执行器或业务规则。

入口：[共享包](../plugin/)、[使用引导](../plugin/skills/using-agent-task/SKILL.md)、[Claude marketplace](../.claude-plugin/marketplace.json)、[Codex marketplace](../.agents/plugins/marketplace.json)。

Agent Task 支持 Linux/macOS、Node.js 22.19+ 与 npm。Pi 需要 1.4.0+ 的原生 MCP；Claude Code 需要插件支持；Codex CLI 需要 `plugin marketplace add` 和 `plugin add`。不承诺 Codex IDE、云端或其他同名插件系统可用。核验版本与限制见[验证说明](validation.md#宿主接入包)。

## 一个仓库、两个 npm 包

服务与插件在同一仓库开发，分别打包。服务包 `@realqiyan/agent-task` 提供 CLI 和运行依赖；插件包 `@realqiyan/agent-task-plugin` 仅包含宿主接入资产，不依赖服务或 SDK，没有 npm 安装 hook。**不要用 `pi install npm:@realqiyan/agent-task` 安装插件。** 服务发行包不再携带插件副本。

源码 marketplace 固定选择已审查的插件包版本，不跟随 npm latest。新包和对应 marketplace 已发布；以下入口的验收版本与限制见[验证说明](validation.md#宿主接入包)。不存在第二个分发仓库。

### Pi

```bash
pi install npm:@realqiyan/agent-task-plugin
```

需要项目作用域时附加 `--local`。启动 Pi（已有会话先 `/reload`），调用 `/skill:using-agent-task`。插件安装 skill、启动检查和 Pi 会话通知扩展；首次引导在 setup 完成并取得确认后用原生 `pi mcp add` 注册连接。MCP 注册的作用域须单独选择，不替换已有同名连接。

### Claude Code

通过清单 URL 获取索引，不克隆服务仓库：

```bash
claude plugin marketplace add https://raw.githubusercontent.com/realqiyan/agent-task/master/.claude-plugin/marketplace.json
claude plugin install agent-task@agent-task --scope user
```

marketplace 的 npm 来源让宿主下载插件包。需要项目级声明时选择 `--scope project`。新会话调用 `/agent-task:using-agent-task`。插件已声明 MCP，不要重复 `claude mcp add`。

### Codex CLI

稀疏检出同仓的索引，然后从 npm 安装插件：

```bash
codex plugin marketplace add realqiyan/agent-task --sparse .agents/plugins
codex plugin add agent-task@agent-task
```

稀疏检出避免展开整个服务源码树，但不承诺完全不下载 Git 元数据或根目录文件。也可使用本地 marketplace 索引目录，无需 Git 克隆。新会话调用 `$using-agent-task`，或在 `/skills` 选择它。原生 onboarding 指向同一 skill；检查提醒需要先在 `/hooks` 中审查信任。

### 服务与项目边界

Claude/Codex 都由宿主通过 npm 获取插件，不是运行 `npm install -g` 后就自动注册。服务未安装或 setup 未完成时 MCP 失败是预期行为，skill 仍可使用；初始化后重开会话或在宿主 MCP 界面重连。`codex mcp list` 的静态配置不是连接成功证据。

插件通过 PATH 调用独立服务 `agent-task mcp`，不运行插件缓存里的服务源码。多个 workspace 的本地插件可共用服务；`--local` 或项目级安装只控制宿主配置，不隔离服务数据。需要独立后台时显式配置不同 `--home`。删除项目插件不删除服务或任务历史。

安装接入资产不需要服务凭据；让模型执行 skill 需要宿主自身的模型认证。引导仍须先取得确认，才能安装服务或改配置。

## 未发布资产的本地验收

不需要服务的 npm ci、build、link 或 setup。仓库根目录执行：

```bash
AGENT_TASK_SOURCE="$(pwd -P)"
pi install "$AGENT_TASK_SOURCE/plugin"

# Claude/Codex：生成只含插件及本地索引的独立临时快照
MARKETPLACE="$(node scripts/create-plugin-marketplace.mjs)"
claude plugin marketplace add "$MARKETPLACE"
claude plugin install agent-task@agent-task-dev --scope user
codex plugin marketplace add "$MARKETPLACE"
codex plugin add agent-task@agent-task-dev
```

只执行需要的宿主命令。生成器不安装依赖、不改宿主配置；本地 marketplace 名为 `agent-task-dev`，与正式源区分。保留快照目录直到移除注册，修改源码后重新生成并更新注册；不要同时启用正式插件与开发插件，以免重复 MCP 连接。根目录的正式 marketplace 指向 npm，直接注册仓库不会加载尚未发布的 `plugin/` 改动。

## Pi 任务通知

当前源码支持 Pi 原会话自动通知：插件绑定项目/会话，轮询后台事件并以 followUp 自动跟进。首次提交会保存项目身份文件；关闭后恢复原会话可补读，不广播给同项目其他会话。适用模式、服务目标配置、禁用方式与可靠性限制见[通知说明](notifications.md)。Claude/Codex 第一版不增加任务通知。

## 启动提醒与检查边界

接入包的检查独立于 MCP 连接：Pi 在会话启动时显示通知并加入简短模型上下文；Claude Code/Codex 的同步 `SessionStart` hook 返回用户可见的 `systemMessage` 和模型上下文。异常提示给出对应的 `using-agent-task` 入口，状态正常时保持安静；不会自动调用模型或执行安装。

检查复用服务的 `agent-task setup --check --json`，不解析私有配置。该服务命令只在自己的进程内校验初始化和凭据文件，返回不含路径、密钥或原始异常的摘要；不创建目录/SQLite 锁、不修复文件、不启动服务、联网或发现执行端。检查有时间与输出限制，失败不会阻塞整个宿主会话。未安装、初始化未完成、配置异常、协调模型未配置和检查本身失败分别提示；无法启动命令也可能是 PATH 或 Node 问题，不等于应当重装。

配置有效后，检查再限时调用 `agent-task status --json`，仅查询已有本机后台，对比安装、launcher 和服务运行版本；不一致时提醒按[升级流程](../plugin/skills/using-agent-task/references/installation.md#升级已有服务)检查活动工作后完整停服重连，版本缺失或检查失败时报告无法确认。两步共享总时限，输出受限，不启动或重启后台。这个附加查询会访问已有本机控制接口及认证健康接口，但不连接宿主 MCP、启动执行端或调用模型。

这是会话启动时的安装与版本检查，**不是持续监控或宿主 MCP 连接验证**。当前会话内升级仍须主动重连验证；同版本覆盖安装不能靠版本号识别。后台停止不等于未初始化；端口冲突、执行端准备和连接错误仍需查看宿主 MCP 状态。服务 MCP 启动失败的 stderr 也附带 skill 入口，但 stderr 不保证直接展示给用户。对不支持此只读命令的服务版本只报告检查失败，不回退到可能写锁的旧检查路径。

检查默认使用宿主 PATH 的 `agent-task` 和默认 home。自定义 MCP 命令/home 时，在启动宿主的环境中同步设置以下非敏感变量：

```bash
export AGENT_TASK_PREFLIGHT_COMMAND=/absolute/bin/agent-task
export AGENT_TASK_PREFLIGHT_HOME=/absolute/private/agent-task
```

这些变量选择检查目标，并供 Pi 通知桥接使用；**不修改 MCP 连接**，也不推断或改写宿主配置。Pi 通知使用的程序/home 必须与 MCP 指向同一服务；详见[通知配置](notifications.md#启用与运行边界)。已关闭插件 MCP、改用远程连接或不需要此提示时，可在宿主原生设置中禁用该 hook/扩展，保留 skill。

Codex 插件 hook 必须先在 `/hooks` 中审查并信任；安装插件不自动授权 hook。Claude Code/Pi 也须允许插件 hook/扩展运行。禁用、未信任或 Node 无法启动时，不能保证出现自定义提示，仍可显式调用上述 skill。不要通过绕过信任或扩大权限来消除提示。程序入口见 [preflight](../plugin/scripts/preflight.mjs)、[Pi 扩展](../plugin/pi-extension.js)、[hook 入口](../plugin/scripts/session-start.mjs)。

## 引导如何安装服务

调用 skill 后先检查已有命令、Node/npm、安装目录和连接配置。服务确实缺失时，宿主说明安装影响，取得用户确认，然后通过自身 shell 工具执行：

```bash
npm install -g @realqiyan/agent-task
```

这不是安装插件时静默执行，也不是每次连接运行 `npx`。已有安装不自动升级，PATH 问题不重复安装；权限不足时停止并给出用户终端操作，不使用 sudo 或扩大宿主权限。

随后引导用户在自己的终端执行 `agent-task setup`，让凭据通过隐藏输入收集。用户明确选择非交互初始化时，可由宿主执行已确认的参数和私有凭据文件方式，但不将秘密放入会话或命令参数。setup 和执行端准备的服务规则由[部署说明](deployment.md)维护。

## 使用与验收

引导按需读取包内参考文件，复制到插件缓存或独立安装后不依赖仓库文档：

- [安装与连接](../plugin/skills/using-agent-task/references/installation.md)：setup、原生 MCP 注册、自定义 home/绝对命令路径和连接验证。
- [自定义 ACP](../plugin/skills/using-agent-task/references/custom-acp.md)：通过管理员 CLI 注册本机 stdio 执行端，无须重启；MCP 只查询和选择执行端。
- [日常使用](../plugin/skills/using-agent-task/references/tasks.md)：通过现有 MCP 提交固定 DAG、查看运行与交付、回答事实问题、区分未来触发控制和当前运行取消。
- [排障](../plugin/skills/using-agent-task/references/troubleshooting.md)：区分安装、连接、配置、适配器准备和执行结果不明，不盲目重试。

安装验收只需宿主显示已连接，并成功调用 `executor_list({})`、`task_list({})`。Pi 默认通过原生 codemode/tool search 发现工具；使用实际宿主命名空间。不为验收创建任务或执行付费模型/领域工作。连接成功、执行端 ready、原生授权和真实交付是不同证据。

创建任务建议明确给出目标项目的绝对 `workspace`，不把插件缓存目录当成工作目录。MCP token 不写入插件配置，事实回复不授予权限。自定义 home 时，setup、MCP 和后续 CLI 命令必须使用同一目录；Claude/Codex 先禁用插件自带 MCP 项再添加手工连接，不能同时保留两条有效连接。

## 更新与移除

接入包与服务使用同一项目版本，但分别安装。正式 marketplace 固定插件版本，更新时须刷新索引再使用宿主的插件更新入口；开发快照不会自动同步源码。接入包更新不升级服务、不执行 setup、不迁移数据；更新服务前按[部署说明](deployment.md#数据目录与管理)停服并备份。使用宿主原生 package/marketplace 更新入口刷新接入资产，再重开会话。

- Pi 本地安装：`pi remove "$AGENT_TASK_SOURCE/plugin"`；npm 安装：`pi remove npm:@realqiyan/agent-task-plugin`。另用 `pi mcp remove agent-task` 移除引导注册的 MCP 连接。
- Claude Code：`claude plugin uninstall agent-task@agent-task`。
- Codex：`codex plugin remove agent-task@agent-task`。
- 本地开发插件使用同一移除命令，但标识为 `agent-task@agent-task-dev`；不再使用时另行移除 `agent-task-dev` marketplace 注册。
- 另行添加的手工 MCP 连接需单独移除。

原先注册旧 npm 插件包的用户须审查后显式移除旧包声明、再安装新包；不要同时加载两份。若误把服务包通过 `pi install` 注册为插件，只移除该 Pi 声明，不自动卸载独立服务或删除数据。

宿主退出或卸载插件不停止已提交任务。`agent-task status` 查看共享后台，`agent-task stop` 显式停止；先核对活动工作，自定义安装附加相同 `--home`。卸载接入包不删除服务、历史、工作空间或原生执行端配置。

## 原生机制依据

- Pi：[packages](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/packages.md)、[MCP](https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/mcp.md)。
- Claude Code：[marketplace](https://code.claude.com/docs/en/plugin-marketplaces)、[插件清单](https://code.claude.com/docs/en/plugins-reference)。
- Codex：[插件包与 marketplace](https://developers.openai.com/plugins/build/plugins)。使用已核验 CLI 支持的 `.codex-plugin/plugin.json`，不依赖 Claude 清单回退。
