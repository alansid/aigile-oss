// 「要你處理」的 [需確認]：已處理／已回覆馬上不列（跨程式快取再查）、只進被問的人的清單
// 團隊狀態快取是每份程式各自的；別份程式按「已處理」或人類回覆後，這份快取還在也要馬上不列
// [需確認] 只進被問的人：指定人類 → 那幾位；沒指定 → 專案 leader，沒有 leader 給管理員；全指定 AI → 不列
// 本機記憶體資料庫，不連正式站。用法：node scripts/decision-routing-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-decision-routing-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const mkApp = cacheMs => createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: String(cacheMs) } });
const live = mkApp(0), cachedA = mkApp(600_000), otherB = mkApp(600_000); // A、B 模擬正式站的兩份程式
const callOn = app => async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const call = callOn(live), onA = callOn(cachedA), onB = callOn(otherB);
const asks = async (c, tok) => {
  const r = await c(tok, '/api/team-status');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.decisions.every(d => !('_ask' in d)), '內部欄位 _ask 不回傳');
  return r.body.decisions.filter(d => d.messageId).map(d => d.messageId);
};

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 第一位人類＝管理員
  const xiao = (await call(null, '/api/join', 'POST', { name: '小安', role: 'QA' })).body;
  const percy = (await call(null, '/api/join', 'POST', { name: 'Percy', role: 'BA' })).body;
  const L = liu.participant.participantId, X = xiao.participant.participantId, P = percy.participant.participantId;
  const M = changes => call(liu.token, '/api/members/matrix', 'PUT', { changes });
  assert.equal((await M([{ id: X, projects: ['預設專案'] }, { id: P, projects: ['預設專案'] }])).status, 200, '小安、Percy 加進專案');
  const mk = async name => { const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    return { id: a.participantId, tok: await testToken(db, a.participantId) }; };
  const A = await mk('提問助手'), B = await mk('被問助手');
  const post = async (rid, body, tok = A.tok) => { const r = await call(tok, '/api/messages', 'POST', { requestId: rid, project: '預設專案', ...body }); assert.ok(r.body.messageId, JSON.stringify(r.body)); return r.body.messageId; };
  const qLiu = await post('qLiu', { recipientIds: [L], replyFrom: [L], text: '[需確認] 問志明 MARK-LIU' });
  const qXiao = await post('qXiao', { recipientIds: [X], replyFrom: [X], text: '[需確認] 問小安 MARK-XIAO' });
  const qNone = await post('qNone', { recipientIds: [L, X], text: '[需確認] 沒指定誰回 MARK-NONE' });
  const qAi = await post('qAi', { recipientIds: [B.id], replyFrom: [B.id], text: '[需確認] 問 AI MARK-AI' });
  const qMix = await post('qMix', { recipientIds: [B.id, X], replyFrom: [B.id, X], text: '[需確認] 問 AI 和小安 MARK-MIX' }, liu.token); // AI 一則只能 replyFrom 一位，人類可以多位

  // ---------- 沒有 leader ----------
  assert.deepEqual((await asks(call, liu.token)).sort(), [qLiu, qNone].sort(), '管理員：問他的＋沒指定的（專案沒有 leader）');
  assert.deepEqual((await asks(call, xiao.token)).sort(), [qXiao, qMix].sort(), '小安：只有問他的（含同時問 AI 的）');
  assert.deepEqual(await asks(call, percy.token), [], 'Percy：沒人問他');
  const viaMcp = (await call(A.tok, '/api/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aigile_team', arguments: {} } })).body;
  const teamForAi = JSON.parse(viaMcp.result.content[0].text);
  assert.deepEqual(teamForAi.decisions.filter(d => d.messageId).map(d => d.messageId).sort(), [qLiu, qNone].sort(), 'AI 看到的是所屬人類（志明）的清單');
  assert.ok(!(await asks(call, liu.token)).includes(qAi) && !(await asks(call, xiao.token)).includes(qAi), '全指定 AI：誰的清單都不列');

  // ---------- 專案有 leader → 沒指定的改給 leader ----------
  assert.equal((await M([{ id: P, leaderOf: ['預設專案'] }])).status, 200, 'Percy 當專案 leader');
  assert.deepEqual(await asks(call, percy.token), [qNone], 'leader：沒指定的給他');
  assert.deepEqual(await asks(call, liu.token), [qLiu], '有 leader 後，管理員不再收到沒指定的');

  // ---------- 別份程式按「已處理」、人類回覆，這份快取馬上不列 ----------
  assert.ok((await asks(onA, liu.token)).includes(qLiu), 'A 先建好快取');
  assert.ok((await asks(onA, xiao.token)).includes(qXiao));
  assert.equal((await onB(liu.token, `/api/decisions/${qLiu}/resolve`, 'POST')).status, 200, '在 B 按已處理');
  assert.ok(!(await asks(onA, liu.token)).includes(qLiu), 'A 的快取還在，也馬上不列已處理的');
  const rep = await onB(xiao.token, '/api/messages', 'POST', { requestId: 'rx', project: '預設專案', replyToMessageId: qXiao, text: '可以，照 A' });
  assert.ok(rep.body.messageId, JSON.stringify(rep.body));
  const xNow = await asks(onA, xiao.token);
  assert.ok(!xNow.includes(qXiao) && xNow.includes(qMix), '在 B 回覆後，A 馬上不列那則，其他照舊');
  const aiRep = await onB(B.tok, '/api/messages', 'POST', { requestId: 'rb', project: '預設專案', replyToMessageId: qMix, text: '[進度] 我測完了' });
  assert.ok(aiRep.body.messageId);
  assert.ok((await asks(onA, xiao.token)).includes(qMix), '非 PO 的 AI 回覆不算結案');

  console.log('decision-routing-test：全部通過（跨程式已處理／回覆馬上不列、指定人類、沒指定給 leader／管理員、全 AI 不列、AI 看所屬人類清單）');
} catch (e) {
  console.error('decision-routing-test 失敗：', e);
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
