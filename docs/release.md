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
npm run test:install -- ./realqiyan-agent-task-0.0.1-rc.2.tgz --service
```

安装验证在独立临时目录执行真正的全局 npm 安装，禁用 lifecycle scripts，不使用项目源码或编译器；再配置、前台启动、调用 Web 配置接口、重启、运行用户服务、进行认证健康检查并卸载。验证脚本不调用模型或启动 ACP 工作。仅 `--service` 会触及真实用户服务管理器，遇到已有同名服务会拒绝，不覆盖其他安装。

输出报告只包含结果和证据目录，不包含 token。临时目录权限为私有，内有验证专用随机凭据及空任务库，不上传这些目录。若只验证前台可省略 `--service`，但不能据此宣称后台已通过。基础测试中的真实 PTY 用例验证交互式向导的确认和取消；仍需人工核查目标终端体验。

在 Linux 和 macOS 分别运行；平台缺失、网络失败或后台启动失败都不能被模板检查替代。平台限制见[部署说明](deployment.md#后台运行)。本地可设置 `npm_config_cache` 复用下载缓存，tarball 验证可用 `npm_config_registry` 指定依赖镜像，报告会记录其地址；`--registry` 发布后验收固定使用 npmjs。不能以复制项目的 node_modules 替代安装验证。

## GitHub Actions 门禁与受控发布

- [Validate](../.github/workflows/ci.yml)：PR/master 或手动触发时执行 TypeScript 检查、基础测试及构建；检查包清单。Linux 和 macOS 安装任务**不 checkout 项目源码**，只接收 tarball 和验收脚本，要求真实服务管理器及认证检查通过。
- [Publish npm](../.github/workflows/publish.yml)：仅手动触发，限制 master 和账号 realqiyan，输入须匹配已验收包版本。再次执行全部门禁，再发布同一 tarball，不重建、不执行包脚本。发布后核查 latest 并执行默认全局安装验证。
- 普通 CI 没有 npm 凭据。发布作业单独获得凭据及 provenance 所需权限。并发发布被串行化。

首次启用前，由仓库管理员创建 GitHub Environment **npm**：
1. 配置必要审核人及仅允许 master 部署。若要禁止发起人自审，需要另一个审核人。
2. 在该 Environment 中添加 **NPM_TOKEN**，使用 realqiyan 的最小发布权限、短有效期 token，允许直接发布（publish and stage），并满足 npm 的 2FA/自动发布策略。不要放入仓库文件或普通 CI 环境。
3. 核查分支保护及工作流修改权限。工作流中的 environment 名称本身**不自动创建审核保护**。
4. 将代码审查后提交到 master，再在 Actions 选择 Publish npm，输入已验收的版本（本次为 `0.0.1-rc.2`）。包尚不存在时，应确认账号允许首次创建此名称；认证/权限失败须停止，不能换账号或跳过验证。

发布命令明确传 `--tag latest --access public --provenance`。provenance 依赖 GitHub OIDC，不代替 npm 发布授权。当前流程要求 Environment token 并检查 `npm whoami` 为 realqiyan；不宣称已经配置 npm trusted publishing。

## 经授权的本机发布

若由维护者明确批准在本机发布，须先完成同样的候选验收；这条路径没有 GitHub provenance。通过 npm 官方交互登录，不通过聊天、命令参数或 Git 传递 token：

```bash
npm login --registry=https://registry.npmjs.org
npm whoami --registry=https://registry.npmjs.org
# 必须确认输出 realqiyan，再发布已检查的 tarball：
npm publish ./realqiyan-agent-task-0.0.1-rc.2.tgz --ignore-scripts \
  --access public --tag latest --registry=https://registry.npmjs.org
npm view @realqiyan/agent-task@0.0.1-rc.2 version license --registry=https://registry.npmjs.org
npm view @realqiyan/agent-task dist-tags --json --registry=https://registry.npmjs.org
node scripts/verify-install.mjs --registry --service
```

登录成功不等于发布授权已完成。若 registry 返回需要 2FA 的 E403，停止发布；维护者须在自己的终端完成发布时认证，或配置有目标包发布权限、短有效期且获准 bypass 2FA 的 granular token。不要关闭账号 2FA，不在聊天、命令参数或日志中传递一次性验证码或 token；不把本机登录凭据自动上传到 GitHub。

不得把 dry-run、上传成功提示或候选包安装当成 npmjs 完成证据。应记录 registry 版本与 latest、默认安装结果、各平台报告，以及未执行的检查。发布结果不明时先查询 registry；同一版本不可覆盖，不盲目重试，也不擅自换版本。

已发布候选有问题时，停止继续安装验证，保留证据并通知维护者决定弃用提示、tag 调整或新版本。不自动撤包、覆盖历史或删除用户数据。
