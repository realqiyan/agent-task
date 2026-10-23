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
npm run test:install -- ./realqiyan-agent-task-0.1.0-rc.1.tgz
```

安装验证先检查当前 OS 和 Node.js 版本，再在独立临时目录执行真正的全局 npm 安装，禁用 lifecycle scripts，不使用项目源码或编译器；随后验证初始化、前台启动、Web 配置、重启和认证健康检查，再验证 stdio 自动启动后台、断开后后台仍可用及显式 stop。MCP 客户端使用安装包的 SDK 依赖。验证脚本不调用模型或启动 ACP 工作。

输出报告只包含结果和证据目录，不包含 token；只将实际运行的宿主平台记为通过，其他平台明确记为未执行。临时目录权限为私有，内有验证专用随机凭据及空任务库，不上传这些目录。基础测试中的真实 PTY 用例先检查平台及 `script` 能否创建终端；能力不可用时明确跳过，不能把跳过当成终端验收通过。

脚本只验证当前环境，不在 Linux 上推断 macOS 行为；需要 macOS 证据时，在相应环境单独运行同一命令。本地可设置 `npm_config_cache` 复用下载缓存，tarball 验证可用 `npm_config_registry` 指定依赖镜像，报告会记录其地址；`--registry` 发布后验收固定使用 npmjs。不能以复制项目的 node_modules 替代安装验证。

npm 接收发布后可能仍在处理包。发布后验收最多等待五分钟，确认公开 `latest` 指向目标版本，再执行默认全局安装；等待只读取 registry。超时先核对版本状态，不重复上传。

## GitHub Actions 门禁与受控发布

- [Validate](../.github/workflows/ci.yml)：PR/master 或手动触发时在 Ubuntu 执行 TypeScript 与依赖边界检查、基础测试及构建；检查包清单。安装任务**不 checkout 项目源码**，只接收 tarball 和验收脚本，在当前 Linux runner 验证启动、重启及认证检查。常规 CI 不再要求 macOS runner；这不代表 macOS 已验证或不受支持。
- [Publish npm](../.github/workflows/publish.yml)：仅手动触发，限制 master 和账号 realqiyan，输入须匹配已验收包版本。再次执行全部门禁，再发布同一 tarball，不重建、不执行包脚本。发布后核查 latest 并执行默认全局安装验证。
- 普通 CI 没有 npm 凭据。发布作业使用 npm Trusted Publisher 和 GitHub OIDC，不读取 `NPM_TOKEN`；并发发布被串行化。

包已发布但后续验收失败时，在同一工作流选择相同版本并启用 `verify_only`。该模式仍执行验证门禁和公开安装验收，跳过上传，适用于 registry 处理延迟后的复核。

首次启用前，由维护者完成以下配置：
1. 创建 GitHub Environment **npm**，仅允许 master 部署；按仓库需要配置审核人。工作流中的 environment 名称本身**不自动创建审核保护**。
2. 在 npm 包的 Trusted Publisher 设置中授权 GitHub 仓库 `realqiyan/agent-task`、工作流 `publish.yml`、Environment `npm`，允许 `npm publish`。认证与 2FA 在 npm 官方界面完成，不上传本机登录凭据。
3. 核查分支保护及工作流修改权限，再在 Actions 选择 Publish npm，输入已验收的版本（本次为 `0.1.0-rc.1`）。认证/权限失败须停止，不能换账号或跳过验证。

发布作业使用 Node 24 与支持 OIDC 的 npm；命令明确传 `--tag latest --access public --provenance`。Trusted Publisher 授权和 provenance 是不同条件，设置工作流不等于 npm 已授权。首次配置和有效期限制以 [npm 官方说明](https://docs.npmjs.com/trusted-publishers/)为准。

## 经授权的本机发布

若由维护者明确批准在本机发布，须先完成同样的候选验收；这条路径没有 GitHub provenance。通过 npm 官方交互登录，不通过聊天、命令参数或 Git 传递 token：

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
# 必须确认输出 realqiyan，再发布已检查的 tarball：
npm publish ./realqiyan-agent-task-0.1.0-rc.1.tgz --ignore-scripts \
  --access public --tag latest --registry=https://registry.npmjs.org
npm view @realqiyan/agent-task@0.1.0-rc.1 version license --registry=https://registry.npmjs.org
npm view @realqiyan/agent-task dist-tags --json --registry=https://registry.npmjs.org
node scripts/verify-install.mjs --registry
```

登录成功不等于发布授权已完成。若 registry 返回需要 2FA 的 E403，停止发布；维护者须在自己的终端完成发布时认证，或配置有目标包发布权限、短有效期且获准 bypass 2FA 的 granular token。不要关闭账号 2FA，不在聊天、命令参数或日志中传递一次性验证码或 token；不把本机登录凭据自动上传到 GitHub。

不得把 dry-run、上传成功提示或候选包安装当成 npmjs 完成证据。应记录 registry 版本与 latest、默认安装结果、各平台报告，以及未执行的检查。发布结果不明时先查询 registry；同一版本不可覆盖，不盲目重试，也不擅自换版本。

已发布候选有问题时，停止继续安装验证，保留证据并通知维护者决定弃用提示、tag 调整或新版本。不自动撤包、覆盖历史或删除用户数据。
