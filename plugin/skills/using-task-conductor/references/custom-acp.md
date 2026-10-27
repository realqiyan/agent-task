# 接入自定义本机 ACP 执行端

使用管理员 CLI 注册，不使用任务 MCP 工具。注册授权服务启动本机代码；MCP 调用方只能查询并选择就绪 ID，不能注册命令、凭据或端点。Web 复用同一管理服务。

## 先核对范围

1. 确认本机 stdio ACP 可执行文件和非敏感参数。它不是 HTTP/WebSocket 地址、已运行的远程服务或 MCP 服务。服务为每个节点会话启动并持有 ACP 进程。
2. 检查 `task-conductor executor --help` 是否提供 register/unregister。插件和服务独立安装，新技能不证明旧服务支持；缺失时说明版本限制，升级须确认。不虚构 MCP 注册工具或修改私有存储。
3. 确认安装实例，每次命令使用相同 `--home /absolute/private/task-conductor`。用 `task-conductor status` 核查；注册要求后台运行且具有管理员访问。未运行时请用户在另一终端执行 `task-conductor start`，或经明确批准用宿主进程设施启动。此管理步骤不需要内置执行端。
4. 单独准备原生认证及无人值守工具权限。凭据不进入聊天、参数或服务私有环境文件。额外 ACP 权限审批会被拒绝。

执行端须通过 stdin/stdout 使用 ACP，诊断写 stderr，并支持服务采用的协议版本及 initialize/session/prompt 流程。不假设提供客户端终端、任意文件访问、交互登录或额外审批。

## 确认后注册

在用户批准的位置建立无秘密、权限私有的 JSON 文件。示例须替换为实际程序及其文档参数：

```json
{
  "id": "my-acp",
  "command": "/absolute/canonical/path/to/my-acp",
  "args": ["--stdio"],
  "cwd": "/absolute/canonical/path/to/agent-runtime"
}
```

使用已有、规范的可执行文件绝对路径；解析符号链接时不运行该程序。不需要 --stdio 时用 `"args": []`。cwd 可省略，默认任务工作目录；显式设置时须为已有可访问的规范绝对目录，只影响进程启动目录，ACP session/new 仍使用任务 workspace。相对脚本或配置参数会受 cwd 影响，必要时用绝对路径。不会进行 shell 展开，不允许覆盖内置 ID 或已有注册。

说明具体程序、参数、cwd、原生授权和服务实例，确认后执行：

```bash
task-conductor executor register --file /absolute/private/my-acp.json --yes
task-conductor executor show my-acp
```

--yes 只确认已批准的注册，不扩大原生权限。注册检查本机路径，先持久化再开放派发；不启动 ACP、不探测模型、不提交任务。参数是启动配置，不是凭据存储。

**无需重启。** 注册立即可见，同数据目录重启后保留；不打断活动会话或改写任务指派。切换数据目录不复制注册。执行端继承后台过滤后的原生环境，不是执行注册命令的终端环境。改变环境须经确认停止后台，再从目标环境启动；刷新和注册不导入新终端变量。

## 验证和使用

- 用 `task-conductor executor list` 核对 ID 为 ready；这只证明本机启动准备，不证明 ACP 兼容、模型登录或完整工具授权。
- 调用宿主实际 MCP `executor_list({})`。如果此前因无执行端而连接失败，重连 MCP，无需重启后台。
- 通过现有 `task_create` 契约指定节点 executorId，见[任务使用](tasks.md)。不为测试注册而直接提交任务。
- 真实 ACP/模型验收须另行批准有界任务，不能把注册成功报告为任务执行成功。

## 移除或更改

不原地覆盖。不同启动配置优先使用新 ID 与明确批准的新任务，不把已有或不确定工作改派过去。管理员须控制程序和脚本；固定路径不是内容完整性保证或沙箱。

检查受影响工作并取得确认后：

```bash
task-conductor executor unregister my-acp --yes
```

注销立即持久生效，不需重启。它阻止后续通过该 ID 派发，但不终止活动进程、删除历史或改变已有快照；后续续接可能被拒绝。同一 ID 换用不同 command、args 或 cwd 不会重绑旧任务。响应丢失时先查询状态，不删除注册文件、历史或工作目录修复不确定状态。
