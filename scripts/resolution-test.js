// 伺服器端：人類把 [需確認] 標「已處理」（沒有回覆）
// - 提問的 AI 讀得到：GET /api/messages/:id、列表、前後文帶 resolution；MCP aigile_read、aigile_inbox、aigile_history 也帶
// - 不發新訊息、不產生通知（不叫醒任何 AI）
// - 「尚未回應」（team-status 的 unanswered）不再列這則
// - 一般訊息、還沒處理的 [需確認] 沒有 resolution
// 修正前：AI 不知道人類已經按掉，會一直等或重問；被 @ 的 AI 也一直掛在「尚未回應」
// 本機記憶體資料庫，不連正式站。用法：node scripts/resolution-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-resolution-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', unansweredMinutes: '0.0001' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let rid = 0;
const tool = async (token, name, args) => {
  const r = await call(token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.status, 200, `${name} HTTP ${r.status}`);
  const text = r.body.result.content[0].text;
  assert.ok(!r.body.result.isError, `${name} 錯誤：${text}`);
  return JSON.parse(text);
};
const count = async () => ({ msgs: (await db.get('SELECT COUNT(*) AS n FROM messages')).n, notes: (await db.get('SELECT COUNT(*) AS n FROM notifications')).n });

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body, L = boss.participant.participantId;
  const mk = async name => { const a = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    return { id: a.participantId, tok: await testToken(db, a.participantId) }; };
  const A = await mk('提問助手'), B = await mk('被問助手');
  const cur0 = (await call(A.tok, '/api/messages?limit=1')).body.nextCursor;
  // A 問人類一題、問 B 一題；另發一則一般訊息
  const q1 = (await call(A.tok, '/api/messages', 'POST', { requestId: 'q1', project: '預設專案', recipientIds: [L], replyFrom: [L], text: '[需確認] 要不要先上線 MARK-Q1？\n選項：\nA. 上線\nB. 再等等' })).body;
  const q2 = (await call(A.tok, '/api/messages', 'POST', { requestId: 'q2', project: '預設專案', recipientIds: [B.id], replyFrom: [B.id], text: '[需確認] B 你那邊測完了嗎 MARK-Q2' })).body;
  const plain = (await call(A.tok, '/api/messages', 'POST', { requestId: 'p1', project: '預設專案', recipientIds: [L], replyFrom: [], text: '[通知] 一般訊息' })).body;
  const unassigned = (await call(A.tok, '/api/messages', 'POST', { requestId: 'unassigned', project: '預設專案', recipientIds: [B.id, L], text: '[需確認] 誰可以確認時程？' })).body;
  const fyi = (await call(A.tok, '/api/messages', 'POST', { requestId: 'fyi', project: '預設專案', recipientIds: [B.id], replyFrom: [], text: '[需確認] 尚未指定回覆人' })).body;
  const reviewerJ = (await call(null, '/api/join', 'POST', { name: '驗收人', role: 'QA' })).body, reviewer = reviewerJ.participant.participantId;
  const mixed = (await call(boss.token, '/api/messages', 'POST', { requestId: 'mixed', project: 'all', recipientIds: [B.id, reviewer], replyFrom: [B.id, reviewer], text: '[需確認] 共同確認時程' })).body;
  assert.ok(mixed.messageId, JSON.stringify(mixed));
  assert.deepEqual((await call(boss.token, `/api/messages/${mixed.messageId}`)).body.replyFrom, [B.id, reviewer]);
  assert.ok(q1.messageId && q2.messageId && plain.messageId && unassigned.messageId && fyi.messageId, '發文成功');
  await new Promise(r => setTimeout(r, 30));
  let team = (await call(boss.token, '/api/team-status')).body;
  assert.ok(team.unanswered.some(u => u.messageId === q2.messageId && u.participantId === B.id), '處理前：B 列在尚未回應');
  const decisionIds = team.decisions.map(d => d.messageId);
  assert.ok(decisionIds.includes(q1.messageId), '指定人類時列入等人決定');
  assert.ok(!decisionIds.includes(mixed.messageId), '同時指定 AI 和別的人類，不進管理員的清單');
  const reviewerTok = reviewerJ.token;
  assert.ok((await call(reviewerTok, '/api/team-status')).body.decisions.some(d => d.messageId === mixed.messageId), '同時指定 AI 和人類時，列進被問的人類的清單');
  assert.ok(!decisionIds.includes(q2.messageId), '只指定 AI 時不列入等人決定');
  assert.ok(decisionIds.includes(unassigned.messageId) && decisionIds.includes(fyi.messageId), '未指定與空清單都照舊列入');
  const notices = (await call(B.tok, '/api/notifications?status=pending')).body.items;
  assert.ok(notices.some(n => n.messageId === q2.messageId && n.wake), '只問 AI 的這則通知仍會叫醒 B');
  assert.equal((await call(A.tok, `/api/messages/${q1.messageId}`)).body.resolution, undefined, '還沒處理：沒有 resolution');

  // 人類標已處理（網頁批次就是逐則呼叫同一個端點）
  const before = await count();
  for (const id of [q1.messageId, q2.messageId]) assert.equal((await call(boss.token, `/api/decisions/${id}/resolve`, 'POST')).status, 200, '標已處理');
  const after = await count();
  assert.deepEqual(after, before, '不發新訊息、不產生通知（不叫醒任何 AI）：' + JSON.stringify({ before, after }));
  assert.equal((await call(A.tok, '/api/notifications/count?wake=1')).body.pending ?? 0, 0, '提問的 AI 沒有要叫醒的通知');

  // 提問的 AI 讀得到
  const one = (await call(A.tok, `/api/messages/${q1.messageId}`)).body;
  assert.equal(one.resolution?.state, '已處理（未回覆）', 'GET 單則帶 resolution：' + JSON.stringify(one.resolution));
  assert.equal(one.resolution.by.participantId, L); assert.equal(one.resolution.by.name, '王大明'); assert.ok(Date.parse(one.resolution.at), '有處理時間');
  const list = (await call(A.tok, `/api/messages?after=${cur0}&limit=50`)).body.items;
  assert.ok(list.find(m => m.messageId === q2.messageId)?.resolution && !('resolution' in list.find(m => m.messageId === plain.messageId)), '列表：已處理的帶、一般訊息不帶');
  const around = (await call(A.tok, `/api/messages/${plain.messageId}/around?n=5`)).body.items;
  assert.ok(around.find(m => m.messageId === q1.messageId)?.resolution, '前後文也帶');
  const r1 = await tool(A.tok, 'aigile_read', { messageId: q1.messageId });
  assert.equal(r1.resolution?.state, '已處理（未回覆）', 'aigile_read 帶 resolution');
  const inbox = await tool(B.tok, 'aigile_inbox', { after: cur0 });
  const iq2 = inbox.messages.find(m => m.messageId === q2.messageId);
  assert.equal(iq2?.resolution?.state, '已處理（未回覆）', 'aigile_inbox 帶 resolution：' + JSON.stringify(iq2));
  const hist = await tool(A.tok, 'aigile_history', { hours: 1 });
  assert.ok(hist.messages.find(m => m.messageId === q1.messageId)?.resolution, 'aigile_history 帶 resolution');

  // 尚未回應、等人決定都清掉
  team = (await call(boss.token, '/api/team-status')).body;
  assert.ok(!team.unanswered.some(u => u.messageId === q2.messageId), '處理後：B 不再列尚未回應');
  assert.ok(!team.decisions.some(d => d.messageId === q1.messageId || d.messageId === q2.messageId), '處理後：不在等人決定');
  const mt = await tool(A.tok, 'aigile_team', {});
  assert.ok(!JSON.stringify(mt.unanswered || []).includes(q2.messageId), 'aigile_team 的 unanswered 也清掉');

  // 規格寫了 AI 要怎麼做
  const rules = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(rules, /「已處理（未回覆）」）＝[^\n]*當暫緩，不再等、不重問/, '規格：已處理＝暫緩');
  assert.ok([...rules].length <= 6000, '規則版規格 ≤ 6,000 字：' + [...rules].length);
  console.log('resolution-test：全部通過');
} catch (e) {
  console.error('resolution-test 失敗：', e.message, (e.stack || '').split('\n').slice(1, 4).join(' | '));
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
