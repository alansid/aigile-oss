// 本機資料庫轉接：node:sqlite（同步）包成 core.js 需要的非同步介面。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { migrateNode } from './migrations.js';

export function openNodeDb(file, { legacyProjects = true } = {}) { // legacyProjects：測試用，先建「預設專案」「第二專案」（代號固定）
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  // 資料庫升級：全新的站用最新 schema.sql 建表；舊站照編號套 migrations/ 還沒套的（失敗丟 MigrationError，server.js 印出原因後停止）
  const up = migrateNode(db, { schema, dir: fileURLToPath(new URL('../migrations/', import.meta.url)) });
  if (up.applied.length) console.log(`資料庫升級：套用 ${up.applied.join('、')}（目前版本 ${up.version}）`);
  // legacyProjects: false＝全新的站（server.js 沒設 AIGILE_TEST_PROJECTS 時就是這樣）
  if (legacyProjects) db.exec("INSERT OR IGNORE INTO projects (id, name, archived, created_at) VALUES ('預設專案', '預設專案', 0, '2026-01-01T00:00:00.000Z'); INSERT OR IGNORE INTO projects (id, name, archived, created_at) VALUES ('第二專案', '第二專案', 0, '2026-01-01T00:00:01.000Z');");
  startupFixes(db);

  return {
    async get(sql, ...args) { return db.prepare(sql).get(...args) ?? null; },
    async all(sql, ...args) { return db.prepare(sql).all(...args); },
    async run(sql, ...args) { return { changes: Number(db.prepare(sql).run(...args).changes) }; },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        for (const [sql, args] of stmts) db.prepare(sql).run(...args);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close() { db.close(); },
  };
}

// 啟動時的資料維護：token_expires_at＝0（邀請進來的人類建立時）補成 24 小時後
function startupFixes(db) {
  db.prepare('UPDATE participants SET token_expires_at = ? WHERE token_expires_at = 0').run(Date.now() + 24 * 3600_000);
}
