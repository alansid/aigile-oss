// 驗收測試：訊息上標「要回覆／知會」（replyFrom）。
// 用法：node scripts/ask-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-ask-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000' } });
const BASE = 'http://localhost';
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined }), BASE);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let n = 0;
const post = (tok, b) => call(tok, '/api/messages', 'POST', { project: '預設專案', requestId: 'r' + (++n), text: '測試 ' + n, ...b });
const askOf = (m, id) => m.recipients.find(r => r.participantId === id)?.ask;

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const L = boss.participant.participantId, C = chen.participant.participantId;
  await call(boss.token, `/api/participants/${C}/projects`, 'PUT', { projects: ['預設專案'] });
  const mk = name => call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }).then(x => x.body);
  const pg = await mk('AB12'), ux = await mk('UX');
  const U = ux.participantId;

  // 沒帶 replyFrom、多位收件人：不標（照舊）
  let r = await post(pg.token, { recipientIds: [L, U] });
  assert.equal(r.status, 201);
  assert.equal(r.body.replyFrom, null, '多人沒指定＝不標');
  assert.equal(askOf(r.body, L), undefined, '不標時收件人沒有 ask');
  // 沒帶 replyFrom、一位收件人：他要回覆
  r = await post(pg.token, { recipientIds: [L] });
  assert.deepEqual(r.body.replyFrom, [L]);
  assert.equal(askOf(r.body, L), true);
  // AI 指定兩位要回覆：保留第一位，其他降為知會，回應帶 warnings
  // AI 指定兩位先擋（附範例），同一草稿第 3 次才照送並降為一位
  const two = { recipientIds: [L, U], replyFrom: [L, U], text: '[通知] 兩位都要回' };
  r = await post(pg.token, two);
  assert.equal(r.status, 400, 'AI 指定兩位第 1 次擋');
  assert.equal(r.body.error.code, 'FORMAT_BLOCKED');
  assert.match(r.body.error.message, /replyFrom 一則最多一位[\s\S]*範例：[\s\S]*這則沒有送出，請照範例改好再發。$/, '附範例與重發提示');
  assert.equal((await post(pg.token, two)).status, 400, '同一草稿（第一行相同、requestId 不同）第 2 次擋');
  r = await post(pg.token, two);
  assert.equal(r.status, 201, '第 3 次照送');
  assert.ok(r.body.warnings.some(w => w.includes('已擋過 2 次，這次照送')), '照送有說明');
  assert.deepEqual(r.body.replyFrom, [L]);
  assert.equal(askOf(r.body, U), false, '第二位降為知會');
  assert.ok(r.body.warnings?.[0]?.includes('最多指定一位'), '回應帶提醒');
  const aiMsg = r.body.messageId;
  // 擋過幾次存 D1，Worker 多個執行個體共用：第 1 次在甲、第 2 次在乙、第 3 次回甲，一樣照送
  const app2 = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000' } });
  const post2 = b => app2(new Request(BASE + '/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pg.token}` },
    body: JSON.stringify({ project: '預設專案', requestId: 'r' + (++n), ...b }) }), BASE).then(x => x.status);
  const three = { recipientIds: [L, U], replyFrom: [L, U], text: '[通知] 換執行個體也要算' };
  assert.equal((await post(pg.token, three)).status, 400, '甲：第 1 次擋');
  assert.equal(await post2(three), 400, '乙：接著算第 2 次擋');
  assert.equal((await post(pg.token, three)).status, 201, '甲：第 3 次照送（不會因為換執行個體重算）');
  // 通知帶 ask
  const nl = (await call(boss.token, '/api/notifications?status=pending&limit=50')).body.items.find(x => x.messageId === aiMsg);
  assert.equal(nl.ask, true, '要回覆的人通知 ask=true');
  const nu = (await call(ux.token, '/api/notifications?status=pending&limit=50')).body.items.find(x => x.messageId === aiMsg);
  assert.equal(nu.ask, false, '知會的人通知 ask=false');
  // 開頭標籤差一個字就擋並建議正確的；差太多只警告；人類不擋
  r = await post(pg.token, { text: '[需確定] 要不要上線' });
  assert.equal(r.status, 400, '[需確定] 擋');
  assert.match(r.body.error.message, /\[需確定\] 不在清單，是要寫 \[需確認\] 嗎/, '建議正確標籤');
  r = await post(pg.token, { text: '[公告] 明天停機' });
  assert.equal(r.status, 201, '差太多的標籤不擋');
  assert.ok(r.body.warnings.some(w => w.includes('[公告] 不在清單')), '只警告');
  r = await post(pg.token, { text: '[進度 2/3] 寫測試' });
  assert.equal(r.body.warnings, undefined, '[進度 2/3] 照舊放行不警告');
  assert.equal((await post(boss.token, { text: '[需確定] 人類打錯不擋' })).status, 201, '人類不擋');
  // replyFrom 的人不在 recipientIds：一併成為收件人
  r = await post(pg.token, { recipientIds: [U], replyFrom: [L] });
  assert.ok(r.body.recipients.some(x => x.participantId === L), 'replyFrom 的人自動成為收件人');
  assert.equal(askOf(r.body, L), true); assert.equal(askOf(r.body, U), false);
  // 人類可以多人要回覆
  r = await post(boss.token, { recipientIds: [C, U], replyFrom: [C, U] });
  assert.deepEqual(r.body.replyFrom.sort(), [C, U].sort(), '人類不限制要回覆人數');
  assert.equal(r.body.warnings, undefined);
  // 人類 replyFrom 空陣列：全部知會
  r = await post(boss.token, { recipientIds: [C, U], replyFrom: [] });
  assert.deepEqual(r.body.replyFrom, []); assert.equal(askOf(r.body, C), false);
  // @所有人：一律知會；帶了 replyFrom 也忽略並提醒
  r = await post(pg.token, { audience: 'all', replyFrom: [L] });
  assert.deepEqual(r.body.replyFrom, []);
  assert.ok(r.body.recipients.every(x => x.ask === false), '@所有人全部是知會');
  assert.ok(r.body.warnings?.[0]?.includes('@所有人'));
  // 格式錯誤
  assert.equal((await post(pg.token, { recipientIds: [L], replyFrom: L })).status, 400, 'replyFrom 要是陣列');
  assert.equal((await post(pg.token, { recipientIds: [L], replyFrom: ['p_nobody'] })).status, 404, 'replyFrom 要是有效成員');
  // 冪等：沒帶 replyFrom 的重送照舊回 200
  const b0 = { project: '預設專案', requestId: 'same', text: '重送', recipientIds: [L] };
  assert.equal((await call(pg.token, '/api/messages', 'POST', b0)).status, 201);
  assert.equal((await call(pg.token, '/api/messages', 'POST', b0)).status, 200, '同內容重送＝200');
  assert.equal((await call(pg.token, '/api/messages', 'POST', { ...b0, replyFrom: [L] })).status, 409, '同 requestId 改帶 replyFrom＝不同內容');
  // 回覆＝原作者視同被 @
  const base = await post(pg.token, { recipientIds: [L], text: '請看' });
  r = await post(boss.token, { replyToMessageId: base.body.messageId, text: '好' });
  assert.ok(r.body.recipients.some(x => x.participantId === pg.participantId), '回覆時原作者自動成為收件人');
  assert.equal(askOf(r.body, pg.participantId), true, '只有他＝要回覆');
  const npg = (await call(pg.token, '/api/notifications?status=pending&limit=50')).body.items.find(x => x.messageId === r.body.messageId);
  assert.ok(npg && npg.reasons.includes('mention') && npg.reasons.includes('reply') && npg.ask === true, '原作者的通知算 mention＋reply、要回覆');
  r = await post(boss.token, { replyToMessageId: base.body.messageId, recipientIds: [U], text: '順便 UX' });
  assert.deepEqual(r.body.replyFrom, [pg.participantId], '回覆＋@別人：被回覆的人預設要回覆、其他知會');
  r = await post(boss.token, { replyToMessageId: base.body.messageId, recipientIds: [U], replyFrom: [U], text: '這次 UX 回' });
  assert.equal(askOf(r.body, pg.participantId), false, '可以改成知會');
  r = await post(pg.token, { replyToMessageId: base.body.messageId, text: '自己回自己' });
  assert.equal(r.body.recipients.length, 0, '自己回自己不加');
  r = await post(boss.token, { replyToMessageId: base.body.messageId, audience: 'all', text: '公告' });
  assert.ok(r.body.recipients.every(x => x.ask === false), '@所有人照舊全部知會');
  // 對已結案的卡發接單／進度回 warnings（不擋）
  const cd = (await call(pg.token, '/api/cards', 'POST', { title: '舊卡', type: '工作', project: '預設專案', requestId: 'oldcard' })).body;
  await call(boss.token, `/api/cards/${cd.cardId}`, 'PATCH', { status: '已完成', version: cd.version });
  r = await post(pg.token, { cardId: cd.cardId, text: '[接單] 新功能' });
  assert.equal(r.status, 201, '不擋'); assert.ok(r.body.warnings?.some(w => w.includes('新工作請開新卡')), '已結案的卡回提醒');
  r = await post(pg.token, { cardId: cd.cardId, text: '[完成] 補一句' });
  assert.ok(!r.body.warnings, '完成類訊息不提醒');
  // 讀訊息列表也帶 ask
  const list = (await call(boss.token, '/api/messages?limit=50')).body.items;
  assert.equal(list.find(m => m.messageId === aiMsg).recipients.find(x => x.participantId === U).ask, false, '列表也帶 ask');
  console.log('ask-test：全部通過');
} catch (e) {
  console.error('ask-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {} // Windows：資料庫檔還開著時刪不掉
}
