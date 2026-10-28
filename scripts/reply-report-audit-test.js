// 驗收測試（回饋）：
// 1. 「要你回覆」：[進度同步] 等 [進度…]、平台卡片動作 [通知] 沒帶 replyFrom 不算要你回覆；明確帶 replyFrom 的 [通知] 照舊算；
//    卡片指派給 AI 的 [通知] 照舊叫醒 AI（只改「要你回覆」，不改叫醒）
// 2. 等人驗收的卡帶 report（負責人最後一則 [完成]／[交接]），網頁「看回報」直接跳過去；還沒交就不帶
// 3. 上傳 403：唯讀、不屬於的專案都記進稽核；不屬於的專案在存檔前就擋（不留沒掛訊息的檔）；規格寫怎麼分辨不是平台擋的
// 修正前：1 的 [進度同步]、卡片 [通知] 都是「要你回覆」；2 沒有 report；3 唯讀沒稽核、不屬於的專案先存檔才 403
// 用法：node scripts/reply-report-audit-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-t1-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const BASE = 'http://localhost';
const call = async (token, p, method = 'GET', body, raw) => {
  const r = await app(new Request(BASE + encodeURI(p), { method, headers: { 'Content-Type': raw ? 'text/plain' : 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined) }), BASE);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const rid = () => `t1_${++n}`;

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 第一位＝管理員
  const bob = (await call(null, '/api/join', 'POST', { name: 'Bob', role: 'PO' })).body;
  const philId = bob.participant.participantId;
  assert.equal((await call(boss.token, `/api/participants/${philId}/projects`, 'PUT', { projects: ['預設專案'] })).status, 200);
  const mk = await call(bob.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'UX', role: 'UX', name: 'Bob的UX', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  assert.ok(mk.body.participantId, JSON.stringify(mk.body));
  const ux = { id: mk.body.participantId, tok: (await testToken(db, mk.body.participantId)) };
  const post = (tok, body) => call(tok, '/api/messages', 'POST', { project: '預設專案', requestId: rid(), ...body });
  const noteOf = async (tok, messageId) => (await call(tok, '/api/notifications?status=pending&limit=100')).body.items.find(x => x.messageId === messageId);

  // 1a. AI 的 [進度同步] 只給 、沒帶 replyFrom：不是要你回覆
  let m = await post(ux.tok, { text: '[進度同步] 目前整理到一半', recipientIds: [philId] });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.notEqual((await noteOf(bob.token, m.body.messageId))?.ask, true, '[進度同步] 不是要你回覆');
  // 一般訊息只給一個人：照舊要他回覆
  m = await post(ux.tok, { text: '這個畫面要用哪個版本？', recipientIds: [philId] });
  assert.equal((await noteOf(bob.token, m.body.messageId))?.ask, true, '一般訊息照舊要回覆');
  // 明確帶 replyFrom 的 [通知]：照舊要你回覆
  m = await post(ux.tok, { text: '[通知] 這次的結果請你看一下', recipientIds: [philId], replyFrom: [philId] });
  assert.equal((await noteOf(bob.token, m.body.messageId))?.ask, true, '帶 replyFrom 的 [通知] 照舊要回覆');

  // 1b. 平台的卡片動作 [通知]：卡交給  等他（只 @ 他一人）→ 不是要你回覆
  const card = (await call(ux.tok, '/api/cards', 'POST', { title: 'UX 草案', type: '工作', project: '預設專案', ownerId: ux.id, requestId: rid() })).body;
  assert.ok(card.cardId, JSON.stringify(card));
  const ed = await call(ux.tok, `/api/cards/${card.cardId}`, 'PATCH', { status: '待確認', waitForId: philId, version: card.version });
  assert.equal(ed.status, 200, JSON.stringify(ed.body));
  const cardNote = (await call(bob.token, '/api/notifications?status=pending&limit=100')).body.items.find(x => /^\[通知\]/.test(x.preview) && x.preview.includes(card.cardId));
  assert.ok(cardNote, '有卡片動作通知');
  assert.notEqual(cardNote.ask, true, '平台卡片 [通知] 不是要你回覆：' + JSON.stringify(cardNote));
  // 卡片指派給 AI 的 [通知]：照舊叫醒 AI
  await call(ux.tok, '/api/notifications/ack', 'POST', { notificationIds: (await call(ux.tok, '/api/notifications?status=pending&limit=100')).body.items.map(x => x.notificationId) });
  const c2 = (await call(bob.token, '/api/cards', 'POST', { title: '給 UX 的新工作', type: '工作', project: '預設專案', ownerId: ux.id, requestId: rid() }));
  assert.equal(c2.status, 201, JSON.stringify(c2.body));
  const wake = (await call(ux.tok, '/api/notifications/count?wake=1')).body;
  assert.ok(wake.wake >= 1, '指派給 AI 的卡片 [通知] 照舊叫醒它：' + JSON.stringify(wake));

  // 2. 等  驗收、還沒交回報：沒有 report
  const verifying = async () => (await call(bob.token, '/api/cards?status=open')).body.items.find(x => x.cardId === card.cardId);
  assert.equal((await verifying()).report, undefined, '還沒交回報');
  // 不是負責人發的 [完成] 不算
  await post(bob.token, { text: '[完成] 我自己先寫的', cardId: card.cardId });
  assert.equal((await verifying()).report, undefined, '別人的 [完成] 不算回報');
  // 負責人 AI 發 [完成] 掛這張卡 → report 指到它
  const done = await post(ux.tok, { text: '[完成] 草案用文字交棒\n\n主流程：登入→收件匣→卡片', cardId: card.cardId, recipientIds: [philId], replyFrom: [] });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal((await verifying()).report?.messageId, done.body.messageId, '清單帶 report');
  assert.equal((await call(bob.token, `/api/cards/${card.cardId}`)).body.report?.messageId, done.body.messageId, '詳情帶 report');

  // 3. 上傳 403：不屬於的專案 → 存檔前就擋、記稽核
  const files0 = (await db.get('SELECT COUNT(*) AS n FROM files')).n;
  let up = await call(bob.token, '/api/files?name=draft.md&declared=true&project=第二專案', 'POST', null, '# 草案');
  assert.equal(up.status, 403, JSON.stringify(up.body));
  assert.equal(up.body.error?.code, 'PROJECT_FORBIDDEN');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM files')).n, files0, '沒有留下沒掛訊息的檔');
  assert.ok(await db.get("SELECT 1 FROM file_audit WHERE action = 'reject' AND actor_id = ? AND detail = 'PROJECT_FORBIDDEN'", philId), '記進稽核');
  // 唯讀 → 403 READ_ONLY、記稽核（AI 跟著所屬人類唯讀）
  await db.run("INSERT INTO app_settings (key, value) VALUES ('read_only', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ 預設專案: [philId] }));
  await new Promise(r => setTimeout(r, 10_100)); // 唯讀設定快取 10 秒
  up = await call(ux.tok, '/api/files?name=draft.md&declared=true&project=預設專案', 'POST', null, '# 草案');
  assert.equal(up.status, 403, JSON.stringify(up.body));
  assert.equal(up.body.error?.code, 'READ_ONLY');
  assert.ok(await db.get("SELECT 1 FROM file_audit WHERE action = 'reject' AND actor_id = ? AND detail = 'READ_ONLY'", ux.id), '唯讀擋下也記進稽核');

  // 規格：FYI 開頭、403 不是平台 JSON 怎麼分辨；2 萬字內
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /沒帶：`\[接單\]`、`\[完成\]`、`\[進度…\]`、`\[通知\]` 開頭＝知會/, '規格寫 FYI 開頭');
  assert.match(spec, /沒有 `error\.code`＝沒到平台（有 `cf-ray`＝Cloudflare 擋，沒有＝你那端網路）/, '規格寫 403 怎麼分辨');
  assert.ok([...spec].length <= 20000, '規格 2 萬字內：' + [...spec].length);
  console.log('reply-report-audit-test：全部通過');
} catch (e) {
  console.error('reply-report-audit-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  db.close?.();
}
