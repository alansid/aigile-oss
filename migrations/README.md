# 資料庫升級檔

以 1.0 的 `src/schema.sql` 為基準。之後改資料表：

1. 在這裡新增 `NNN_說明.sql`（三位數編號、從 001 起、只增不改，例：`001_add_nickname.sql`）
2. 同時把 `src/schema.sql` 改成最新的完整結構（全新的站直接用它建表）

Docker／本機啟動時自動套用沒套過的；Cloudflare 用 `npm run cf:db:migrate`（`npm run deploy` 也會先跑）。已套過的記在資料庫的 `schema_migrations` 表。
