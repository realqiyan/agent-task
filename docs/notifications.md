# 宿主通知

第一版只实现 Pi 的原会话自动跟进。通知结构属于当前 `0.1.0` 初始存储基线，不增加本次开发的格式版本或转换脚本。后续已发布格式变化遵守[升级规则](upgrades.md)。

## 产品行为

任务创建时绑定项目与原会话。插件轮询持久事件，空闲时自动启动模型汇报，忙碌时使用 `triggerTurn: true, deliverAs: "followUp"` 等待当前工作结束；不用 steer 打断。关闭期间事件保留，恢复原会话后补读。新会话、fork 和同项目其他会话不自动接管。

成功、失败、中断、超时、取消、跳过和待回答问题进入通知链路；Cron 每次 Run 分别记录。触发计划耗尽不等于执行成功。通知不授予重试、回答事实问题或补充执行权限；待回答事件是发生时的快照，回复前仍须查询当前问题及期限。

第一版不实现 Claude/Codex 通知、邮件、桌面推送、多渠道配置、纯定时提醒任务或跨会话接管。现有 Claude/Codex 安装检查不变。真实验收边界见[验证说明](validation.md#pi-会话通知)。

## 身份

只用 `projectId + sessionId` 路由，没有第三个接收目标标识。

项目配置为 `.agent-task/project.json`，内容只有 `projectId`。插件首次提交任务时创建，已有配置优先，不因 remote 后来变化而重新计算。它不是秘密，可以选择提交 Git；复制项目后若要独立身份，须显式修改配置。

- 有可用 origin：对完整分组路径和仓库名计算 SHA256，加 `git:` 前缀。例如 SSH/HTTPS 的 `team/app.git` 都取 UTF-8 字符串 `team/app`。不包含主机、认证信息或末尾 `.git`，保留大小写及嵌套分组。
- 无可用 origin：生成并保存 `uuid:` 加 UUID。跨机器使用同一无 remote 项目须同步配置。
- 不支持的 remote 格式拒绝自动初始化，可显式提供项目配置。不同主机的同名仓库故意共享标识；SHA256 不消除这类身份重合。
- 默认 Git 项目取仓库根目录，无 Git 时取 Pi cwd。monorepo 默认共享项目；设置绝对 `AGENT_TASK_PROJECT_ROOT` 可显式选择配置目录。

会话使用 `pi:` 加 Pi 原生会话 ID。默认 UUID 可跨机器使用；自定义 Pi 会话 ID 的唯一性由使用者负责，不得在不同会话复用。通知绑定写入 Pi 会话的自定义记录，恢复复用，fork 通过新的原生 ID 隔离。工作目录仍是服务端执行路径，不是项目身份。

## 启用与运行边界

安装[Pi 接入包](host-integrations.md#pi)，并完成本机服务 setup、MCP 注册。扩展默认处理名为 `agent-task` 的 MCP 服务，仅在 Pi TUI/RPC 的持久会话启用；print、JSON 和内存会话不自动通知。

插件在原生 `tool_call` 中覆盖创建请求的可选 `notification` 字段，模型不应填写该字段。服务将归属与 Task 一起保存，重提不能换绑。没有扩展归属的调用仍可创建任务，但没有会话通知。Pi 在 codemode 中发起的嵌套工具调用也经过原生 tool_call 管线；实际宿主版本须保留该契约。

插件通过本机 `agent-task notifications` 桥接访问已有后台，不读取服务凭据、不自动启动或重启后台。桥接使用服务令牌，独立于管理员控制台是否启用。后端接口为经认证的 `POST /notifications`；第一版没有 MCP 资源订阅或服务端推送。

默认每 5 秒检查，启动/恢复有绑定的会话时立即检查；每批最多 20 条，摘要有界。插件将多个事件合并成一条自定义消息，完整结果仍按需通过 MCP 查询。

自定义配置：

- `AGENT_TASK_PREFLIGHT_COMMAND`、`AGENT_TASK_PREFLIGHT_HOME`：启动检查及通知桥接使用的服务程序/home，必须与 Pi MCP 连接指向同一安装。变量不会修改 MCP 配置。
- `AGENT_TASK_MCP_SERVER`：Pi 中的 MCP 服务名，默认 `agent-task`；不修改其连接地址。
- `AGENT_TASK_NOTIFICATIONS=off`：停用会话通知与自动绑定，保留安装检查和 skill。
- `AGENT_TASK_PROJECT_ROOT`：项目身份配置所在目录，默认规则见上文。

第一版仅支持本机服务接入；不能把通知桥接指向默认本机后台，同时让同名 MCP 指向另一 home 或远程服务。安装资产不自动推断这些连接配置。不匹配时无法保证收到通知。宿主缺少模型或消息启动失败时保留事件；修正模型配置、后续交互或恢复会话后再投递，不通过循环提高预算强行维持运行。

## 可靠性与所有权

业务事件和渠道投递记录分开。Run 的事件由 [TaskRuns](../src/tasks/runs.ts) 产生，与业务状态在同一 SQLite 事务提交；[事件规则与通知服务](../src/tasks/notifications.ts)不执行模型或 ACP。通知读取、领取和确认不改变任务结果。

服务端以项目/会话的短期租约选出活动接收者；正常轮询续租，关闭尝试释放，崩溃后到期接续。确认检查租约、事件归属并原子提交具体事件 ID，不批量推进未展示事件的游标。租约不是用户授权，也不是业务执行准入。

Pi 的 `sendMessage` 没有持久化完成回执，且 message_end 扩展回调先于 SDK 存储写入。因此插件不在这两个时点确认。它读取 Pi 公布的 JSONL 会话格式，确认带本项目/会话和事件 ID 的自定义消息实际写入，并同步文件后才向服务确认。

- 查询或内存 followUp 入队后退出：事件未确认，恢复后补投。
- 消息已保存但服务确认失败：恢复时用会话中的事件 ID 去重并补确认。
- 切换/重载/退出：取消旧请求和定时器；异步结果返回后再次核对实例与会话身份。
- 同一会话内树导航不重新广播已保存通知；fork 的新会话不继承原会话收件箱。

“已投递”只代表消息进入目标会话，不代表模型处理成功或用户已读。模型可能在通知保存后失败，此时用户仍可查历史或主动请求汇报。网络分区、租约过期与旧进程仍存活的极端竞争不承诺 exactly-once；事件身份和会话记录用于去重。通知故障只重试通知，不能重放任务副作用。

## 扩展边界

持久事件保存业务事实，投递记录按事件与渠道确认；第一版只有 session 渠道，不预建邮件发送器、策略平台或动态插件接口。以后邮件/推送增加各自目标和投递状态，不复用会话确认冒充其他渠道成功。

MCP `notifications/resources/updated` 可作为将来的“收件箱有更新”提示，仍复用读取和确认，不替代离线补读。宿主是否支持资源通知、是否能唤醒模型必须分别验收。

集中部署前需增加认证主体与项目授权：projectId/sessionId 均非凭据，不允许仅凭 ID 读取、领取或确认。多用户消费状态也须按认证主体隔离。当前回环地址和单机服务令牌不构成多租户隔离；通知跨机器能力不等于执行端远程执行能力。

## 代码与验证入口

- [通知契约](../src/protocol/notification-contract.ts)、[创建绑定](../src/protocol/mcp.ts)、[本机桥接](../src/application/notification-entry.ts)。
- [Pi 扩展与项目身份/接收回执](../plugin/scripts/notifications.mjs)。
- [业务/HTTP/项目身份测试](../tests/notifications.test.mjs)、[真实 Pi SDK 验收](../tests/pi-notifications.test.mjs)。

原生验收使用已安装的 Pi 包，不下载安装或使用个人凭据：

```bash
npm run build
AGENT_TASK_PI_SDK=/absolute/path/to/pi-coding-agent \
  node --test tests/pi-notifications.test.mjs
```

未提供该路径时，基础测试明确跳过原生 Pi 用例。原生用例只用本机 TCP 连接等待、真实 SDK/后台和真实失败路径，不生成模型成功响应，不证明用户最终看到的汇报质量。
