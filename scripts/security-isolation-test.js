// 安全修補（公開部署前的安全檢查找到的高風險問題）：
// 1. 沒加入專案的人用 GET /api/cards?since= 讀不到別專案的卡（修正前：過時提示會把別專案的卡帶回來）
// 2. 回覆看不到的訊息＝不存在（修正前：回覆別專案的訊息就把話發進那個專案）；不屬於的專案不繼承
// 3. 團隊狀態「尚未回應」只列看得到的訊息（修正前：別專案的訊息 ID 會給所有人）
// 4. 名字、願望標題放進視窗標題要跳脫（修正前：名字含 HTML，管理員打開確認視窗就執行，可偷 Token）
// 5. 工作記憶的訊息游標裡面要是整數（修正前：可夾帶 HTML，所有人打開團隊狀態就執行）
// 用法：node scripts/security-isolation-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-sec-iso-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', cardStaleHours: '0.0002', unansweredMinutes: '0.0001' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const S = { duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
let n = 0; const rid = () => 'sec_' + (++n);
try {
  const admin = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body.token;
  const pB = (await call(admin, '/api/projects', 'POST', { name: '機密專案', code: 'SEC' })).body.id;
  assert.ok(pB, '建專案 B');
  const bob = (await call(null, '/api/join', 'POST', { name: '陳大文' })).body;
  const eve = (await call(null, '/api/join', 'POST', { name: '新來的' })).body;
  assert.equal((await call(admin, `/api/participants/${bob.participant.participantId}/projects`, 'PUT', { projects: [pB] })).status, 200);
  await call(admin, `/api/participants/${eve.participant.participantId}/projects`, 'PUT', { projects: [] }).catch(() => {});
  const eveProjects = (await call(eve.token, '/api/me')).body.projects || [];
  assert.ok(!eveProjects.includes(pB), '新來的不在 B');
  // 跨專案 AI（所有人都看得到它），B 的訊息 @ 它
  const ai = (await call(admin, '/api/my-ais', 'POST', { projects: [pB], roleKey: 'PO', role: 'PO', name: '跨專案助手', ...S })).body;
  await call(admin, '/api/members/matrix', 'PUT', { changes: [{ id: ai.participantId, crossRole: true }] });

  // B 的卡與訊息
  const card = (await call(bob.token, '/api/cards', 'POST', { requestId: rid(), project: pB, title: '機密：合併計畫', reason: '機密原因', next: '機密下一步' })).body;
  assert.ok(card.cardId, '建卡：' + JSON.stringify(card));
  const secret = (await call(bob.token, '/api/messages', 'POST', { requestId: rid(), project: pB, text: '只有 B 看得到', recipientIds: [ai.participantId] })).body;
  await sleep(1200);
  await call(bob.token, '/api/messages', 'POST', { requestId: rid(), project: pB, text: '卡片進度', cardId: card.cardId });
  await sleep(300);

  // 1. since 增量不帶出別專案的卡
  const since = await call(eve.token, '/api/cards?since=2000-01-01T00:00:00.000Z');
  assert.equal(since.status, 200);
  assert.ok(!(since.body.items || []).some(c => c.cardId === card.cardId || /機密/.test(c.title || '')), '讀不到 B 的卡：' + JSON.stringify((since.body.items || []).map(c => c.title)));
  const bobSince = await call(bob.token, '/api/cards?since=2000-01-01T00:00:00.000Z');
  assert.ok(bobSince.body.items.some(c => c.cardId === card.cardId), 'B 的成員照樣讀得到（過時提示照舊）');

  // 3. 團隊狀態不給看不到的訊息 ID
  const ts = await call(eve.token, '/api/team-status');
  assert.ok(!(ts.body.unanswered || []).some(u => u.messageId === secret.messageId), '團隊狀態不列 B 的訊息');
  assert.ok((await call(bob.token, '/api/team-status')).body.unanswered.some(u => u.messageId === secret.messageId), 'B 的成員照樣看得到尚未回應');
  assert.ok((ts.body.unanswered || []).every(u => !('_project' in u) && !('_at' in u)), '內部欄位不外流');

  // 2. 回覆看不到的訊息＝不存在，話發不進 B
  const reply = await call(eve.token, '/api/messages', 'POST', { requestId: rid(), text: '偷偷發進 B', replyToMessageId: secret.messageId });
  assert.equal(reply.status, 404, '回覆看不到的訊息回 404：' + JSON.stringify(reply.body));
  const inB = (await call(bob.token, `/api/messages?project=${encodeURIComponent(pB)}&limit=50`)).body.items.map(m => m.text);
  assert.ok(!inB.includes('偷偷發進 B'), 'B 裡沒有新來的發的話');
  assert.equal((await call(bob.token, '/api/messages', 'POST', { requestId: rid(), text: '回覆自己專案', replyToMessageId: secret.messageId })).body.project, pB, '自己專案照樣繼承');

  // 5. 工作記憶游標：裡面夾帶文字就擋；正常游標照收
  const aiTok = (await testToken(db, ai.participantId));
  const evil = 'cur_' + Buffer.from(JSON.stringify({ s: '<svg onload=alert(1)>' })).toString('base64url');
  assert.ok(/^cur_[A-Za-z0-9_-]{1,64}$/.test(evil), '這個游標以前會通過格式檢查');
  assert.equal((await call(aiTok, '/api/me/state', 'PUT', { messagesCursor: evil })).status, 400, '夾帶文字的游標被擋');
  const good = (await call(aiTok, '/api/messages?limit=1')).body.nextCursor;
  assert.equal((await call(aiTok, '/api/me/state', 'PUT', { messagesCursor: good })).status, 200, '正常游標照收');

  // 4、5 網頁：視窗標題跳脫、權限確認清單跳脫、游標只顯示整數
  const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(appJs.includes('<h2 id="modal-title">${esc(title)}</h2>'), '視窗標題一律跳脫');
  assert.ok(!/title: `[^`]*\$\{esc\(/.test(appJs), '標題不再自己跳脫（避免兩次）');
  for (const k of ['dry.crossChanges || []).map(c => `${esc(c.name)}', 'dry.roleChanges || []).map(c => `${esc(c.name)}', 'dry.impact.map(x => `${esc(x.name)}']) assert.ok(appJs.includes(k), '權限確認清單跳脫：' + k);
  const curSrc = /const curSeq = (c => \{[^\n]*\});/.exec(appJs)[1];
  const curSeq = new Function('atob', `return ${curSrc}`)(s => Buffer.from(s, 'base64').toString('binary'));
  assert.equal(curSeq(evil), null, '游標不是整數就不顯示');
  assert.equal(curSeq(good), JSON.parse(Buffer.from(good.slice(4), 'base64url').toString()).s, '正常游標照顯示');
  // modalFrame 實際跑一次：名字含 HTML 的標題變成純文字
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const mfSrc = /function modalFrame\(\{[\s\S]*?\n  \}/.exec(appJs)[0];
  const modalFrame = new Function('esc', `${mfSrc}; return modalFrame;`)(esc);
  const html = modalFrame({ title: '把 <img/src=x/onerror=alert(1)> 設成唯讀？', body: '' });
  assert.ok(!html.includes('<img') && html.includes('&lt;img'), '標題裡的 HTML 變成文字');
  console.log('security-isolation-test：全部通過');
} catch (e) {
  console.error('security-isolation-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
