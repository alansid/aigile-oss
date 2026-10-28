// 驗收測試：卡號只留專案卡號，不再顯示、不再發全站流水號 C-xxx；舊的 C-xxx 照樣當輸入查得到
// 修正前：大家寫 C-xxx，網頁顯示 MAIN-229，對不上；伺服器代發的 [交接]、API 回的 cardId 都是 C-xxx
// 移專案、改代號後舊號仍可查、號碼不回收：見 card-key-test.js。這裡測伺服器代發文字、各 API 回傳、工作記憶、版本紀錄與網頁
// 用法：node scripts/card-number-test.js（網頁部分需要 Chrome 或 Edge；找不到就只跑伺服器部分）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { startKit, findBrowser, until } from './browser-kit.js';
const OLD1 = 'C-' + (100 + 1), OLD2 = 'C-' + (100 + 2); // 舊編號＝C-(seq+100)

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-t1-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
// 版本紀錄：commit 標題寫舊的 C-xxx、新的 MAIN-2，還有不是卡號的 UTF-8
const releases = { generatedAt: '2026-10-22T00:00:00.000Z', current: '0.2.0', incidents: [{ fix: OLD2, fixVersion: '0.2.0', cause: OLD1, causeVersion: '0.1.0', note: 'x' }],
  items: [{ version: '0.2.0', at: '2026-10-22T00:00:00.000Z', cards: ['MAIN-2', 'UTF-8'], commits: [], causes: [], fixes: [{ cause: OLD1, causeVersion: '0.1.0', note: 'x' }] },
    { version: '0.1.0', at: '2026-10-21T00:00:00.000Z', cards: [OLD1], commits: [], causes: [{ fix: OLD2, fixVersion: '0.2.0', note: 'x' }], fixes: [] }] };
const app = createApp({ db, storage: dbStorage(db), docText: '', releases, config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const LEGACY = /\bC-\d{3,}\b/;

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const chenId = chen.participant.participantId;
  await call(boss.token, `/api/participants/${chenId}/projects`, 'PUT', { projects: ['預設專案'] });
  const r = (await call(boss.token, '/api/roles')).body.items.find(x => x.key === 'PG');
  const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: r.role, name: '程式助手', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body;

  const a = (await call(boss.token, '/api/cards', 'POST', { requestId: 'a', project: '預設專案', title: '第一張' })).body;
  const b = (await call(boss.token, '/api/cards', 'POST', { requestId: 'b', project: '預設專案', title: '第二張', ownerId: ai.participantId, status: '進行中' })).body;
  assert.deepEqual([a.cardId, b.cardId], ['MAIN-1', 'MAIN-2'], 'cardId 就是專案卡號');
  assert.equal(a.legacyId, OLD1, '舊編號只放 legacyId（對舊訊息用）');

  // 1. 伺服器代發的 [交接] 寫專案卡號
  const ho = (await call(boss.token, `/api/cards/${a.cardId}/handover`, 'POST', { toId: chenId, note: '交給你' })).body;
  const hoText = (await call(boss.token, `/api/messages/${ho.handoverMessageId}`)).body.text;
  assert.ok(hoText.startsWith('[交接] 【預設專案】MAIN-1 第一張'), '交接訊息寫 MAIN-1：' + hoText.slice(0, 40));
  assert.ok(!LEGACY.test(hoText), '交接訊息不出現 C-xxx');
  // 卡片動作的 [通知]（改負責人）也一樣
  await call(boss.token, `/api/cards/${a.cardId}`, 'PATCH', { ownerId: ai.participantId });
  const notes = (await call(ai.token, '/api/notifications?status=pending')).body.items;
  assert.ok(notes.length && notes.every(n => !LEGACY.test(n.preview)), '通知內容不出現 C-xxx：' + notes.map(n => n.preview.slice(0, 30)).join('｜'));
  assert.ok(notes.some(n => /MAIN-1/.test(n.preview)), '通知寫專案卡號');

  // 2. 團隊狀態的「在做」、退回清單
  const team = (await call(boss.token, '/api/team-status')).body;
  assert.equal(team.members.find(m => m.participantId === ai.participantId).status?.cardId, 'MAIN-2', '團隊狀態在做的卡是專案卡號');

  // 3. 發文帶卡號：兩種都收；舊訊息不改寫
  const m1 = (await call(boss.token, '/api/messages', 'POST', { requestId: 'm1', project: '預設專案', cardId: OLD2, text: `[通知] 舊寫法 ${OLD2} 的訊息`, recipientIds: [] })).body;
  assert.equal(m1.text, `[通知] 舊寫法 ${OLD2} 的訊息`, '內文照原樣，不改寫');
  assert.ok((await call(boss.token, '/api/cards/MAIN-2')).body.messageIds.includes(m1.messageId), '用舊編號掛卡，掛到 MAIN-2');

  // 4. 工作記憶收專案卡號（修正前只收 C-數字，AI 改寫 PLAT 會 400）
  const st = await call(ai.token, '/api/me/state', 'PUT', { currentTask: { title: '做 MAIN-2', cardId: 'MAIN-2' } });
  assert.equal(st.status, 200, '工作記憶 cardId 收 MAIN-2：' + JSON.stringify(st.body.error || ''));
  assert.equal((await call(ai.token, '/api/me/state', 'PUT', { currentTask: { title: '舊的', cardId: OLD2 } })).status, 200, '舊的 C-xxx 也收');
  assert.equal((await call(ai.token, '/api/me/state', 'PUT', { currentTask: { title: 'x', cardId: '第二張' } })).status, 400, '不是卡號擋下');

  // 6. 版本紀錄：舊 C-xxx 換成專案卡號；不是卡號的拿掉
  const rel = (await call(boss.token, '/api/releases')).body;
  assert.deepEqual(rel.items.map(x => x.cards), [['MAIN-2'], ['MAIN-1']], '版本的卡號');
  assert.deepEqual([rel.incidents[0].fix, rel.incidents[0].cause, rel.items[0].fixes[0].cause, rel.items[1].causes[0].fix], ['MAIN-2', 'MAIN-1', 'MAIN-1', 'MAIN-2'], '事故對照的卡號');

  // 7. 刪 AI：退回清單與通知寫專案卡號
  const del = (await call(boss.token, `/api/my-ais/${ai.participantId}/delete`, 'POST', { confirmName: '程式助手' })).body;
  assert.deepEqual(del.unassignedCards, ['MAIN-1', 'MAIN-2'], '刪 AI 後退回的卡');

  // 8. 規格、MCP 工具說明只寫專案卡號
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.ok(!/\bC-\d{3}\b|C-xxx/.test(spec), '規格不再寫 C-xxx 範例');
  const mcp = fs.readFileSync(new URL('../src/mcp.js', import.meta.url), 'utf8');
  assert.ok(!/'[^'\n]*C-\d+[^'\n]*'/.test(mcp.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')), 'MCP 工具說明沒有 C-xxx');
  console.log('card-number-test：伺服器部分通過');
} catch (e) {
  console.error('card-number-test 失敗：', e.message, (e.stack.split('\n').find(l => l.includes('card-number-test.js')) || '').trim());
  process.exitCode = 1;
}

// 網頁：舊訊息內文的 C-xxx 顯示成 PLAT 膠囊（原文不改）；卡片抽屜不再並列 C-xxx
if (!process.exitCode && findBrowser()) {
  const kit = await startKit('t1');
  try {
    const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
    const c = (await kit.call(boss.token, '/api/cards', 'POST', { requestId: 'w1', project: '預設專案', title: '網頁的卡' })).body;
    await kit.call(boss.token, '/api/messages', 'POST', { requestId: 'w2', project: '預設專案', recipientIds: [], text: `[通知] 舊訊息提到 ${c.legacyId} 這張` });
    const { js, login } = await kit.browser();
    await login(boss.token);
    await js("history.pushState(null, '', '/p/main/messages'); dispatchEvent(new PopStateEvent('popstate')); true");
    await until(() => js("[...document.querySelectorAll('#messages .cap')].some(b => b.textContent.includes('MAIN-1'))"), 10000, '舊訊息的 C-xxx 轉成 MAIN 膠囊');
    const caps = await js("[...document.querySelectorAll('#messages .cap')].map(b => b.textContent + '|' + (b.title || ''))");
    assert.ok(caps.every(t => !/C-\d/.test(t)), '膠囊和提示都不顯示 C-xxx：' + caps.join('、'));
    await js("document.querySelector('#messages .cap').click(); true");
    await until(() => js("!!document.querySelector('.drawer-titles')"), 8000, '卡片抽屜');
    const head = await js("document.querySelector('.drawer-titles').textContent");
    assert.ok(/MAIN-1/.test(head) && !/C-\d/.test(head), '抽屜標題只有專案卡號：' + head.slice(0, 60));
    console.log('card-number-test：全部通過');
  } catch (e) {
    console.error('card-number-test 網頁失敗：', e.message);
    process.exitCode = 1;
  } finally {
    await kit.stop();
  }
} else if (!process.exitCode) console.log('card-number-test：全部通過（找不到 Chrome／Edge，網頁部分略過）');
