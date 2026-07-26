# 数据库迁移

## 编号规则：只增不回填

迁移由 `Database.ts` 的 `runMigrations` 按**文件名排序**执行，已执行的版本记录在
`_migrations` 表里并跳过。这意味着编号一旦发布就不能再插队。

新增迁移时：

1. 编号取当前最大值 + 1（三位数零填充，如 `028_xxx.sql`）。
2. 同步上调 `src/main/db/migrations.contract.test.ts` 里的
   `HIGHEST_RELEASED_MIGRATION`。

**不要回填历史空洞。** 现有序列缺 `007`（从未存在过）。如果现在补一个
`007_xxx.sql`：

- 已升级到 v0.5 的老库里，`_migrations` 已有 008–027，新文件排在它们**之后**执行；
- 全新安装的库里，新文件按编号排在 008 **之前**执行。

两批用户的 schema 演化顺序就此分叉，后续任何依赖列顺序或中间状态的迁移都会踩坑。
`migrations.contract.test.ts` 会拦住这种改动。

## 每个文件一个事务

`runMigrations` 用 `db.transaction()` 包裹单个文件的 `exec` + 版本登记，因此：

- 单文件内的多条语句要么全成功要么全回滚；
- 不要在迁移文件里自己写 `BEGIN` / `COMMIT`；
- 不要在一个文件里做无法回滚的操作（如 `VACUUM`）。

## 迁移前备份

有待执行迁移且库里已有业务表时，`runMigrations` 会先 `VACUUM INTO` 一份
`recall.db.pre-migration.<时间戳>.bak`。迁移成功后 `pruneMigrationBackups` 只保留
最近 2 份；迁移失败时全部保留，供人工恢复。
