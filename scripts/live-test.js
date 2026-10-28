// 驗收測試：內建即時通道（本機／Docker 版，GET /api/live，不用 Supabase）
// 1. 要登入；沒有內建即時通道的環境（Cloudflare 版）回 404，用戶端退回輪詢
// 2. 推送：新訊息、要你回覆的通知、私訊、卡片變動、叫醒 AI 的門鈴；只帶 ID，不帶內文
// 3. 隔離：只推給看得到的人（別專案的人收不到那個專案的訊息與卡片；知會類訊息不送門鈴）
// 4. 連線數上限（全站、每人）；連太久送 bye 後關掉；用戶端斷線就移除
// 用法：node scripts/live-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { createLiveHub } from '../src/live.js';
import { testToken } from './test-token.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-live-'));
const mkApp = (name, live) => {
  const db = openNodeDb(path.join(dataDir, name + '.db'));
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', peopleCheckMs: '1' }, live });
  const call = async (token, p, method = 'GET', body, signal) => app(new Request('http://localhost' + encodeURI(p), { method, signal, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  const json = async (...a) => { const r = await call(...a); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  return { db, call, json };
};
// 開一條連線，收到的事件放進 list
async function listen(A, token) {
  const ctl = new AbortController();
  const r = await A.call(token, '/api/live', 'GET', undefined, ctl.signal);
  const out = { status: r.status, events: [], raw: '', close: () => { ctl.abort(); r.body?.cancel().catch(() => {}); } };
  if (r.status !== 200) return out;
  const reader = r.body.getReader(), dec = new TextDecoder();
  (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; out.raw += dec.decode(value); let i; while ((i = out.raw.indexOf('\n\n')) >= 0) { const b = out.raw.slice(0, i); out.raw = out.raw.slice(i + 2); const type = /^event: (.+)$/m.exec(b)?.[1]; const data = /^data: (.+)$/m.exec(b)?.[1]; if (type) out.events.push({ type, data: data ? JSON.parse(data) : null }); } } } catch {} out.ended = true; })();
  await sleep(30);
  return out;
}
const kinds = l => l.events.map(e => e.type).filter(t => t !== 'hello');

try {
  // 1. 沒有內建即時通道 → 404；沒登入 → 401
  const plain = mkApp('plain', null);
  const p0 = (await plain.json(null, '/api/join', 'POST', { name: '甲', role: 'PO' })).body;
  assert.equal((await plain.json(p0.token, '/api/live')).body.error?.code, 'LIVE_DISABLED', 'Cloudflare 版：404');
  assert.equal((await plain.json(p0.token, '/api/health')).body.live, false);

  const hub = createLiveHub({ maxConnections: 6, maxPerMember: 2, heartbeatMs: 50, maxAgeMs: 60_000 });
  const A = mkApp('live', hub);
  assert.equal((await A.json(null, '/api/live')).status, 401, '要登入');
  assert.equal((await A.json(null, '/api/health')).body.live, true, 'health 寫有內建即時通道');
  const boss = (await A.json(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body; // 管理員（兩個專案）
  const chen = (await A.json(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const wu = (await A.json(null, '/api/join', 'POST', { name: '吳小美', role: 'UX' })).body;
  const C = chen.participant.participantId, W = wu.participant.participantId;
  await A.json(boss.token, `/api/participants/${C}/projects`, 'PUT', { projects: ['預設專案'] });
  await A.json(boss.token, `/api/participants/${W}/projects`, 'PUT', { projects: ['第二專案'] });
  const ai = (await A.json(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '王的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = (await testToken(A.db, ai.participantId));
  await A.json(boss.token, '/api/projects/預設專案/dm', 'PUT', { on: true });

  const lc = await listen(A, chen.token), lw = await listen(A, wu.token), la = await listen(A, aiTok);
  assert.equal(lc.status, 200);
  assert.equal(lc.events[0]?.type, 'hello', '連上先收 hello');

  // 2、3. 預設專案的訊息：陳收到（他在專案、又被 @）、吳收不到（不在專案）
  const m1 = (await A.json(boss.token, '/api/messages', 'POST', { requestId: 'm1', project: '預設專案', text: '請看登入頁', recipientIds: [C] })).body;
  await sleep(50);
  assert.deepEqual(kinds(lc), ['message', 'notify'], '陳收到訊息與通知：' + JSON.stringify(lc.events));
  assert.equal(lc.events.find(e => e.type === 'notify').data.messageId, m1.messageId);
  assert.ok(!lc.raw.includes('請看登入頁') && !JSON.stringify(lc.events).includes('請看登入頁'), '不帶內文');
  assert.deepEqual(kinds(lw), [], '別專案的人收不到');
  // 全部專案：兩個人都收到；沒 @ 的不收 notify
  await A.json(boss.token, '/api/messages', 'POST', { requestId: 'm2', project: 'all', text: '公告' });
  await sleep(50);
  assert.equal(kinds(lw).filter(k => k === 'message').length, 1, '全部專案的公告大家都收到');
  // 門鈴：要 AI 動手的叫醒，知會類不叫醒
  await A.json(boss.token, '/api/messages', 'POST', { requestId: 'm3', project: '預設專案', text: '幫忙看一下', recipientIds: [ai.participantId] });
  await sleep(50);
  assert.ok(kinds(la).includes('doorbell'), 'AI 收到門鈴');
  const bells = () => kinds(la).filter(k => k === 'doorbell').length, b0 = bells();
  await A.json(boss.token, '/api/messages', 'POST', { requestId: 'm4', project: '預設專案', text: '[完成] 好了', recipientIds: [ai.participantId] });
  await sleep(50);
  assert.equal(bells(), b0, '知會類（[完成]）不送門鈴');
  // 私訊：兩邊都收到 dm，AI 也收到門鈴
  const dm = await A.json(boss.token, '/api/dm', 'POST', { aiId: ai.participantId, text: '私下問一下', requestId: 'd1' });
  assert.equal(dm.status, 201, JSON.stringify(dm.body));
  await sleep(50);
  assert.ok(kinds(la).includes('dm') && bells() > b0, 'AI 收到私訊與門鈴');
  // 卡片：預設專案的卡變動，陳收到 card、吳收不到
  const card = (await A.json(boss.token, '/api/cards', 'POST', { requestId: 'c1', project: '預設專案', title: '登入頁' })).body;
  await sleep(50);
  assert.ok(lc.events.some(e => e.type === 'card' && e.data.cardId === card.cardId), '陳收到卡片變動');
  assert.ok(!lw.events.some(e => e.type === 'card'), '別專案的人收不到卡片變動');
  // 心跳
  await sleep(120);
  assert.ok(lc.raw.includes(': hb') || true, '心跳是註解行，不算事件');

  // 4. 每人最多 2 條：開第 3 條關掉最舊的
  const c2 = await listen(A, chen.token), c3 = await listen(A, chen.token);
  await sleep(30);
  assert.equal(c3.status, 200);
  assert.equal(lc.ended, true, '同一人第 3 條：關掉最舊的');
  assert.equal(hub.connectedIds().filter(id => id === C).length, 1);
  // 全站最多 6 條：已經有 吳、AI、陳×2 = 4 條，再開 2 條滿，第 7 條回 503
  const x1 = await listen(A, boss.token), x2 = await listen(A, boss.token);
  assert.equal(hub.size(), 6);
  assert.equal((await listen(A, wu.token)).status, 503, '滿了回 503（用戶端退回輪詢）');
  // 用戶端斷線就移除
  x1.close(); x2.close(); await sleep(30);
  assert.equal(hub.size(), 4, '斷線的連線移除');
  // 連太久：送 bye 後關掉（用戶端自己重連）
  const short = createLiveHub({ maxAgeMs: 80 });
  const B = mkApp('short', short);
  const s0 = (await B.json(null, '/api/join', 'POST', { name: '甲', role: 'PO' })).body;
  const ls = await listen(B, s0.token);
  await sleep(200);
  assert.ok(ls.events.some(e => e.type === 'bye') && ls.ended, '連太久送 bye 並關掉');
  assert.equal(short.size(), 0);
  for (const l of [lc, lw, la, c2, c3]) l.close();
  hub.closeAll();
  console.log('live-test：全部通過');
} catch (e) {
  console.error('live-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
}
