# 数据升级

数据格式基线为 `0.1.0`。服务包升级不修改已有数据格式；存储结构变化通过 `task-conductor migrate` 显式转换。格式使用引入该结构的项目版本，不随每次包发布递增。

## 升级步骤

1. 查询活动协调、ACP 会话和待回答 Run，确认停服影响。停止后台，并保持宿主 MCP 断开，避免自动启动。
2. 备份私有安装目录和数据目录，安装目标服务包。备份包含凭据和任务历史，不能上传或放入 Git。
3. 使用原有 `--home` 检查格式：

   ```bash
   task-conductor migrate --check --home /absolute/private/task-conductor
   ```

4. 检查结果要求迁移时，指定安装目录及数据目录之外的新备份目录并确认：

   ```bash
   task-conductor migrate --home /absolute/private/task-conductor \
     --backup /absolute/private/backups/task-conductor-upgrade --yes
   ```

5. 迁移完成后重新建立 MCP 连接，核对 `task-conductor status` 和 MCP `service_status` 的运行版本，并验证只读查询。

`--check` 不写入数据，也不证明执行时已停服。实际迁移取得安装与数据目录的排他锁，校验源数据，备份并校验副本，再修改并校验目标数据。缺表、损坏、未知格式、目录切换未完成或备份路径冲突时拒绝执行。

## 中断与恢复

迁移记录保存在安装目录的 `migration.json`。备份完成后发生中断时，普通启动拒绝使用未完成的迁移；检查原备份及目录后显式续接：

```bash
task-conductor migrate --resume --yes --home /absolute/private/task-conductor
```

续接使用已记录的备份，不覆盖备份，不重放任务、模型调用或 ACP 工作。备份未完成时，业务数据未修改；保留失败目录，另选新备份目录重试。不要删除迁移记录来绕过启动限制。

备份包含安装目录和数据目录，排除运行锁文件；目录嵌套关系保持在备份中，外置数据目录单独保存为 `data/`。备份保留配置中的原路径，不作为另一套服务直接启动。手工恢复前须停服，并保留当前数据与备份；不能将旧库、会话文件和新库混合使用。

## 支持范围

当前入口校验 `0.1.0` 数据格式，为符合该契约且缺少格式标记的数据库写入标记；已有标记且格式一致时无需转换。不修复缺失的业务表、记录或会话文件，不恢复外部执行。

实现：[迁移入口](../scripts/migrate.mjs)、[业务存储格式与校验](../src/tasks/storage/store.ts)、[协调会话校验](../src/integrations/coordinator/storage.ts)。

后续存储变更须同时提供明确的源与目标格式转换、离线备份和续接支持，以及真实旧格式数据的迁移测试。无法安全转换的变更须在发布前声明限制，不以重新初始化代替迁移。正常启动不承担格式升级，迁移也不改变任务执行授权。
