// 卡片的決定、暫緩、退回、交接也能附截圖（先用 POST /api/files?post=false 上傳，再帶 fileIds；最多 4 個）
// 1. 退回帶 fileIds：代發的 [退回] 原因在前、[文件] 在後，檔案掛在那則；檔案不合格（別人的）→ 404，卡片不動
// 2. 退回舊用法（multipart 單檔）：原因照樣在 [文件] 前面（之前內文沒有「[文件] 」，畫面看不到原因）；過期的檔、超過 4 個擋；file 跟 fileIds 擇一
// 3. 決定帶 fileIds：通知那則掛檔；已掛在別則的檔 → 409，卡片沒被決定
// 4. 自己提、自己決定（沒人可通知）但有附檔 → 照樣發一則（只留紀錄），檔案才看得到；沒附檔照舊不發
// 5. 暫緩帶 fileIds
// 6. 交接帶 fileIds：[交接] 那則掛 2 個檔；人類紀錄卡交接帶 fileIds → 400，卡片不動
// 本機暫存資料庫（設 AIGILE_TEST_PG_URL 時是本機 Postgres），不連任何站。用法：node scripts/paste-attach-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb, TEST_PG_URL } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const PJ = '預設專案';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pasteatt-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const req = async (token, p, method = 'GET', body, raw = false) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined }), 'http://localhost');
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json().catch(() => null) : null };
};
const png = n => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);
let seq = 0;
const up = async (token, name = `截圖-${++seq}.png`) => {
  const r = await req(token, `/api/files?${new URLSearchParams({ name, declared: 'true', project: PJ, post: 'false' })}`, 'POST', png(++seq % 250), true);
  assert.equal(r.status, 201, '上傳：' + JSON.stringify(r.body));
  return r.body.file.fileId;
};
const msg = async (token, id) => (await req(token, `/api/messages/${id}`)).body;
const list = async token => (await req(token, `/api/messages?project=${encodeURIComponent(PJ)}&limit=100`)).body.items;
const lastMsg = async (token, re) => (await list(token)).filter(m => re.test(m.text)).at(-1);

try {
  const lin = (await req(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const LIN = lin.participant.participantId;
  const chen = (await req(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const CHEN = chen.participant.participantId;
  assert.equal((await req(lin.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [PJ] })).status, 200, '陳大文加進預設專案');
  const ai = (await req(lin.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '程式開發助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const AI = ai.participantId;
  const aiToken = await testToken(db, AI);
  const card = async (token, body) => { const r = await req(token, '/api/cards', 'POST', { requestId: 'pa_' + ++seq, project: PJ, ...body }); assert.equal(r.status, 201, '建卡：' + JSON.stringify(r.body)); return r.body; };
  const toVerify = async title => { // AI 做完交給人類驗收 → 待確認
    const c = await card(aiToken, { title, ownerId: AI, status: '進行中' });
    const h = await req(aiToken, `/api/cards/${c.cardId}/handover`, 'POST', { toId: LIN, progress: '做好了', nextStep: '請驗收' });
    assert.equal(h.status, 200, JSON.stringify(h.body));
    return h.body;
  };

  // ---------- 1 退回帶 fileIds ----------
  const c1 = await toVerify('搜尋框打中文會被吃字');
  const chenFile = await up(chen.token);
  let r = await req(lin.token, `/api/cards/${c1.cardId}/reject`, 'POST', { reason: '還是會吃字', version: c1.version, fileIds: [chenFile] });
  assert.equal(r.status, 404, '1 別人的檔不能掛：' + JSON.stringify(r.body));
  assert.equal((await req(lin.token, `/api/cards/${c1.cardId}`)).body.status, '待確認', '1 檔案不合格，卡片不動');
  const f1 = [await up(lin.token, '1-搜尋結果.png'), await up(lin.token, '2-搜尋框.png')];
  r = await req(lin.token, `/api/cards/${c1.cardId}/reject`, 'POST', { reason: '搜尋框打「台北」還是會吃字，見截圖 1～2。', version: c1.version, fileIds: f1 });
  assert.equal(r.status, 200, '1 退回：' + JSON.stringify(r.body));
  assert.equal(r.body.status, '進行中', '1 卡片回進行中');
  let m = await msg(lin.token, r.body.rejectMessageId);
  assert.match(m.text, /^\[退回\] .*：搜尋框打「台北」還是會吃字，見截圖 1～2。\n\[文件\] 2 個檔案/, '1 原因在前、[文件] 在後：' + m.text);
  assert.deepEqual(m.files.map(x => x.fileId), f1, '1 兩個檔都掛在 [退回] 那則');
  assert.ok((await req(aiToken, '/api/notifications?status=pending&limit=50')).body.items.some(n => n.messageId === m.messageId), '1 交過來的 AI 收到通知');
  assert.equal((await req(aiToken, `/api/files/${f1[1]}`)).status, 200, '1 AI 下載得到第 2 張');

  // ---------- 2 退回舊用法：multipart 單檔 ----------
  const c2 = await toVerify('退回附單檔');
  const form = new FormData();
  form.set('reason', '看附件第 3 行'); form.set('version', String(c2.version)); form.set('declared', 'true');
  form.set('file', new File([png(9)], '錯誤訊息.png', { type: 'image/png' }));
  r = await req(lin.token, `/api/cards/${c2.cardId}/reject`, 'POST', form, true);
  assert.equal(r.status, 200, '2 multipart 退回：' + JSON.stringify(r.body));
  m = await msg(lin.token, r.body.rejectMessageId);
  assert.match(m.text, /：看附件第 3 行\n\[文件\] 1 個檔案/, '2 單檔也是原因在前、[文件] 在後：' + m.text);
  assert.equal(m.file?.name, '錯誤訊息.png', '2 檔案掛在 [退回] 那則');
  assert.ok(!m.files, '2 單檔不帶 files');
  const c2b = await toVerify('過期的檔與太多檔');
  const expired = await up(lin.token);
  await db.run('UPDATE files SET expires_at = ? WHERE id = ?', Date.now() - 1000, expired);
  r = await req(lin.token, `/api/cards/${c2b.cardId}/reject`, 'POST', { reason: 'x', fileIds: [expired] });
  assert.equal(r.status, 404, '2 過期的檔不能掛');
  r = await req(lin.token, `/api/cards/${c2b.cardId}/reject`, 'POST', { reason: 'x', fileIds: Array.from({ length: 5 }, (_, i) => 'f' + i) });
  assert.equal(r.body?.error?.code, 'TOO_MANY_FILES', '2 超過 4 個擋');
  r = await req(lin.token, `/api/cards/${c2b.cardId}/reject`, 'POST', { reason: 'x', fileIds: [] });
  assert.equal(r.status, 400, '2 空陣列擋');
  assert.equal((await req(lin.token, `/api/cards/${c2b.cardId}`)).body.status, '待確認', '2 都擋下，卡片不動');

  // ---------- 3 決定帶 fileIds ----------
  const d1 = await card(aiToken, { type: '決策', title: '截圖放哪裡', question: '要放卡片欄位嗎？', options: ['放', '不放'], deciderId: LIN });
  r = await req(lin.token, `/api/cards/${d1.cardId}/decide`, 'POST', { result: '放', note: '見圖', fileIds: [f1[0]] });
  assert.equal(r.status, 409, '3 已掛在別則的檔 → 409：' + JSON.stringify(r.body));
  assert.equal((await req(lin.token, `/api/cards/${d1.cardId}`)).body.status, '待確認', '3 檔案不合格，卡片沒被決定');
  const f3 = await up(lin.token, '決定.png');
  r = await req(lin.token, `/api/cards/${d1.cardId}/decide`, 'POST', { result: '放', note: '照這張圖', fileIds: [f3] });
  assert.equal(r.status, 200, '3 決定：' + JSON.stringify(r.body));
  m = await lastMsg(lin.token, new RegExp(`^\\[通知\\] .*${d1.cardId}.*決定「放」`));
  assert.ok(m, '3 有 [通知] 那則');
  assert.equal(m.file?.fileId, f3, '3 通知那則掛檔');
  assert.match(m.text, /決定「放」：照這張圖\n\[文件\] 1 個檔案/, '3 內文：' + m.text);
  assert.ok((await req(aiToken, '/api/notifications?status=pending&limit=50')).body.items.some(n => n.messageId === m.messageId), '3 提案的 AI 收到通知');

  // ---------- 4 自己提、自己決定：沒人可通知，但有附檔照樣發 ----------
  const d2 = await card(lin.token, { type: '決策', title: '自己決定', question: '？', options: ['好'], deciderId: LIN });
  const n0 = (await list(lin.token)).length;
  const f4 = await up(lin.token, '自己.png');
  r = await req(lin.token, `/api/cards/${d2.cardId}/decide`, 'POST', { result: '好', fileIds: [f4] });
  assert.equal(r.status, 200, '4 決定：' + JSON.stringify(r.body));
  m = await lastMsg(lin.token, new RegExp(`^\\[通知\\] .*${d2.cardId}`));
  assert.equal(m?.file?.fileId, f4, '4 沒人可通知也發一則掛檔');
  assert.equal((await list(lin.token)).length, n0 + 1, '4 只多一則');
  const d3 = await card(lin.token, { type: '決策', title: '自己決定、沒附檔', question: '？', options: ['好'], deciderId: LIN });
  await req(lin.token, `/api/cards/${d3.cardId}/decide`, 'POST', { result: '好' });
  assert.equal((await list(lin.token)).length, n0 + 1, '4 沒附檔照舊不發');

  // ---------- 5 暫緩帶 fileIds ----------
  const d4 = await card(aiToken, { type: '決策', title: '先擱著', question: '？', options: ['A', 'B'], deciderId: LIN });
  const f5 = [await up(lin.token), await up(lin.token)];
  r = await req(lin.token, `/api/cards/${d4.cardId}/defer`, 'POST', { reason: '等廠商回覆，見圖', fileIds: f5 });
  assert.equal(r.status, 200, '5 暫緩：' + JSON.stringify(r.body));
  m = await lastMsg(lin.token, new RegExp(`^\\[通知\\] .*${d4.cardId}.*暫緩`));
  assert.deepEqual(m?.files?.map(x => x.fileId), f5, '5 暫緩通知掛 2 個檔');

  // ---------- 6 交接帶 fileIds ----------
  const k1 = await card(lin.token, { title: '交接附圖', ownerId: LIN, status: '進行中' });
  const f6 = [await up(lin.token, '畫面1.png'), await up(lin.token, '畫面2.png')];
  r = await req(lin.token, `/api/cards/${k1.cardId}/handover`, 'POST', { toId: CHEN, note: '做到一半，看圖', fileIds: f6 });
  assert.equal(r.status, 200, '6 交接：' + JSON.stringify(r.body));
  m = await msg(lin.token, r.body.handoverMessageId);
  assert.match(m.text, /^\[交接\] .*→ @陳大文：做到一半，看圖（.*）\n\[文件\] 2 個檔案/, '6 內文：' + m.text);
  assert.deepEqual(m.files.map(x => x.fileId), f6, '6 [交接] 那則掛 2 個檔');
  assert.equal((await req(chen.token, `/api/files/${f6[0]}`)).status, 200, '6 接手的人下載得到');
  const note = await card(lin.token, { type: '人類紀錄', title: '人類紀錄', ownerId: LIN });
  const f7 = await up(lin.token);
  r = await req(lin.token, `/api/cards/${note.cardId}/handover`, 'POST', { toId: CHEN, note: 'x', fileIds: [f7] });
  assert.equal(r.status, 400, '6 人類紀錄交接不發訊息，不能附檔：' + JSON.stringify(r.body));
  assert.equal((await req(lin.token, `/api/cards/${note.cardId}`)).body.owner?.participantId, LIN, '6 卡片不動');

  console.log(`paste-attach-test：全部通過（${TEST_PG_URL ? 'Postgres' : 'SQLite'}）`);
} catch (e) {
  console.error('paste-attach-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { await db.close?.(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
