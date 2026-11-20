// Postgres 轉接（選用）：設了 DATABASE_URL 才會載入。包成跟 db-node.js、db-d1.js 一樣的非同步介面（get／all／run／batch），
// 業務程式照寫 SQLite 的 SQL，這裡用 sql-pg.js 轉成 Postgres 寫法。需要 pg 套件：只有用 Postgres 才要 npm install。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listMigrations, planMigrations, versionOf, TRACK_SQL, MigrationError } from './migrations.js';
import { queryToPg, ddlToPg, NOCASE_COLLATION } from './sql-pg.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
const SCHEMA_FILE = new URL('./schema.sql', import.meta.url);
const LOCK_ID = 4_236_900; // 同時啟動兩個程式時，只讓一個做資料庫升級

async function loadPg() {
  try { return (await import('pg')).default; }
  catch (e) {
    if (e?.code === 'ERR_MODULE_NOT_FOUND') throw new Error('設了 DATABASE_URL 要先安裝 Postgres 套件：在程式資料夾執行 npm install（只用 SQLite 不用裝）');
    throw e;
  }
}

// 連線字串去掉密碼，給啟動訊息與錯誤訊息用
export function describeUrl(url) {
  try { const u = new URL(url); return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`; } catch { return '（網址格式不對）'; }
}

// Postgres 回傳的型別換成跟 node:sqlite 一樣：bigint／numeric → Number、boolean → 1／0、bytea → Uint8Array
function typesFor(pg) {
  const num = v => (v === null ? null : Number(v));
  return {
    getTypeParser(oid, format) {
      if (oid === 20 || oid === 1700) return num;
      if (oid === 16) return v => (v === 't' ? 1 : 0);
      const base = pg.types.getTypeParser(oid, format);
      if (oid === 17) return v => { const b = base(v); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
      return base;
    },
  };
}

// 轉好的 SQL 放快取（業務程式的 SQL 幾乎都是固定字串）
const cache = new Map();
function translate(sql) {
  let t = cache.get(sql);
  if (!t) {
    if (cache.size > 5000) cache.clear();
    t = queryToPg(sql);
    cache.set(sql, t);
  }
  return t;
}
function toQuery(sql, args) {
  const t = translate(sql);
  const values = args.map((v, i) => {
    if (t.arrays.includes(i)) return typeof v === 'string' ? JSON.parse(v) : v; // json_each(?) 收的是 JSON 字串
    if (typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v)) return Math.round(v); // 資料表沒有小數欄位（都是毫秒、次數）；SQLite 會默默存成小數，Postgres 的 BIGINT 不收
    return v === undefined ? null : v;
  });
  return { text: t.text, values };
}
const clean = rows => { for (const r of rows) if ('rowid' in r) delete r.rowid; return rows; }; // 隱藏的流水號不外露（SQLite 的 * 也不含 rowid）

// 測試用：只准連本機或 CI 的 postgres 服務，其他（含任何雲端、正式庫）一律拒絕
export function assertTestPgUrl(url) {
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error('AIGILE_TEST_PG_URL 格式不對（要像 postgres://postgres:test@127.0.0.1:5432/aigile_test）'); }
  if (!['localhost', '127.0.0.1', '[::1]', '::1', 'postgres'].includes(host)) throw new Error(`測試只准連本機或 CI 的 Postgres（localhost、127.0.0.1、postgres），不連 ${host}`);
  return url;
}
// 測試用：同一個資料夾＝同一個 schema（伺服器重開資料還在），不同資料夾互不影響
export const testSchemaFor = dir => 't_' + createHash('sha256').update(path.resolve(dir)).digest('hex').slice(0, 20);

// 依環境變數決定用不用 Postgres：DATABASE_URL（正式）＞ AIGILE_TEST_PG_URL（測試，只准本機，每個資料夾一個 schema）＞ 不用（SQLite）
export function pgTarget(env, dataDir) {
  if (env.DATABASE_URL) {
    if (!/^postgres(ql)?:\/\//i.test(env.DATABASE_URL)) throw new Error('DATABASE_URL 要是 postgres:// 開頭（目前只支援 Postgres；不設就用 SQLite）');
    return { url: env.DATABASE_URL, schema: env.DATABASE_SCHEMA || undefined, test: false };
  }
  if (env.AIGILE_TEST_PG_URL) return { url: assertTestPgUrl(env.AIGILE_TEST_PG_URL), schema: testSchemaFor(dataDir), test: true };
  return null;
}

export async function openPgDb(url, { legacyProjects = true, max, schema } = {}) {
  const pg = await loadPg();
  if (schema) { // 指定 schema（DATABASE_SCHEMA）：沒有就建，之後所有表都放在裡面
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) throw new Error(`DATABASE_SCHEMA 只能用英文字母、數字、底線：${schema}`);
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try { await c.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`); } finally { await c.end(); }
  }
  const pool = new pg.Pool({ connectionString: url, max: max ?? (Number(process.env.PG_POOL_MAX) || 10), types: typesFor(pg), ...(schema ? { options: `-c search_path="${schema}"` } : {}) });
  pool.on('error', e => console.error(`Postgres 連線中斷（${describeUrl(url)}）：${e.message}`)); // 閒置連線斷掉不讓整個程式掛掉
  try {
    const up = await migratePg(pool, { schema: fs.readFileSync(SCHEMA_FILE, 'utf8'), dir: MIGRATIONS_DIR });
    if (up.applied.length) console.log(`資料庫升級：套用 ${up.applied.join('、')}（目前版本 ${up.version}）`);
    if (legacyProjects) await pool.query("INSERT INTO projects (id, name, archived, created_at) VALUES ('預設專案', '預設專案', 0, '2026-01-01T00:00:00.000Z'), ('第二專案', '第二專案', 0, '2026-01-01T00:00:01.000Z') ON CONFLICT DO NOTHING");
    await pool.query('UPDATE participants SET token_expires_at = $1 WHERE token_expires_at = 0', [Date.now() + 24 * 3600_000]); // 同 db-node.js 的 startupFixes
  } catch (e) { await pool.end().catch(() => {}); throw e; }

  const q = (client, sql, args) => client.query(toQuery(sql, args));
  return {
    kind: 'postgres',
    async get(sql, ...args) { return clean((await q(pool, sql, args)).rows)[0] ?? null; },
    async all(sql, ...args) { return clean((await q(pool, sql, args)).rows); },
    async run(sql, ...args) { return { changes: (await q(pool, sql, args)).rowCount ?? 0 }; },
    async batch(stmts) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        for (const [sql, args] of stmts) await q(c, sql, args);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      finally { c.release(); }
    },
    // 自動編號（IDENTITY）接到目前最大號之後：備份匯入、搬家這種明寫流水號的寫入完要呼叫（SQLite 會自己接）
    async syncIds() {
      const cols = (await pool.query("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND is_identity = 'YES' AND identity_generation = 'BY DEFAULT'")).rows;
      for (const { t, c } of cols) await pool.query(`SELECT setval(pg_get_serial_sequence(quote_ident(current_schema()) || '.' || quote_ident($1), $2), COALESCE((SELECT MAX("${c}") FROM "${t}"), 0) + 1, false)`, [t, c]);
    },
    close() { return pool.end(); },
  };
}

// 升級檔：migrations/NNN_x.sql 自動轉成 Postgres 寫法；轉不過去的寫一份同名的 migrations/pg/NNN_x.sql 取代
export function pgMigrationSql(file, dir = MIGRATIONS_DIR) {
  const own = path.join(dir, 'pg', file.name);
  return fs.existsSync(own) ? fs.readFileSync(own, 'utf8') : ddlToPg(file.sql);
}

// 跟 migrateNode 同樣的規則（全新的站直接建最新結構；舊站照編號套），整個在一個交易裡，失敗全部回復
export async function migratePg(pool, { schema, dir }) {
  const c = await pool.connect();
  const now = new Date().toISOString();
  let current = null;
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await c.query(NOCASE_COLLATION);
    const fresh = !(await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'participants'")).rowCount;
    await c.query(ddlToPg(TRACK_SQL));
    const applied = (await c.query('SELECT name FROM schema_migrations')).rows.map(r => r.name);
    const files = listMigrations(dir);
    const plan = planMigrations({ fresh, applied, files });
    if (plan.unknown.length) throw new MigrationError(`資料庫已經套過這版程式沒有的升級（${plan.unknown.join('、')}）：可能是用比較舊的程式開了新版的資料庫。請換回新版程式再啟動，或從備份還原。`);
    if (plan.fresh) {
      current = 'schema.sql';
      await c.query(ddlToPg(schema));
      for (const n of plan.mark) await c.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [n, now]);
    } else {
      for (const f of plan.apply) {
        current = f.name;
        await c.query(pgMigrationSql(f, dir));
        await c.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [f.name, now]);
      }
      current = 'schema.sql';
      await c.query(ddlToPg(schema)); // 補新的表與索引（全部 IF NOT EXISTS）
    }
    await c.query('COMMIT');
    return plan.fresh
      ? { fresh: true, applied: [], version: versionOf(plan.mark) }
      : { fresh: false, applied: plan.apply.map(f => f.name), version: versionOf([...applied, ...plan.apply.map(f => f.name)]) };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    if (e instanceof MigrationError) throw e;
    throw new MigrationError(current === null ? `連不上 Postgres 或沒有權限建表：${e.message}`
      : `資料庫升級失敗：${current === 'schema.sql' ? '建立資料表' : 'migrations/' + current}：${e.message}。已經整個回復，資料庫停在上一版；修好之前不要啟動（請把這段訊息附在問題回報）。`);
  } finally { c.release(); }
}
