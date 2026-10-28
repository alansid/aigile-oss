// Cloudflare 升級指令（scripts/migrate.js）把 SQL 接成一行送出：行尾的「-- 註解」要拿掉，不然後面的 SQL 全變成註解
// 曾發生：建表 SQL 某個欄位後面的註解讓整段被截斷（部署前發現）
// 只 import 純函式來測，絕不執行 migrate.js 本身（那會連正式庫）
// 用法：node scripts/migrate-test.js
import fs from 'node:fs';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

try {
  const src = fs.readFileSync(new URL('./migrate.js', import.meta.url), 'utf8');
  assert.ok(/export const cleanSql/.test(src) && /fileURLToPath\(import\.meta\.url\) === fs\.realpathSync\(process\.argv\[1\]\)/.test(src), 'migrate.js 被 import 時不會連正式庫');
  const { cleanSql } = await import('./migrate.js');
  // schema.sql 有很多行尾註解：接成一行後建出來的表、欄位要跟直接執行一樣
  const schema = fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');
  assert.ok(/\S\s+--/.test(schema), 'schema.sql 真的有行尾註解（這個測試才有意義）');
  const one = cleanSql(schema);
  assert.ok(!one.includes('--') && !one.includes('\n'), '送出的 SQL 是一行、沒有殘留註解');
  const shape = sql => { const db = new DatabaseSync(':memory:'); db.exec(sql); const t = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all().map(r => r.name); const cols = Object.fromEntries(t.map(n => [n, db.prepare(`PRAGMA table_info(${n})`).all().map(c => c.name).join(',')])); db.close(); return cols; };
  assert.deepEqual(shape(one), shape(schema), '接成一行的 schema 建出完全一樣的表、欄位與索引');
  // 升級檔的寫法：行尾註解也要拿掉
  assert.equal(cleanSql("ALTER TABLE a ADD COLUMN b TEXT; -- 說明\n-- 整行註解\nCREATE INDEX IF NOT EXISTS i ON a (b); -- 再一個"), 'ALTER TABLE a ADD COLUMN b TEXT; CREATE INDEX IF NOT EXISTS i ON a (b);');
  console.log('migrate-test：全部通過');
} catch (e) {
  console.error('migrate-test 失敗：', e.message);
  process.exitCode = 1;
}
