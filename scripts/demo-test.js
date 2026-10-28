// 驗收測試：一鍵載入示範資料，看完可清掉
// 1. 管理員載入：一個示範專案、幾張不同狀態的卡、一段人與 AI 的對話、一張等你決定的決策卡；你看得到示範專案
// 2. 示範資料都有標記；「清除示範資料」只刪它們，不動真資料（其他專案、真成員、你自己）
// 3. 示範專案裡有人發了真的訊息：清除時專案保留、那則訊息保留，只刪示範的
// 4. 示範內容是虛構的通用情境，成員名字都是「示範…」；示範成員不能登入
// 5. 只有管理員；已經載入時不能再載入
// 用法：node scripts/demo-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-demo-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'), { legacyProjects: false });
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', peopleCheckMs: '1' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const count = async t => (await db.get(`SELECT COUNT(*) AS n FROM ${t}`)).n;
const snapshot = async () => Object.fromEntries(await Promise.all(['participants', 'projects', 'messages', 'cards', 'card_log', 'card_msgs', 'notifications', 'message_recipients'].map(async t => [t, await count(t)])));

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const real = (await call(boss.token, '/api/me')).body.projects[0];
  // 真資料
  assert.equal((await call(boss.token, '/api/messages', 'POST', { requestId: 'r1', project: real, text: '真的訊息' })).status, 201);
  assert.equal((await call(boss.token, '/api/cards', 'POST', { requestId: 'r2', project: real, title: '真的卡' })).status, 201);
  const before = await snapshot();
  const meBefore = (await db.get('SELECT projects FROM participants WHERE id = ?', boss.participant.participantId)).projects;

  // 5. 只有管理員
  assert.equal((await call(chen.token, '/api/admin/demo', 'POST')).status, 403, '非管理員不能載入');
  assert.equal((await call(boss.token, '/api/admin/demo')).body.loaded, false);

  // 1. 載入
  const r = await call(boss.token, '/api/admin/demo', 'POST');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call(boss.token, '/api/admin/demo', 'POST')).body.error?.code, 'DEMO_LOADED', '不能重複載入');
  const pj = r.body.projectId;
  assert.ok((await call(boss.token, '/api/me')).body.projects.includes(pj), '你看得到示範專案');
  const cards = (await call(boss.token, `/api/cards?project=${pj}`)).body.items.filter(c => c.project === pj);
  const sts = new Set(cards.filter(c => c.type !== '決策').map(c => c.status));
  for (const s of ['待處理', '進行中', '待確認', '已完成', '受阻']) assert.ok(sts.has(s), '有「' + s + '」的卡');
  assert.ok(cards.every(c => /^DEMO-\d+$/.test(c.cardId)), '卡號 DEMO-n：' + cards.map(c => c.cardId));
  const dec = cards.find(c => c.type === '決策');
  assert.ok(dec, '有決策卡');
  const decD = (await call(boss.token, `/api/cards/${dec.cardId}`)).body;
  assert.equal(decD.decision.decider.participantId, boss.participant.participantId, '決策等你決定');
  assert.equal(decD.decision.options.length, 2);
  const msgs = (await call(boss.token, `/api/messages?project=${pj}&limit=50`)).body.items.filter(m => m.project === pj);
  assert.ok(msgs.length >= 5, '有一段對話');
  assert.ok(msgs.some(m => m.author.memberType === 'human') && msgs.some(m => m.author.memberType === 'ai'), '人與 AI 的對話');
  assert.ok(msgs.some(m => /^\[需確認\]/.test(m.text)), '有 [需確認]');
  assert.ok((await call(boss.token, '/api/notifications?status=pending')).body.items.some(n => n.project === pj), '你收到一則通知');
  const mail = (await call(boss.token, `/api/cards/${cards.find(c => c.title === '報名成功寄確認信').cardId}`)).body;
  assert.ok(mail.messageIds.length >= 4, '對話掛在卡上');
  // 4. 虛構、名字都是示範、不能登入
  const demoPeople = await db.all("SELECT * FROM participants WHERE projects = ?", pj);
  assert.equal(demoPeople.length, 3);
  assert.ok(demoPeople.every(p => p.name.startsWith('示範')), '名字都是示範…');
  for (const p of demoPeople.filter(p => p.kind === 'ai')) assert.equal((await call(p.token, '/api/me')).status, 401, '示範 AI 的 Token 已過期');
  assert.ok(!(await db.get('SELECT 1 AS x FROM devices WHERE participant_id IN (SELECT id FROM participants WHERE projects = ?)', pj)), '示範成員沒有裝置登入');
  assert.ok(!(await db.get('SELECT 1 AS x FROM credentials WHERE participant_id IN (SELECT id FROM participants WHERE projects = ?)', pj)), '示範成員沒有密碼');

  // 2. 清除：回到原樣
  const c1 = await call(boss.token, '/api/admin/demo', 'DELETE');
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal(c1.body.keptProject, false);
  assert.deepEqual(await snapshot(), before, '清除後跟載入前一樣（真資料沒動）');
  assert.equal((await db.get('SELECT projects FROM participants WHERE id = ?', boss.participant.participantId)).projects, meBefore, '你的專案回到原樣');
  assert.ok(!(await db.get("SELECT 1 AS x FROM app_settings WHERE key IN ('demo_data', ?, ?, ?)", 'slug:' + pj, 'pcode:' + pj, 'pnomax:' + pj)), '示範的設定也清掉');
  assert.equal((await call(boss.token, '/api/admin/demo', 'DELETE')).status, 404, '沒有示範資料');

  // 3. 示範專案裡有真的訊息：專案保留、真訊息保留
  const r2 = (await call(boss.token, '/api/admin/demo', 'POST')).body;
  const mine = await call(boss.token, '/api/messages', 'POST', { requestId: 'r3', project: r2.projectId, text: '我在示範專案發的真訊息' });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  const c2 = (await call(boss.token, '/api/admin/demo', 'DELETE')).body;
  assert.equal(c2.keptProject, true, '有真資料就保留專案');
  const left = await db.all('SELECT id FROM messages WHERE project = ?', r2.projectId);
  assert.deepEqual(left.map(m => m.id), [mine.body.messageId], '只留真訊息');
  assert.equal(await count('cards'), before.cards, '示範卡都刪了');
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM participants WHERE name LIKE '示範%'")).n, 0, '示範成員都刪了');
  console.log('demo-test：全部通過');
} catch (e) {
  console.error('demo-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
}
