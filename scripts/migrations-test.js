// 資料庫升級機制：以 1.0 的 schema.sql 為基準，migrations/NNN_*.sql 依序套用、記在 schema_migrations
// 1. 全新站：直接建最新結構，現有升級標成已套（不重跑）
// 2. 從 1.0 升到新版：照編號套沒套過的，資料保留
// 3. 重複啟動不重跑
// 4. 升級失敗：整個回復、錯誤訊息寫出檔名與原因、不記錄成已套
// 5. 資料庫比程式新（套過程式沒有的升級）：停下
// 6. 檔名不合規則、編號重複：停下
// 7. Cloudflare 版（scripts/migrate.js）送出的 SQL：只測純函式，不連正式庫
// 8. 程式附的 migrations/ 都合規則；openNodeDb 用的就是這套
// 用法：node scripts/migrations-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { migrateNode, listMigrations, planMigrations, versionOf, MigrationError } from '../src/migrations.js';
import { d1Steps } from './migrate.js';
import { openNodeDb } from '../src/db-node.js';

const BASE = fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'); // 1.0 的結構
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-mig-'));
const dirOf = (name, files) => { const d = path.join(tmp, name); fs.mkdirSync(d); for (const [f, sql] of Object.entries(files)) fs.writeFileSync(path.join(d, f), sql); return d; };
// 新版：participants 多一欄 nickname、多一張 notes 表（schema.sql 也同步改好）
const M1 = "ALTER TABLE participants ADD COLUMN nickname TEXT NOT NULL DEFAULT '';";
const M2 = 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);\nCREATE INDEX IF NOT EXISTS idx_notes_body ON notes (body);';
const NEW = BASE.replace('CREATE TABLE IF NOT EXISTS participants (', "CREATE TABLE IF NOT EXISTS participants (\n  nickname TEXT NOT NULL DEFAULT '',") + '\n' + M2;
assert.notEqual(NEW, BASE, '測試用的新結構有改到');
const good = dirOf('good', { '001_add_nickname.sql': M1, '002_notes.sql': M2 });
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
const hasTable = (db, t) => !!db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const applied = db => db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map(r => r.name);

try {
  // 1. 全新站
  {
    const db = new DatabaseSync(path.join(tmp, 'fresh.db'));
    const r = migrateNode(db, { schema: NEW, dir: good });
    assert.deepEqual(r, { fresh: true, applied: [], version: 2 });
    assert.ok(cols(db, 'participants').includes('nickname') && hasTable(db, 'notes'), '用最新結構建表');
    assert.deepEqual(applied(db), ['001_add_nickname.sql', '002_notes.sql'], '現有升級標成已套');
    assert.deepEqual(migrateNode(db, { schema: NEW, dir: good }).applied, [], '再啟動不重跑');
    db.close();
  }
  // 2. 從 1.0 升到新版（1.0 的站沒有 schema_migrations 表）
  {
    const db = new DatabaseSync(path.join(tmp, 'v1.db'));
    db.exec(BASE);
    db.prepare("INSERT INTO participants (id, kind, name, role, code, token, created_at, updated_at) VALUES ('p1', 'human', '林志明', 'PO', 'c1', 't1', '2026-01-01', '2026-01-01')").run();
    assert.ok(!hasTable(db, 'schema_migrations'));
    const r = migrateNode(db, { schema: NEW, dir: good });
    assert.deepEqual(r, { fresh: false, applied: ['001_add_nickname.sql', '002_notes.sql'], version: 2 });
    assert.ok(cols(db, 'participants').includes('nickname') && hasTable(db, 'notes'));
    assert.equal(db.prepare("SELECT name FROM participants WHERE id = 'p1'").get().name, '林志明', '資料保留');
    // 3. 重複啟動不重跑（ALTER 再跑一次會報欄位重複，沒報錯＝沒重跑）
    assert.deepEqual(migrateNode(db, { schema: NEW, dir: good }).applied, []);
    // 只多一個新升級：只套那一個
    const more = dirOf('more', { '001_add_nickname.sql': M1, '002_notes.sql': M2, '003_notes_pinned.sql': 'ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;' });
    assert.deepEqual(migrateNode(db, { schema: NEW, dir: more }), { fresh: false, applied: ['003_notes_pinned.sql'], version: 3 });
    // 5. 資料庫比程式新：拿回舊的升級清單啟動 → 停下
    assert.throws(() => migrateNode(db, { schema: NEW, dir: good }), e => e instanceof MigrationError && /003_notes_pinned\.sql/.test(e.message) && /新版程式/.test(e.message));
    db.close();
  }
  // 4. 升級失敗：整個回復（同一個檔前面成功的也回復）、不記錄、訊息清楚
  {
    const db = new DatabaseSync(path.join(tmp, 'bad.db'));
    db.exec(BASE);
    const bad = dirOf('bad', { '001_add_nickname.sql': M1, '002_broken.sql': 'CREATE TABLE half (id INTEGER);\nALTER TABLE no_such_table ADD COLUMN x TEXT;' });
    assert.throws(() => migrateNode(db, { schema: NEW, dir: bad }), e => e instanceof MigrationError && /migrations\/002_broken\.sql/.test(e.message) && /no_such_table/.test(e.message) && /回復/.test(e.message));
    assert.deepEqual(applied(db), ['001_add_nickname.sql'], '只記成功的');
    assert.ok(!hasTable(db, 'half'), '失敗的檔裡前面成功的語句也回復');
    assert.ok(cols(db, 'participants').includes('nickname'), '前一個升級照樣保留');
    db.close();
  }
  // 6. 檔名與編號
  assert.throws(() => listMigrations(dirOf('badname', { 'add_x.sql': 'SELECT 1;' })), /名稱不對/);
  assert.throws(() => listMigrations(dirOf('dup', { '001_a.sql': 'SELECT 1;', '001_b.sql': 'SELECT 1;' })), /編號重複/);
  assert.deepEqual(listMigrations(path.join(tmp, 'none')), [], '沒有資料夾＝沒有升級');
  assert.equal(versionOf(['001_a.sql', '010_b.sql']), 10);
  assert.deepEqual(planMigrations({ fresh: false, applied: ['001_a.sql'], files: [{ name: '001_a.sql' }, { name: '002_b.sql' }] }).apply.map(f => f.name), ['002_b.sql']);

  // 7. Cloudflare 版送出的 SQL
  const files = listMigrations(good);
  const f1 = d1Steps({ fresh: true, applied: [], files, schema: NEW, now: 'T' });
  assert.equal(f1.version, 2);
  assert.ok(f1.steps.some(s => /CREATE TABLE IF NOT EXISTS participants/.test(s.sql)), '全新 D1：建表');
  assert.ok(f1.steps.some(s => /INSERT OR IGNORE INTO schema_migrations .*'001_add_nickname\.sql'.*'002_notes\.sql'/.test(s.sql)), '全新 D1：標記已套');
  assert.ok(!f1.steps.some(s => /ALTER TABLE/.test(s.sql)), '全新 D1：不跑 ALTER');
  const o1 = d1Steps({ fresh: false, applied: ['001_add_nickname.sql'], files, schema: NEW, now: 'T' });
  assert.deepEqual(o1.steps.map(s => s.label), ['確認升級紀錄表', '套用 migrations/002_notes.sql', '補新的表與索引']);
  assert.match(o1.steps[1].sql, /CREATE TABLE IF NOT EXISTS notes .*; INSERT INTO schema_migrations \(name, applied_at\) VALUES \('002_notes\.sql', 'T'\)$/, '升級與記錄同一批');
  assert.ok(!/--/.test(o1.steps.at(-1).sql), 'SQL 註解拿掉（接成一行才不會吃掉後面）');
  assert.throws(() => d1Steps({ fresh: false, applied: ['009_future.sql'], files, schema: NEW }), /009_future\.sql/);
  const src = fs.readFileSync(new URL('./migrate.js', import.meta.url), 'utf8');
  assert.ok(/fileURLToPath\(import\.meta\.url\) === fs\.realpathSync\(process\.argv\[1\]\)/.test(src), '被 import 時不連 wrangler');

  // 8. 程式附的升級檔、openNodeDb
  listMigrations(fileURLToPath(new URL('../migrations/', import.meta.url))); // 不合規則會丟錯
  const odb = openNodeDb(path.join(tmp, 'open.db'), { legacyProjects: false });
  assert.ok(await odb.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"), 'openNodeDb 走升級機制');
  odb.close();
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['cf:db:migrate'], /scripts\/migrate\.js/);
  assert.match(pkg.scripts.deploy, /scripts\/migrate\.js/, 'deploy 先套升級');
  console.log('migrations-test：全部通過');
} catch (e) {
  console.error('migrations-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
