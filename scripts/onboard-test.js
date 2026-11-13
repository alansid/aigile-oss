// 新手上路（API）：GET /api/me 的 onboard、PUT /api/me/prefs 合併
// 1. 每位人類都看得到（新舊成員都一樣）；3 項：ai（名下 AI 簽到過）→ walk（讀完說明第 2 章）→ todo（回過一則指定他回覆的訊息）
// 2. prefs 合併：改風格不洗掉 onboard，改 onboard 不洗掉風格；不合法的擋下，錯誤訊息有英文
// 3. 按「不用回」不算回覆；回沒指定你回覆的訊息也不算
// 4. 三項做完自動收起，之後不再查資料庫；「不用了」之後不再出現、也不再查資料庫
// 5. AI 沒有新手上路、不能改 prefs
// 本機暫存資料庫，不連任何站。用法：node scripts/onboard-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-onboard-'));
const raw = openNodeDb(path.join(dataDir, 'switch.db'), { legacyProjects: true });
let onboardReads = 0; // 數新手上路那兩個查詢被跑了幾次
const db = { ...raw, get: (sql, ...a) => { if (/owner_id = \? AND kind = 'ai' AND last_seen_at > 0|JOIN messages q ON q\.id = n\.message_id/.test(sql)) onboardReads++; return raw.get(sql, ...a); } };
const app = createApp({ db, storage: dbStorage(raw), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const me = async t => (await call(t, '/api/me')).body;
const prefs = (t, b) => call(t, '/api/me/prefs', 'PUT', b);
const join = async (name, role = 'PG') => (await call(null, '/api/join', 'POST', { name, role })).body;

try {
  const lin = await join('林志明', 'PO'), L = lin.participant.participantId;
  // 1. 一開始 3 項都還沒打勾；老成員也看得到
  let ob = (await me(lin.token)).onboard;
  assert.deepEqual(ob, { show: true, collapsed: false, steps: { ai: false, walk: false, todo: false } }, '新成員：' + JSON.stringify(ob));
  const old = await join('老成員');
  await raw.run('UPDATE participants SET created_at = ? WHERE id = ?', '2025-01-01T00:00:00.000Z', old.participant.participantId);
  assert.equal((await me(old.token)).onboard.show, true, '老成員也看得到');
  await raw.run('UPDATE participants SET created_at = ? WHERE id = ?', new Date().toISOString(), old.participant.participantId); // 最早加入的人類是管理員，改回來

  // 2. prefs 合併
  assert.equal((await prefs(lin.token, { style: 'b' })).status, 200);
  let r = await prefs(lin.token, { onboard: { collapsed: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.prefs.style, 'b', '改 onboard 不洗掉風格');
  assert.equal(r.body.onboard.collapsed, true, '回傳 onboard');
  assert.equal((await prefs(lin.token, { style: 'c' })).status, 200);
  let m = await me(lin.token);
  assert.ok(m.prefs.style === 'c' && m.onboard.collapsed === true, '改風格不洗掉 onboard：' + JSON.stringify([m.prefs, m.onboard]));
  for (const b of [{}, { onboard: { walked: false } }, { onboard: { foo: 1 } }, { onboard: { dismissed: 'yes' } }, { onboard: [] }, { onboard: null }, { style: 'z' }]) {
    assert.equal((await prefs(lin.token, b)).status, 400, '擋下：' + JSON.stringify(b));
  }
  const en = fs.readFileSync(new URL('../public/i18n/en.js', import.meta.url), 'utf8');
  for (const k of ['要帶 style 或 onboard', 'onboard 不認得欄位 {0}；只收 walked、dismissed、collapsed', 'onboard.{0} 需為 true 或 false']) assert.ok(en.includes(JSON.stringify(k) + ':'), '錯誤訊息有英文：' + k);

  // 讀完說明第 2 章 → walk 打勾；再送一次不改時間
  await prefs(lin.token, { onboard: { walked: true, collapsed: false } });
  const at1 = JSON.parse((await raw.get('SELECT value FROM app_settings WHERE key = ?', 'prefs:' + L)).value).onboard.walkedAt;
  await prefs(lin.token, { onboard: { walked: true } });
  assert.equal(JSON.parse((await raw.get('SELECT value FROM app_settings WHERE key = ?', 'prefs:' + L)).value).onboard.walkedAt, at1, '再送一次不改時間');
  assert.equal((await me(lin.token)).onboard.steps.walk, true, '讀完說明第 2 章打勾');

  // 3. 名下 AI 簽到過；按「不用回」不算、回一般訊息不算、回指定你回覆的才算
  const ai = (await call(lin.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const AT = await testToken(raw, ai.participantId);
  assert.equal((await me(lin.token)).onboard.steps.ai, false, 'AI 還沒用 Token 呼叫過');
  const ask = async (id, text, replyFrom = [L]) => (await call(AT, '/api/messages', 'POST', { requestId: id, project: '預設專案', text, recipientIds: [L], replyFrom })).body;
  const q1 = await ask('q1', '第一個問題');
  const n1 = (await call(lin.token, '/api/notifications?status=pending')).body.items.find(n => n.messageId === q1.messageId);
  assert.ok(n1, '指定回覆的訊息有通知');
  await call(lin.token, '/api/notifications/ack', 'POST', { notificationIds: [n1.notificationId] });
  m = await me(lin.token);
  assert.equal(m.onboard.steps.ai, true, 'AI 用 Token 呼叫過就打勾');
  assert.equal(m.onboard.steps.todo, false, '按「不用回」不算');
  const plain = await ask('p1', '[通知] 進度', []);
  await call(lin.token, '/api/messages', 'POST', { requestId: 'r0', project: '預設專案', text: '收到', replyToMessageId: plain.messageId });
  assert.equal((await me(lin.token)).onboard.steps.todo, false, '回沒指定你回覆的訊息不算');
  // 別人回了那一題也不算
  const chen = await join('陳大文');
  await call(lin.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  await call(chen.token, '/api/messages', 'POST', { requestId: 'rc', project: '預設專案', text: '我先回', replyToMessageId: q1.messageId });
  assert.equal((await me(lin.token)).onboard.steps.todo, false, '別人回的不算');
  await call(lin.token, '/api/messages', 'POST', { requestId: 'r1', project: '預設專案', text: '好，照做', replyToMessageId: q1.messageId });

  // 4. 三項做完：自動收起，記下 doneAt，之後不再查資料庫
  m = await me(lin.token);
  assert.deepEqual(m.onboard, { show: false, collapsed: false, steps: { ai: true, walk: true, todo: true } }, '3 項做完自動收起：' + JSON.stringify(m.onboard));
  assert.ok(JSON.parse((await raw.get('SELECT value FROM app_settings WHERE key = ?', 'prefs:' + L)).value).onboard.doneAt, '記下做完的時間');
  onboardReads = 0;
  await me(lin.token); await me(lin.token);
  assert.equal(onboardReads, 0, '做完之後 GET /api/me 不再查新手上路');

  // 不用了：之後不再出現（存在帳號），也不再查資料庫
  assert.equal((await me(chen.token)).onboard.show, true);
  r = await prefs(chen.token, { onboard: { dismissed: true } });
  assert.equal(r.body.onboard.show, false, '不用了之後不出現');
  onboardReads = 0;
  assert.equal((await me(chen.token)).onboard.show, false, '重新讀還是不出現');
  assert.equal(onboardReads, 0, '按了不用了就不再查新手上路');

  // 5. AI
  assert.equal((await me(AT)).onboard, undefined, 'AI 沒有新手上路');
  assert.equal((await prefs(AT, { onboard: { dismissed: true } })).status, 403, 'AI 不能改');
  console.log('onboard-test：全部通過');
} catch (e) {
  console.error('onboard-test 失敗：', e.message); process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
