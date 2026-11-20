// 測試共用：開一個資料庫。預設 SQLite（照舊開檔案）；設了 AIGILE_TEST_PG_URL 就改開 Postgres，
// 同一個檔案路徑對到同一個 schema（重開資料還在），不同路徑互不影響。
// 安全：AIGILE_TEST_PG_URL 只准本機（localhost、127.0.0.1）或 CI 的 postgres 服務，其他一律拒跑，絕不連正式庫。
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openNodeDb } from '../src/db-node.js';

export const TEST_PG_URL = process.env.AIGILE_TEST_PG_URL || '';

export async function openTestDb(file, opts = {}) {
  if (!TEST_PG_URL) return openNodeDb(file, opts);
  const { openPgDb, assertTestPgUrl, testSchemaFor } = await import('../src/db-pg.js');
  // 伺服器用 DATA_DIR 決定 schema；測試直接開的 <DATA_DIR>/switch.db 也用同一個資料夾，兩邊才會看到同一份資料。
  // 其他檔名（同一個資料夾開好幾個庫）各用自己的路徑
  const key = path.basename(file) === 'switch.db' ? path.dirname(file) : file;
  return openPgDb(assertTestPgUrl(TEST_PG_URL), { ...opts, schema: testSchemaFor(key), max: 4 });
}

// 資料庫裡的資料表名稱（SQLite 查 sqlite_master、Postgres 查 information_schema）
export async function tableNames(db) {
  const rows = TEST_PG_URL
    ? await db.all('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()')
    : await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  return rows.map(r => r.name);
}

// 測試直接改伺服器（server.js）的資料：例如把時間改成過去。SQLite 直接開檔（不跑升級、不加專案），
// Postgres 開同一個 schema。介面跟 openTestDb 一樣（get／all／run 都是非同步），用完 await close()
export async function peekTestDb(file) {
  if (TEST_PG_URL) return openTestDb(file, { legacyProjects: false });
  const db = new DatabaseSync(file);
  return {
    async get(sql, ...args) { return db.prepare(sql).get(...args) ?? null; },
    async all(sql, ...args) { return db.prepare(sql).all(...args); },
    async run(sql, ...args) { return { changes: Number(db.prepare(sql).run(...args).changes) }; },
    async close() { db.close(); },
  };
}
