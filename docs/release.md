# npm 发布

npm 包为 [@realqiyan/agent-task](https://www.npmjs.com/package/@realqiyan/agent-task)，发布账号 **realqiyan**，许可证 [MIT](../LICENSE)。候选版有意使用 **latest**，因此默认 `npm install -g @realqiyan/agent-task` 会安装最新候选版；这不表示已达到稳定或生产可用状态。实际完成情况见[验证说明](validation.md#npm-发布候选验证)。

版本、引擎、公开文件和 registry 设置以 [package.json](../package.json) 为准。[打包门禁](../scripts/pack-release.mjs)检查实际包清单；消费者安装不运行构建脚本。不要发布工作目录、私有环境、SQLite、运行日志、模型会话或测试证据。

## 本地候选验收

```bash
npm ci --ignore-scripts
npm run check
npm test
git diff --check
npm run pack:release
VERSION=$(node -p "require('./package.json').version")
npm run test:install -- "./realqiyan-agent-task-$VERSION.tgz"
```

[安装验证](../scripts/verify-install.mjs)在独立临时目录执行真正的全局 npm 安装，禁用 lifecycle scripts，不依赖项目源码或编译器。它检查服务生命周期和认证，不调用模型或启动 ACP 工作；具体检查项以脚本为准。

输出报告只包含结果和证据目录，不包含 token；只将实际运行的宿主平台记为通过，其他平台明确记为未执行。临时目录权限为私有，内有验证专用随机凭据及空任务库，不上传这些目录。基础测试中的真实 PTY 用例先检查平台及 `script` 能否创建终端；能力不可用时明确跳过，不能把跳过当成终端验收通过。

脚本只验证当前环境，不在 Linux 上推断 macOS 行为；需要 macOS 证据时，在相应环境单独运行同一命令。本地可设置 `npm_config_cache` 复用下载缓存，tarball 验证可用 `npm_config_registry` 指定依赖镜像，报告会记录其地址；`--registry` 发布后验收固定使用 npmjs。不能以复制项目的 node_modules 替代安装验证。

npm 接收发布后可能仍在处理包。[发布后验收](../scripts/verify-install.mjs)有限等待公开 `latest` 指向目标版本，再执行默认全局安装；等待只读取 registry。超时先核对版本状态，不重复上传。

## 独立接入包

[轻量包](../plugin/package.json)为 `@realqiyan/agent-task-plugin`，使用同一项目版本，不依赖服务或 SDK，不运行安装脚本。它允许先安装 `using-agent-task`，再经用户确认安装服务；不是服务的替代安装。Claude Code/Codex 的正式 marketplace 也从该 npm 包获取插件；服务发行包不携带插件副本。未发布资产使用[本地快照](host-integrations.md#未发布资产的本地验收)。

```bash
npm run pack:plugin
# 产物：realqiyan-agent-task-plugin-<项目版本>.tgz
```

[独立包门禁](../scripts/pack-plugin.mjs)检查版本、无执行/依赖字段和实际包清单；不需要构建服务。[接入测试](../tests/host-integrations.test.mjs)使用临时目录和空 npm 缓存离线安装真实 tarball。发布前还须通过本文的项目检查，并用对应宿主验收引导发现与连接，不能将 skill 文本当成模型已执行的证据。

CI 分别生成服务与插件候选产物；当前 GitHub 发布工作流只上传服务包，**不会自动发布独立接入包**。接入包需单独授权发布，先核对同名目标版本未占用及 npm 账号/权限，再发布已检查的 `realqiyan-agent-task-plugin-<版本>.tgz`，明确使用 `--ignore-scripts --access public --tag latest --registry=https://registry.npmjs.org`。不要为新包擅自复用服务包的 Trusted Publisher 授权或绕过登录/2FA。发布后核查该包的 registry 版本和 latest，并在隔离宿主配置中验证 `pi install npm:@realqiyan/agent-task-plugin`；实际已发布版本与验收边界见[验证说明](validation.md#宿主接入包)。

插件首次改名不沿用旧包发布权限。发布时先完成全部门禁，在明确授权后发布新插件包并验证公开 registry 与宿主安装，再推送引用它的 marketplace；不要让正式索引指向尚不可下载的版本。服务 tag 的发布流程保持独立。旧包不自动撤销、弃用或重发，宿主配置也不自动迁移。

## GitHub Actions 门禁与受控发布

- [Validate](../.github/workflows/ci.yml)：PR/master 或手动触发时在 Ubuntu 执行 TypeScript 与依赖边界检查、基础测试及构建；检查包清单。安装任务**不 checkout 项目源码**，只接收 tarball 和验收脚本，在当前 Linux runner 验证启动、重启及认证检查。常规 CI 使用 Linux runner，不能据此推断 macOS 验证结果。
- [Publish npm](../.github/workflows/publish.yml)：推送 `v*` tag 自动触发，也保留手动入口；仅账号 realqiyan 可发起或重跑。[发布准入](../scripts/check-release.mjs)要求 tag 与包版本一致、锁文件版本一致，且提交已进入远端 master。手动入口仅接受 master 或版本 tag，输入版本须匹配。通过全部门禁后发布同一 tarball，不重建、不执行包脚本；上传前确认版本未占用，发布后核查 latest 并执行默认全局安装验证。
- 普通 CI 没有 npm 凭据。发布作业使用 npm Trusted Publisher 和 GitHub OIDC，不读取 `NPM_TOKEN`；并发发布被串行化。

### 通过 tag 发布

1. 核对 npm 中目标版本尚未发布。用 `npm version <新版本> --no-git-tag-version --ignore-scripts` 同步包版本和锁文件，并将 `plugin/package.json`、`plugin/.claude-plugin/plugin.json`、`plugin/.codex-plugin/plugin.json` 的版本，以及两个 marketplace 的 npm 来源版本设为同一值；`pack:plugin` 拒绝不一致。完成上述候选验收后，提交并推送到 master。
2. 给已验收的提交打版本 tag，并单独推送该 tag：

```bash
VERSION=$(node -p "require('./package.json').version")
git tag -a "v$VERSION" -m "Release $VERSION"
git push origin "v$VERSION"
```

普通 master 推送只执行 CI，不发布 npm。不要移动或复用已推送的发布 tag；Git tag `v<版本号>` 触发工作流，npm dist-tag `latest` 决定默认安装版本，两者不同。

包已发布但后续验收失败时，在 Actions 手动选择原版本 tag、填写相同版本并启用 `verify_only`。该模式仍执行验证门禁和公开安装验收，跳过上传；不要直接重跑上传作业。安装验收从本地 tarball 读取版本，`--registry` 模式必须提供 `EXPECTED_VERSION`，工作流会自动传入。

首次启用前，由维护者完成以下配置：
1. 创建 GitHub Environment **npm**，只允许 master 分支及 `v*` tag 部署；按仓库需要配置审核人。用 tag ruleset 限制发布 tag 的创建、更新和删除，仅仓库管理员可绕过。工作流中的 environment 名称本身**不自动创建审核保护**。
2. 在 npm 包的 Trusted Publisher 设置中授权 GitHub 仓库 `realqiyan/agent-task`、工作流 `publish.yml`、Environment `npm`，允许 `npm publish`。认证与 2FA 在 npm 官方界面完成，不上传本机登录凭据。
3. 核查 master 与工作流修改权限，再推送版本 tag；需要手动发起时，在 Actions 选择 Publish npm 并输入已验收的版本。认证/权限失败须停止，不能换账号或跳过验证。

发布作业使用 Node 24 与支持 OIDC 的 npm；命令明确传 `--tag latest --access public --provenance`。Trusted Publisher 授权和 provenance 是不同条件，设置工作流不等于 npm 已授权。首次配置和有效期限制以 [npm 官方说明](https://docs.npmjs.com/trusted-publishers/)为准。

## 经授权的本机发布

若由维护者明确批准在本机发布，须先完成同样的候选验收；这条路径没有 GitHub provenance。通过 npm 官方交互登录，不通过聊天、命令参数或 Git 传递 token：

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
# 必须确认输出 realqiyan，再发布已检查的 tarball：
VERSION=$(node -p "require('./package.json').version")
npm publish "./realqiyan-agent-task-$VERSION.tgz" --ignore-scripts \
  --access public --tag latest --registry=https://registry.npmjs.org
npm view "@realqiyan/agent-task@$VERSION" version license --registry=https://registry.npmjs.org
npm view @realqiyan/agent-task dist-tags --json --registry=https://registry.npmjs.org
EXPECTED_VERSION="$VERSION" node scripts/verify-install.mjs --registry
```

登录成功不等于发布授权已完成。若 registry 返回需要 2FA 的 E403，停止发布；维护者须在自己的终端完成发布时认证，或配置有目标包发布权限、短有效期且获准 bypass 2FA 的 granular token。不要关闭账号 2FA，不在聊天、命令参数或日志中传递一次性验证码或 token；不把本机登录凭据自动上传到 GitHub。

不得把 dry-run、上传成功提示或候选包安装当成 npmjs 完成证据。验收结论须有 registry 版本与 latest、默认安装和平台报告作为证据，并注明未执行的检查；按 [AGENTS.md](../AGENTS.md#tests-and-documentation)合并维护，不追加发布经过。发布结果不明时先查询 registry；同一版本不可覆盖，不盲目重试，也不擅自换版本。

已发布候选有问题时，停止继续安装验证，保留证据并通知维护者决定弃用提示、tag 调整或新版本。不自动撤包、覆盖历史或删除用户数据。
