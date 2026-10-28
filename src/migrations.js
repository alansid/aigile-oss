// 資料庫升級：以 1.0 的 src/schema.sql 為基準，之後改資料表就在 migrations/ 新增一個「NNN_說明.sql」（001 起編號，只增不改），
// 同時把 src/schema.sql 改成最新的完整結構。已經套過的升級記在 schema_migrations 表。
// - 全新的站：直接用最新的 schema.sql 建表，現有升級全部標成「已套過」（schema.sql 已經包含它們）
// - 舊站：照編號套還沒套過的，每個一個交易；失敗就回復、丟出 MigrationError（說哪個檔、什麼錯），不帶著壞資料啟動
// Docker／本機（node:sqlite）用 migrateNode；Cloudflare D1 用 scripts/migrate.js（同一份 planMigrations）
import fs from 'node:fs';
import path from 'node:path';

export const MIGRATION_RE = /^(\d{3,})_[a-z0-9_-]+\.sql$/;
export const TRACK_SQL = 'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)';
export class MigrationError extends Error { name = 'MigrationError'; }

// 讀 migrations/ 底下的升級檔（照編號排）；檔名不合規則或編號重複就停
export function listMigrations(dir) {
  if (!fs.existsSync(dir)) return [];
  const names = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const seen = new Map();
  return names.map(name => {
    const m = MIGRATION_RE.exec(name);
    if (!m) throw new MigrationError(`升級檔名稱不對：migrations/${name}（要像 001_add_column.sql：三位數編號、底線、英文小寫說明）`);
    if (seen.has(m[1])) throw new MigrationError(`升級檔編號重複：migrations/${seen.get(m[1])} 和 migrations/${name}`);
    seen.set(m[1], name);
    return { name, sql: fs.readFileSync(path.join(dir, name), 'utf8') };
  });
}

// 目前版本＝套過的最大編號（沒有＝0，就是 1.0 的結構）
export const versionOf = names => names.reduce((v, n) => Math.max(v, Number(MIGRATION_RE.exec(n)?.[1] || 0)), 0);

// 純函式：決定要做什麼。fresh＝資料庫還沒有任何表；applied＝已套過的檔名；files＝程式附的升級檔
export function planMigrations({ fresh, applied = [], files = [] }) {
  if (fresh) return { fresh: true, apply: [], mark: files.map(f => f.name), unknown: [] };
  const have = new Set(files.map(f => f.name)), done = new Set(applied);
  return { fresh: false, apply: files.filter(f => !done.has(f.name)), mark: [], unknown: applied.filter(n => !have.has(n)) };
}

const unknownMsg = list => `資料庫已經套過這版程式沒有的升級（${list.join('、')}）：可能是用比較舊的程式開了新版的資料庫。請換回新版程式再啟動，或從備份還原。`;
const failMsg = (name, e) => `資料庫升級失敗：migrations/${name}：${e.message}。這個升級已經整個回復，資料庫停在上一版；修好之前不要啟動（請把這段訊息附在問題回報）。`;

// node:sqlite（Docker、本機）：啟動時呼叫。回傳 { fresh, applied, version }
export function migrateNode(db, { schema, dir }) {
  const fresh = !db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'participants'").get();
  const files = listMigrations(dir);
  db.exec(TRACK_SQL);
  const applied = db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name);
  const plan = planMigrations({ fresh, applied, files });
  if (plan.unknown.length) throw new MigrationError(unknownMsg(plan.unknown));
  const now = new Date().toISOString();
  if (plan.fresh) {
    db.exec('BEGIN');
    try {
      db.exec(schema);
      const ins = db.prepare('INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)');
      for (const n of plan.mark) ins.run(n, now);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw new MigrationError(`建立資料表失敗：${e.message}`); }
    return { fresh: true, applied: [], version: versionOf(plan.mark) };
  }
  for (const f of plan.apply) {
    db.exec('BEGIN');
    try {
      db.exec(f.sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f.name, now);
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw new MigrationError(failMsg(f.name, e)); }
  }
  db.exec(schema); // 補新的表與索引（全部 IF NOT EXISTS，不動既有的表）
  return { fresh: false, applied: plan.apply.map(f => f.name), version: versionOf([...applied, ...plan.apply.map(f => f.name)]) };
}
