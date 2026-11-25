// 驗收測試：AI 對沒有負責人的卡 [接單] 時，自動把負責人設成自己
// 用法：node scripts/card-claim-owner-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-claim-owner-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let seq = 0;

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const mkAi = async name => {
    const a = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    return { id: a.participantId, name, tok: await testToken(db, a.participantId) };
  };
  const A = await mkAi('甲PG'), B = await mkAi('乙PG');
  const post = (tok, text, cardId) => call(tok, '/api/messages', 'POST', { project: '預設專案', requestId: 'm' + (++seq), text, cardId, recipientIds: [], replyFrom: [] });
  const get = async id => (await call(boss.token, `/api/cards/${id}`)).body;

  // 1) 未指派的工作卡（待處理）：AI 發 [接單] → 自動設為負責人、留紀錄、並改為進行中
  const c1 = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c1', project: '預設專案', title: '未指派待處理卡', status: '待處理' })).body;
  assert.equal(c1.owner, null);
  let r = await post(A.tok, '[接單] 我來做這張', c1.cardId);
  assert.equal(r.status, 201);
  assert.equal(r.body.cardStatus, '進行中', '自動設成負責人後應同步改為進行中');
  let d = await get(c1.cardId);
  assert.equal(d.owner?.participantId, A.id, '負責人自動設為發文的 AI');
  assert.equal(d.claim?.by?.participantId, A.id, '同時記認領');
  assert.equal(d.status, '進行中');
  assert.ok(d.log.some(l => l.text.includes('甲PG') && l.text.includes('自動認領為負責人')), '卡上留紀錄');

  // 2) 未指派的阻塞卡（受阻）：AI 發 [接單] → 自動設為負責人、維持受阻
  const c2 = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c2', project: '預設專案', type: '阻塞', title: '未指派阻塞卡', blocker: '等外部' })).body;
  assert.equal(c2.owner, null);
  r = await post(A.tok, '[接單] 接手排查', c2.cardId);
  assert.equal(r.status, 201);
  d = await get(c2.cardId);
  assert.equal(d.owner?.participantId, A.id, '阻塞卡無負責人時也自動設為自己');
  assert.equal(d.status, '受阻', '受阻狀態維持不變');

  // 3) 已有負責人的卡：另一個 AI 發 [接單] → 只記認領、不改負責人
  const c3 = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c3', project: '預設專案', title: '已有負責人卡', ownerId: A.id, status: '待處理' })).body;
  r = await post(B.tok, '[接單] 幫忙接手', c3.cardId);
  assert.equal(r.status, 201);
  d = await get(c3.cardId);
  assert.equal(d.owner?.participantId, A.id, '已有負責人不改');
  assert.equal(d.claim?.by?.participantId, B.id, '照舊記認領');

  // 4) 未指派但已被別人認領（例如先發 [進度]）：另一個 AI 發 [接單] → 回 cardClaim、不搶負責人
  const c4 = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c4', project: '預設專案', title: '未指派已有人做', status: '待處理' })).body;
  await post(A.tok, '[進度] 先看了一下', c4.cardId);
  d = await get(c4.cardId);
  assert.equal(d.owner, null, '[進度] 不自動設負責人');
  assert.equal(d.claim?.by?.participantId, A.id, '[進度] 記認領');
  r = await post(B.tok, '[接單] 我來做', c4.cardId);
  assert.equal(r.body.cardClaim?.participantId, A.id, '已被別人認領時回 cardClaim');
  d = await get(c4.cardId);
  assert.equal(d.owner, null, '已被別人認領時不搶負責人');

  // 5) 人類發 [接單] 不自動改負責人
  const c5 = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c5', project: '預設專案', title: '人類接單卡', status: '待處理' })).body;
  await post(boss.token, '[接單] 人類自己接', c5.cardId);
  assert.equal((await get(c5.cardId)).owner, null, '人類發 [接單] 不自動設負責人');

  // 6) 決策卡、人類紀錄卡、已結案卡不改負責人
  const dec = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c6', project: '預設專案', type: '決策', title: '未指派決策卡', question: '選哪個？', deciderId: boss.participant.participantId })).body;
  await post(A.tok, '[接單] 決策卡測試', dec.cardId);
  assert.equal((await get(dec.cardId)).owner, null, '決策卡不改負責人');

  const note = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c7', project: '預設專案', type: '人類紀錄', title: '人類紀錄卡' })).body;
  await post(A.tok, '[接單] 人類紀錄測試', note.cardId);
  assert.equal((await get(note.cardId)).owner, null, '人類紀錄卡不改負責人');

  const closed = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c8', project: '預設專案', title: '已結案未指派卡', status: '待處理' })).body;
  await call(boss.token, `/api/cards/${closed.cardId}`, 'PATCH', { status: '已完成', version: closed.version });
  await post(A.tok, '[接單] 已結案測試', closed.cardId);
  assert.equal((await get(closed.cardId)).owner, null, '已結案卡不改負責人');

  console.log('card-claim-owner-test：全部通過');
} catch (e) {
  console.error('card-claim-owner-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
