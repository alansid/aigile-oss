// 搬家：把本機版的 SQLite 資料（data/switch.db）整份搬到 Postgres。
// 用法（先停掉伺服器；要先 npm install）：
//   node scripts/sqlite-to-pg.js --from data/switch.db --to postgres://使用者:密碼@主機:5432/資料庫 [--schema 名稱]
//   --to 不給就用 DATABASE_URL；--schema 不給就用 DATABASE_SCHEMA（都沒有＝預設的 public）
// 做的事：
//   1. 檢查來源是這版程式的資料庫結構（升級都套過了；沒有的話先用新版程式開一次 SQLite 版）
//   2. 檢查目標是空的（已經有成員或訊息就停，不會蓋掉別人的資料）
//   3. 在 Postgres 建好資料表，一張一張照原本順序搬（整個在一個交易裡，失敗就全部回復，目標還是空的）
//   4. 校正流水號，最後逐表比對筆數，對不上就回報並以錯誤結束
// 專案文件區的檔案（DATA_DIR/docs）不在資料庫裡，留在原資料夾，伺服器的 DATA_DIR 照舊指到那裡即可。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { listMigrations } from '../src/migrations.js';
import { openPgDb, describeUrl } from '../src/db-pg.js';

const PAGE = 500;
const SKIP = new Set(['sqlite_sequence', 'schema_migrations']); // 升級紀錄由目標自己建；sqlite_sequence 是 SQLite 內部用的

export function parseArgs(argv, env = {}) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };
  const from = opt('--from');
  const to = opt('--to') || env.DATABASE_URL;
  const schema = opt('--schema') || env.DATABASE_SCHEMA || undefined;
  if (!from) throw new Error('要給來源：--from data/switch.db');
  if (!to) throw new Error('要給目標：--to postgres://…（或設 DATABASE_URL）');
  if (!/^postgres(ql)?:\/\//i.test(to)) throw new Error('目標要是 postgres:// 開頭');
  return { from: path.resolve(from), to, schema };
}

const q = name => `"${name.replace(/"/g, '""')}"`;

export async function migrate({ from, to, schema, log = console.log }) {
  if (!fs.existsSync(from)) throw new Error('找不到來源資料庫：' + from);
  const src = new DatabaseSync(from, { readOnly: true });
  try {
    // 1. 來源的結構要是這版程式的
    const tables = src.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name).filter(t => !SKIP.has(t));
    if (!tables.includes('participants')) throw new Error('來源不是 Aigile-Switch 的資料庫（沒有 participants 表）');
    const applied = new Set(tables.length && src.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
      ? src.prepare('SELECT name FROM schema_migrations').all().map(r => r.name) : []);
    const missing = listMigrations(fileURLToPath(new URL('../migrations/', import.meta.url))).map(f => f.name).filter(n => !applied.has(n));
    if (missing.length) throw new Error(`來源還沒套這版的資料庫升級（${missing.join('、')}）：請先用這版程式以 SQLite 啟動一次（npm start），停掉後再搬`);

    // 2. 目標要是空的（建表交給 openPgDb：跟伺服器啟動時一樣）
    const pg = (await import('pg')).default;
    const target = await openPgDb(to, { legacyProjects: false, schema, max: 1 });
    await target.close();
    const client = new pg.Client({ connectionString: to, ...(schema ? { options: `-c search_path=${q(schema)}` } : {}) });
    await client.connect();
    try {
      for (const t of ['participants', 'messages', 'cards', 'projects']) {
        const n = Number((await client.query(`SELECT COUNT(*) AS n FROM ${q(t)}`)).rows[0].n);
        if (n) throw new Error(`目標不是空的：${t} 已經有 ${n} 筆。請換一個空的資料庫（或 --schema 換一個新的 schema）`);
      }
      const pgCols = new Map();
      for (const r of (await client.query("SELECT table_name, column_name, is_identity FROM information_schema.columns WHERE table_schema = current_schema() AND column_name <> 'rowid'")).rows) {
        if (!pgCols.has(r.table_name)) pgCols.set(r.table_name, { cols: new Set(), identity: [] });
        pgCols.get(r.table_name).cols.add(r.column_name);
        if (r.is_identity === 'YES') pgCols.get(r.table_name).identity.push(r.column_name);
      }

      // 3. 一個交易搬完
      await client.query('BEGIN');
      const counts = [];
      for (const t of tables) {
        const dest = pgCols.get(t);
        if (!dest) throw new Error(`目標沒有 ${t} 表：來源可能比程式新，請換新版程式再搬`);
        const cols = src.prepare(`PRAGMA table_info(${q(t)})`).all().map(c => c.name);
        const extra = cols.filter(c => !dest.cols.has(c));
        if (extra.length) throw new Error(`目標的 ${t} 表少了欄位：${extra.join('、')}`);
        if (t === 'app_settings') await client.query('DELETE FROM app_settings'); // 建表時寫的預設值，用來源的蓋掉
        let after = -Number.MAX_SAFE_INTEGER, copied = 0;
        for (;;) {
          const rows = src.prepare(`SELECT rowid AS __rowid, * FROM ${q(t)} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`).all(after);
          if (!rows.length) break;
          after = rows[rows.length - 1].__rowid;
          const values = [];
          const tuples = rows.map(r => `(${cols.map(c => { values.push(toPg(r[c])); return '$' + values.length; }).join(', ')})`);
          try {
            await client.query(`INSERT INTO ${q(t)} (${cols.map(q).join(', ')}) VALUES ${tuples.join(', ')}`, values);
          } catch (e) { throw new Error(`搬 ${t} 失敗（第 ${copied + 1}～${copied + rows.length} 筆附近）：${e.message}`); }
          copied += rows.length;
        }
        for (const c of dest.identity) await client.query(`SELECT setval(pg_get_serial_sequence(${pgLit(qualified(schema, t))}, ${pgLit(c)}), COALESCE((SELECT MAX(${q(c)}) FROM ${q(t)}), 0) + 1, false)`);
        counts.push({ table: t, from: Number(src.prepare(`SELECT COUNT(*) AS n FROM ${q(t)}`).get().n), to: Number((await client.query(`SELECT COUNT(*) AS n FROM ${q(t)}`)).rows[0].n) });
      }

      // 4. 筆數對得上才提交
      const bad = counts.filter(c => c.from !== c.to);
      for (const c of counts) log(`${c.from === c.to ? '✓' : '✗'} ${c.table.padEnd(24)} ${String(c.from).padStart(8)} → ${String(c.to).padStart(8)}`);
      if (bad.length) throw new Error(`筆數對不上：${bad.map(c => c.table).join('、')}，已全部回復`);
      await client.query('COMMIT');
      log(`\n完成：${counts.length} 張表、共 ${counts.reduce((s, c) => s + c.to, 0)} 筆搬到 ${describeUrl(to)}${schema ? '（schema ' + schema + '）' : ''}。`);
      return counts;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { await client.end(); }
  } finally { src.close(); }
}

// SQLite 的值換成 Postgres 收得下的：BLOB（Uint8Array）→ Buffer；小數放在整數欄位（SQLite 允許）→ 四捨五入
function toPg(v) {
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v)) return Math.round(v);
  if (typeof v === 'bigint') return v.toString();
  return v;
}
const qualified = (schema, t) => (schema ? `${q(schema)}.${q(t)}` : q(t));
const pgLit = s => `'${String(s).replace(/'/g, "''")}'`;

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    await migrate(parseArgs(process.argv.slice(2), process.env));
  } catch (e) {
    console.error(`\n搬家停止：${e.message}`);
    process.exitCode = 1;
  }
}
