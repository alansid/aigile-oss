// 叫醒次數：等待腳本、watcher 回報 POST /api/me/wake，團隊狀態顯示「今天叫醒 N 次」
// 1. 舊資料庫升級：用 1.0.0／1.0.2 的結構（migrations 只套到 001）建好資料，新版程式啟動時自動套 002_wake_counts.sql，資料保留、功能正常
// 2. Cloudflare D1 版（scripts/migrate.js 的 d1Steps）送出的 SQL 在 1.0.x 結構上跑得過、只跑一次；只 import 純函式，不連正式庫
// 3. API：從沒回報＝null、人類 403、沒登入 401、AI 每呼叫一次加一、換日（台灣時間）從 1 重算
// 4. 等待腳本：PENDING、TIMEOUT 各算一次；UNAUTHORIZED、CONFIG_ERROR 不算；平台連不上照常結束
// 5. watcher：WAKE_CMD 是 echo（只寫門鈴）不算；真的執行喚醒指令才算
// 6. 腳本雜湊：watcher-env 給的雜湊等於改過的 watcher.mjs、aigile-wait.mjs
// 本機暫存資料庫與本機伺服器，不連任何站。用法：node scripts/wake-count-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { migrateNode, listMigrations, TRACK_SQL } from '../src/migrations.js';
import { d1Steps } from './migrate.js';
import { startServer, sleep } from './browser-kit.js';
import { scriptHashes } from './script-hashes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIG_DIR = path.join(ROOT, 'migrations');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'src/schema.sql'), 'utf8');
// 1.0.x 的結構＝現在的 schema.sql 去掉 002 加的三欄（有 git 與版本標籤時，再對一次 v1.0.0、v1.0.2 的原檔）
const OLD = SCHEMA.split('\n').filter(l => !/^\s+wake_(day|count|at) /.test(l)).join('\n');
assert.notEqual(OLD, SCHEMA, '測試用的舊結構真的少了叫醒欄位');
for (const tag of ['v1.0.0', 'v1.0.2']) {
  const g = spawnSync('git', ['show', `${tag}:src/schema.sql`], { cwd: ROOT, encoding: 'utf8' });
  if (g.status === 0) assert.equal(g.stdout.replace(/\r\n/g, '\n'), OLD.replace(/\r\n/g, '\n'), `舊結構跟 ${tag} 的 schema.sql 一樣`);
  else console.log(`wake-count-test：沒有 ${tag}（略過原檔比對）`);
}
const OLD_MIGS = ['001_admin_flag.sql']; // 1.0.0～1.0.2 附的升級檔
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wake-'));
const hash = t => 'h:' + createHash('sha256').update(t).digest('hex');
const tok = () => 'tt_' + randomBytes(24).toString('base64url');
const cols = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
const kids = [];

try {
  // ---------- 1. 1.0.x 的資料庫：跟 1.0.x 啟動時一樣，用舊結構建表、標記 001 已套 ----------
  const oldMigDir = path.join(tmp, 'mig-1.0'); fs.mkdirSync(oldMigDir);
  for (const n of OLD_MIGS) fs.copyFileSync(path.join(MIG_DIR, n), path.join(oldMigDir, n));
  const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir);
  const file = path.join(dataDir, 'switch.db');
  const HUMAN = tok(), AI = tok(), ts = new Date().toISOString(), exp = Date.now() + 7 * 86400_000;
  {
    const db = new DatabaseSync(file);
    assert.deepEqual(migrateNode(db, { schema: OLD, dir: oldMigDir }), { fresh: true, applied: [], version: 1 }, '1.0.x 全新站');
    assert.ok(!cols(db, 'participants').includes('wake_count'), '1.0.x 沒有叫醒欄位');
    db.exec("INSERT OR IGNORE INTO projects (id, name, archived, created_at) VALUES ('預設專案', '預設專案', 0, '2026-01-01T00:00:00.000Z')");
    db.prepare(`INSERT INTO participants (id, kind, name, role, code, token, token_expires_at, created_at, updated_at, last_seen_at, projects, is_admin)
      VALUES ('p_old_h', 'human', '林志明', 'PO', 'AAAA', ?, ?, ?, ?, 0, '預設專案', 1)`).run(hash(HUMAN), exp, ts, ts);
    db.prepare(`INSERT INTO participants (id, kind, name, role, role_key, code, owner_id, duties, style, autonomy, must_confirm, handoff, token, token_expires_at, created_at, updated_at, projects)
      VALUES ('p_old_ai', 'ai', '林志明的程式開發', '程式開發', 'PG', 'BBBB', 'p_old_h', 'x', 'x', 'x', 'x', 'x', ?, ?, ?, ?, '預設專案')`).run(hash(AI), exp, ts, ts);
    db.close();
  }

  // ---------- 2. Cloudflare D1：同一份舊結構，照 d1Steps 送出的 SQL 一步步跑（只 import 純函式） ----------
  {
    const files = listMigrations(MIG_DIR);
    assert.ok(files.some(f => f.name === '002_wake_counts.sql'), '程式附 002_wake_counts.sql');
    const d1 = new DatabaseSync(':memory:');
    migrateNode(d1, { schema: OLD, dir: oldMigDir });
    const applied = () => d1.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map(r => r.name);
    const plan = d1Steps({ fresh: false, applied: applied(), files, schema: SCHEMA, now: 'T' });
    assert.ok(plan.steps.some(s => s.label === '套用 migrations/002_wake_counts.sql'), 'D1：要套 002');
    assert.ok(!plan.steps.some(s => /001_admin_flag/.test(s.label)), 'D1：001 已套過不重跑');
    for (const s of plan.steps) d1.exec(s.sql); // D1 一步一批送出（接成一行、註解拿掉）
    assert.ok(['wake_day', 'wake_count', 'wake_at'].every(c => cols(d1, 'participants').includes(c)), 'D1：升級後有三欄');
    assert.deepEqual(applied(), ['001_admin_flag.sql', '002_wake_counts.sql'], 'D1：記成已套');
    assert.ok(!d1Steps({ fresh: false, applied: applied(), files, schema: SCHEMA, now: 'T' }).steps.some(s => /002/.test(s.label)), 'D1：再跑一次不重套');
    // D1 全新站：直接建最新結構、標記全部已套
    const fresh = d1Steps({ fresh: true, applied: [], files, schema: SCHEMA, now: 'T' });
    const d2 = new DatabaseSync(':memory:');
    for (const s of fresh.steps) d2.exec(s.sql);
    assert.ok(cols(d2, 'participants').includes('wake_count'), 'D1 全新站：有叫醒欄位');
    assert.deepEqual(d2.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map(r => r.name), files.map(f => f.name), 'D1 全新站：全部標成已套');
    d1.close(); d2.close();
  }

  // ---------- 3. 新版程式開舊資料庫：自動升級 ----------
  const BASE = await startServer(kids, dataDir, { TEAM_CACHE_MS: '0' });
  assert.match(kids[0].tail, /資料庫升級：套用 002_wake_counts\.sql（目前版本 2）/, '啟動時自動套 002：' + kids[0].tail);
  {
    const db = new DatabaseSync(file);
    assert.ok(['wake_day', 'wake_count', 'wake_at'].every(c => cols(db, 'participants').includes(c)), 'Node：升級後有三欄');
    assert.deepEqual(db.prepare('SELECT name FROM schema_migrations ORDER BY name').all().map(r => r.name), ['001_admin_flag.sql', '002_wake_counts.sql']);
    db.close();
  }
  const call = async (t, p, method = 'GET', body) => { const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const me = await call(HUMAN, '/api/me');
  assert.equal(me.status, 200, '舊資料庫的人類照樣登得進來');
  assert.equal(me.body.name || me.body.participant?.name, '林志明', '資料保留');
  assert.equal((await call(AI, '/api/me')).status, 200, '舊資料庫的 AI Token 照樣能用');
  const mine = async () => (await call(HUMAN, '/api/team-status')).body.members.find(m => m.participantId === 'p_old_ai');
  const human = async () => (await call(HUMAN, '/api/team-status')).body.members.find(m => m.participantId === 'p_old_h');

  // ---------- 4. API ----------
  let m = await mine();
  assert.ok(m, '團隊狀態有舊 AI');
  assert.equal(m.wakesToday, null, '從沒回報 → wakesToday null（畫面不顯示）');
  assert.equal(m.lastWakeAt, null);
  assert.equal((await human()).wakesToday, null, '人類不算');
  const h403 = await call(HUMAN, '/api/me/wake', 'POST');
  assert.equal(h403.status, 403, '人類呼叫 403');
  assert.equal(h403.body.error?.code, 'FORBIDDEN');
  assert.equal((await call(null, '/api/me/wake', 'POST')).status, 401, '沒登入 401');
  let r = await call(AI, '/api/me/wake', 'POST');
  assert.equal(r.status, 200); assert.equal(r.body.wakesToday, 1);
  r = await call(AI, '/api/me/wake', 'POST');
  assert.equal(r.body.wakesToday, 2);
  m = await mine();
  assert.equal(m.wakesToday, 2, '團隊狀態看得到');
  assert.ok(Date.now() - Date.parse(m.lastWakeAt) < 10_000, '最近一次時間');

  // ---------- 5. 等待腳本 ----------
  const work = path.join(tmp, 'work'), dir = path.join(work, '.aigile', 'T');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.token'), AI);
  const runWait = (args = [], env = {}) => new Promise(res => {
    const p = spawn(process.execPath, [path.join(ROOT, 'public', 'aigile-wait.mjs'), '--agent', 'T', ...args], { cwd: work, env: { ...process.env, AIGILE_BASE: BASE, AIGILE_TOKEN: '', AIGILE_TOKEN_FILE: '', ...env }, stdio: 'pipe' });
    let out = ''; p.stdout.on('data', d => { out += d; });
    p.on('exit', code => res({ code, last: out.trim().split('\n').pop() }));
  });
  r = await runWait(['--max-min=0.02']);
  assert.deepEqual([r.last, r.code], ['TIMEOUT', 10]);
  assert.equal((await mine()).wakesToday, 3, 'TIMEOUT 算一次');
  assert.equal((await call(HUMAN, '/api/messages', 'POST', { project: '預設專案', requestId: 'p1', text: '請看一下', recipientIds: ['p_old_ai'] })).status, 201, '升級後照樣能發文');
  r = await runWait();
  assert.deepEqual([r.last, r.code], ['PENDING 1', 0]);
  assert.equal((await mine()).wakesToday, 4, 'PENDING 算一次');
  const bad = path.join(dir, 'bad.token'); fs.writeFileSync(bad, 'bad');
  r = await runWait([], { AIGILE_TOKEN_FILE: bad });
  assert.deepEqual([r.last, r.code], ['UNAUTHORIZED', 20]);
  r = await runWait([], { AIGILE_BASE: '' });
  assert.deepEqual([r.last, r.code], ['CONFIG_ERROR', 40]);
  assert.equal((await mine()).wakesToday, 4, '錯誤結束不算');
  r = await runWait(['--max-min=0.02'], { AIGILE_BASE: 'http://127.0.0.1:9' });
  assert.deepEqual([r.last, r.code], ['TIMEOUT', 10], '回報失敗（舊平台或斷線）照常結束');

  // ---------- 6. watcher ----------
  const startWatcher = wake => {
    const w = spawn(process.execPath, [path.join(ROOT, 'public', 'watcher.mjs')], { cwd: work, stdio: 'pipe', env: { ...process.env, AIGILE_BASE: BASE, AIGILE_ME: 'p_old_ai', AIGILE_TOKEN: '', AIGILE_TOKEN_FILE: path.join(dir, '.token'), WAKE_CMD: wake, HEARTBEAT_MIN: '60', SUPABASE_URL: '', SUPABASE_KEY: '' } });
    let log = ''; w.stdout.on('data', d => { log += d; }); w.stderr.on('data', d => { log += d; });
    kids.push(w);
    return { w, log: () => log };
  };
  const waitLog = async (x, s) => { for (let i = 0; i < 150 && !x.log().includes(s); i++) await sleep(100); assert.ok(x.log().includes(s), `watcher 日誌沒有「${s}」：${x.log().slice(-400)}`); };
  let x = startWatcher('echo bell');
  await waitLog(x, '喚醒指令結束');
  await sleep(500);
  assert.equal((await mine()).wakesToday, 4, 'echo（只寫門鈴）不算');
  x.w.kill(); await sleep(300);
  x = startWatcher(`"${process.execPath}" -e ""`);
  await waitLog(x, '喚醒指令結束');
  for (let i = 0; i < 30 && (await mine()).wakesToday !== 5; i++) await sleep(100);
  assert.equal((await mine()).wakesToday, 5, '真的執行喚醒指令算一次');
  x.w.kill();

  // ---------- 7. 換日（台灣時間）：資料庫裡是昨天 → 團隊狀態 0、下一次從 1 重算 ----------
  { const db = new DatabaseSync(file); db.prepare("UPDATE participants SET wake_day = '2000-01-01', last_seen_at = ? WHERE id = 'p_old_ai'").run(Date.now() + 60_000); db.close(); }
  assert.equal((await call(HUMAN, '/api/my-ais/p_old_ai', 'PATCH', { duties: 'y' })).status, 200, '讓平台重讀成員表（直接改資料庫有快取）');
  m = await mine();
  assert.equal(m.wakesToday, 0, '回報過但今天還沒＝0（畫面寫「今天還沒叫醒」）');
  assert.ok(m.lastWakeAt, '最近一次時間保留');
  r = await call(AI, '/api/me/wake', 'POST');
  assert.equal(r.body.wakesToday, 1, '換日從 1 開始');
  assert.equal((await mine()).wakesToday, 1);

  // ---------- 8. 腳本雜湊：AI 下載後核對的是改過的檔 ----------
  const h = scriptHashes(), wenv = (await call(AI, '/api/me/watcher-env')).body;
  for (const f of ['watcher.mjs', 'aigile-wait.mjs']) {
    assert.equal(wenv.files[f], createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public', f))).digest('hex'), `watcher-env 的 ${f} 雜湊等於檔案內容`);
    assert.equal(wenv.files[f], h[f]);
  }
  assert.ok(fs.readFileSync(path.join(ROOT, 'public/aigile-wait.mjs'), 'utf8').includes('/api/me/wake') && fs.readFileSync(path.join(ROOT, 'public/watcher.mjs'), 'utf8').includes('/api/me/wake'), '兩支腳本都會回報');

  // ---------- 9. 畫面：英文字典、偏多門檻 ----------
  const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8'), en = fs.readFileSync(path.join(ROOT, 'public/i18n/en.js'), 'utf8');
  assert.match(app, /const WAKE_HIGH = 15;/, '超過 15 次標「次數偏多」');
  for (const k of ['今天還沒叫醒', '今天叫醒 {0} 次', '最近一次 {0}', '⚠ 次數偏多']) assert.ok(en.includes(`"${k}":`), `英文字典有「${k}」`);
  console.log('wake-count-test：全部通過');
} catch (e) {
  console.error('wake-count-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const k of kids) { try { k.kill(); } catch {} }
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
