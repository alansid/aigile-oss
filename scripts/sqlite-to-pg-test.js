// PLAT-369 搬家工具（scripts/sqlite-to-pg.js）：SQLite 資料整份搬到 Postgres
// 1. 參數：--from、--to（或 DATABASE_URL）、--schema；目標不是 postgres:// 就停
// 2. 有 AIGILE_TEST_PG_URL（只准本機）時實際搬：用伺服器 API 做一個有成員、訊息、卡片、頭像（BLOB）的站，
//    搬完逐表筆數一樣、內容一樣、流水號接得下去，用 Postgres 啟動伺服器登入看得到原本的資料
// 3. 目標已經有資料就停（不蓋掉）；來源還沒套這版的升級就停
// 用法：node scripts/sqlite-to-pg-test.js（AIGILE_TEST_PG_URL=postgres://…@127.0.0.1/… 另外跑實際搬家）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from './sqlite-to-pg.js';
import { openNodeDb } from '../src/db-node.js';
import { createApp } from '../src/core.js';

// 1. 參數
assert.deepEqual(parseArgs(['--from', 'a.db', '--to', 'postgres://u@h/d', '--schema', 's1']), { from: path.resolve('a.db'), to: 'postgres://u@h/d', schema: 's1' });
assert.equal(parseArgs(['--from', 'a.db'], { DATABASE_URL: 'postgresql://x@y/z' }).to, 'postgresql://x@y/z', '沒給 --to 用 DATABASE_URL');
assert.throws(() => parseArgs(['--to', 'postgres://u@h/d']), /--from/);
assert.throws(() => parseArgs(['--from', 'a.db']), /--to/);
assert.throws(() => parseArgs(['--from', 'a.db', '--to', 'mysql://u@h/d']), /postgres/);

const PG_URL = process.env.AIGILE_TEST_PG_URL;
if (!PG_URL) {
  console.log('sqlite-to-pg-test：全部通過（沒設 AIGILE_TEST_PG_URL，略過實際搬家）');
  process.exit(0);
}

const { migrate } = await import('./sqlite-to-pg.js');
const { openPgDb, assertTestPgUrl, testSchemaFor } = await import('../src/db-pg.js');
assertTestPgUrl(PG_URL);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-s2pg-'));
const file = path.join(tmp, 'switch.db');

// 2. 做一個有資料的 SQLite 站（走 API，跟真的使用一樣）
const lite = openNodeDb(file);
const handle = createApp({ db: lite, docText: '# doc', config: { defaultAdmin: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const res = await handle(new Request('http://x' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }));
  return { status: res.status, body: await res.json().catch(() => null) };
};
const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
assert.ok(boss.token, '加入：' + JSON.stringify(boss));
await call(boss.token, `/api/participants/${boss.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
for (let i = 1; i <= 7; i++) assert.equal((await call(boss.token, '/api/messages', 'POST', { requestId: 'm' + i, project: '預設專案', text: `第 ${i} 則` })).status, 201);
const card = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c1', project: '預設專案', title: '搬家測試卡', ownerId: ai.participantId })).body;
assert.ok(card.cardId, '建卡：' + JSON.stringify(card));
await lite.run("INSERT INTO avatars (participant_id, mime, data, updated_at) VALUES (?, 'image/png', ?, 't')", boss.participant.participantId, new Uint8Array([137, 80, 78, 71, 0, 255]));
await lite.close();

// 實際搬
const schema = testSchemaFor(path.join(tmp, 'target'));
const out = [];
const counts = await migrate({ from: file, to: PG_URL, schema, log: l => out.push(l) });
assert.ok(counts.length >= 30, '每張表都搬：' + counts.length);
for (const c of counts) assert.equal(c.to, c.from, `${c.table} 筆數一樣`);
assert.ok(out.some(l => l.trim().startsWith('完成：')), out.join('\n'));

const src = new DatabaseSync(file, { readOnly: true });
const pgdb = await openPgDb(PG_URL, { legacyProjects: false, schema, max: 2 });
try {
  const msgs = src.prepare('SELECT seq, id, text FROM messages ORDER BY seq').all().map(r => ({ ...r }));
  assert.deepEqual(await pgdb.all('SELECT seq, id, text FROM messages ORDER BY seq'), msgs, '訊息內容與順序一樣');
  const av = await pgdb.get('SELECT data FROM avatars WHERE participant_id = ?', boss.participant.participantId);
  assert.deepEqual([...av.data], [137, 80, 78, 71, 0, 255], 'BLOB 原樣搬過去');
  const p = await pgdb.get('SELECT name, token FROM participants WHERE id = ?', boss.participant.participantId);
  assert.equal(p.name, '林志明');
  assert.equal(p.token, src.prepare('SELECT token FROM participants WHERE id = ?').get(boss.participant.participantId).token, '登入碼雜湊一樣（原本的登入照樣能用）');
  // 流水號接得下去：新訊息的 seq 比搬過去的大
  const maxSeq = Math.max(...msgs.map(m => m.seq));
  await pgdb.run("INSERT INTO messages (id, author_id, text, created_at) VALUES ('msg_after', ?, '搬家後', 't')", boss.participant.participantId);
  assert.equal((await pgdb.get("SELECT seq FROM messages WHERE id = 'msg_after'")).seq, maxSeq + 1, '流水號從最大號之後接');
  assert.equal((await pgdb.get("SELECT value FROM app_settings WHERE key = 'isolation_since'")).value, src.prepare("SELECT value FROM app_settings WHERE key = 'isolation_since'").get().value, '設定用來源的');
} finally { await pgdb.close(); src.close(); }

// 搬過去的資料用伺服器（Postgres）打開：原本的登入碼照樣能用、看得到原本的卡
{
  const db2 = await openPgDb(PG_URL, { legacyProjects: false, schema, max: 2 });
  try {
    const h2 = createApp({ db: db2, docText: '# doc', config: { defaultAdmin: '0' } });
    const r = await h2(new Request('http://x/api/cards/' + encodeURIComponent(card.cardId), { headers: { Authorization: 'Bearer ' + boss.token } }));
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.title, '搬家測試卡', '看得到原本的卡');
  } finally { await db2.close(); }
}

// 3. 目標已經有資料：停、不蓋掉
await assert.rejects(migrate({ from: file, to: PG_URL, schema, log: () => {} }), /目標不是空的/);
// 來源還沒套這版的升級：停
const old = path.join(tmp, 'old.db');
fs.copyFileSync(file, old);
{ const d = new DatabaseSync(old); d.exec("DELETE FROM schema_migrations WHERE name = '002_wake_counts.sql'"); d.close(); }
await assert.rejects(migrate({ from: old, to: PG_URL, schema: testSchemaFor(path.join(tmp, 'target2')), log: () => {} }), /還沒套這版的資料庫升級/);

fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log('sqlite-to-pg-test：全部通過（含實際搬家）');
