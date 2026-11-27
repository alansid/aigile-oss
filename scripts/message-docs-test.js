// 發文引用專案文件區的檔（docIds，最多 4 個），訊息直接顯示縮圖
// 1. POST /api/messages 帶 docIds → 讀訊息有 docs（docId、name、ext、size、available、downloadUrl）；沒帶就沒有 docs
// 2. 不另存檔：文件區還是同一份；文件刪掉後訊息的 docs 變 available=false
// 3. 擋：超過 4 個、重複、格式錯、別專案的文件、已刪除、卡片「只給人看」的附件、project=all、不在那個專案的人
// 4. 冪等：同一 requestId、同內容回同一則；換 docIds 回 409
// 5. MCP：aigile_post 帶 docIds；aigile_read 精簡格式列出 docs；工具說明有寫 docIds
// 本機暫存資料庫（設 AIGILE_TEST_PG_URL 時是 Postgres），不連任何站。用法：node scripts/message-docs-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { testToken } from './test-token.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';
import { slimMessage } from '../src/mcp.js';

const PJ = '預設專案';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-msgdocs-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docStorage: memStorage(), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const req = async (token, p, method = 'GET', body, raw = false) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined }), 'http://localhost');
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json().catch(() => null) : null };
};
const png = n => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);
const upDoc = async (token, pj, name, bytes) => {
  const r = await req(token, `/api/projects/${encodeURIComponent(pj)}/docs?${new URLSearchParams({ name, declared: 'true' })}`, 'POST', bytes, true);
  assert.equal(r.status, 201, `上傳 ${name}：` + JSON.stringify(r.body));
  return r.body.doc.docId;
};
let rid = 0;
const tool = async (token, name, args) => {
  const r = await req(token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.status, 200, `${name} HTTP ${r.status}`);
  const c = r.body.result.content[0].text;
  try { return JSON.parse(c); } catch { return { error: c, isError: r.body.result.isError }; }
};

try {
  const liu = (await req(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const other = (await req(liu.token, '/api/projects', 'POST', { name: '其他專案', code: 'OTH' })).body.id;
  const chen = (await req(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const CHEN = chen.participant.participantId;
  await req(liu.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [other] });
  const ai = (await req(liu.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'UX', role: 'UX', name: '林志明的設計助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiToken = await testToken(db, ai.participantId);

  const d1 = await upDoc(aiToken, PJ, 'search-1280.png', png(1));
  const d2 = await upDoc(aiToken, PJ, 'search-375.png', png(2));
  const d3 = await upDoc(aiToken, PJ, '驗收清單.md', new TextEncoder().encode('# 驗收\n- 縮圖'));
  const bank = await upDoc(liu.token, other, '別專案.png', png(3));
  const docsBefore = (await db.get('SELECT COUNT(*) AS n FROM docs')).n;
  const filesBefore = (await db.get('SELECT COUNT(*) AS n FROM files')).n;

  // ---------- 1 帶 docIds 發文 ----------
  const post = (token, body) => req(token, '/api/messages', 'POST', { project: PJ, requestId: 'p481_' + ++rid, ...body });
  const r1 = await post(aiToken, { requestId: 'p481_shots', text: '[通知] 截圖附上，1280 和 375 各一張，另附驗收清單。', recipientIds: [], replyFrom: [], docIds: [d1, d2, d3] });
  assert.equal(r1.status, 201, '1 帶 docIds 發文：' + JSON.stringify(r1.body));
  const m1 = r1.body.message || r1.body;
  assert.deepEqual(m1.docs.map(d => d.docId), [d1, d2, d3], '1 docs 照帶的順序');
  assert.deepEqual(m1.docs[0], { docId: d1, name: 'search-1280.png', ext: 'png', size: 12, available: true, downloadUrl: `/api/projects/${encodeURIComponent(PJ)}/docs/${d1}` }, '1 docs 欄位');
  assert.equal(m1.docs[2].ext, 'md', '1 非圖片也列出');
  assert.equal(m1.file, null, '1 沒有群組附檔');
  assert.equal(m1.text, '[通知] 截圖附上，1280 和 375 各一張，另附驗收清單。', '1 內文不改');
  const got = (await req(liu.token, `/api/messages/${m1.messageId}`)).body;
  assert.deepEqual(got.docs.map(d => d.available), [true, true, true], '1 別人讀也看得到');
  const listed = (await req(liu.token, `/api/messages?project=${encodeURIComponent(PJ)}`)).body.items.find(x => x.messageId === m1.messageId);
  assert.equal(listed.docs.length, 3, '1 列表也帶 docs');
  const plain = (await post(aiToken, { text: '[通知] 沒有附圖', recipientIds: [], replyFrom: [] })).body;
  assert.ok(!('docs' in (plain.message || plain)), '1 沒帶 docIds 就沒有 docs 欄位');
  assert.equal((await req(liu.token, `/api/projects/${encodeURIComponent(PJ)}/docs/${d1}`)).status, 200, '1 縮圖從文件區下載得到');

  // ---------- 2 不另存檔；刪掉後顯示已刪除 ----------
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM docs')).n, docsBefore, '2 文件區沒有多一份');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM files')).n, filesBefore, '2 沒有另存成群組附檔');
  assert.equal((await req(aiToken, `/api/projects/${encodeURIComponent(PJ)}/docs/${d2}`, 'DELETE')).status, 200, '2 刪除文件');
  const after = (await req(liu.token, `/api/messages/${m1.messageId}`)).body;
  assert.deepEqual(after.docs[1], { docId: d2, available: false }, '2 刪掉的文件 available=false');
  assert.equal(after.docs[0].available, true, '2 其他張照常');

  // ---------- 3 擋 ----------
  const bad = async (token, body, status, code, what) => {
    const r = await post(token, { text: '[通知] 附圖', recipientIds: [], replyFrom: [], ...body });
    assert.equal(r.status, status, `3 ${what}：` + JSON.stringify(r.body));
    if (code) assert.equal(r.body.error.code, code, `3 ${what} 錯誤碼`);
    return r;
  };
  const d4 = await upDoc(aiToken, PJ, '4.png', png(4)), d5 = await upDoc(aiToken, PJ, '5.png', png(5));
  await bad(aiToken, { docIds: [d1, d3, d4, d5, 'doc_x'] }, 400, 'TOO_MANY_DOCS', '超過 4 個');
  await bad(aiToken, { docIds: [d1, d1] }, 400, 'INVALID_REQUEST', '重複');
  await bad(aiToken, { docIds: [] }, 400, 'INVALID_REQUEST', '空陣列');
  await bad(aiToken, { docIds: d1 }, 400, 'INVALID_REQUEST', '不是陣列');
  await bad(aiToken, { docIds: [123] }, 400, 'INVALID_REQUEST', '不是字串');
  const cross = await bad(liu.token, { docIds: [bank] }, 404, 'DOC_NOT_FOUND', '別專案的文件');
  assert.match(cross.body.error.message, /預設專案/, '3 錯誤訊息講是哪個專案');
  await bad(aiToken, { docIds: [d2] }, 404, 'DOC_NOT_FOUND', '已刪除的文件');
  await bad(aiToken, { docIds: [d1], project: 'all' }, 400, 'INVALID_REQUEST', 'project=all');
  await bad(chen.token, { project: other, docIds: [d1] }, 404, 'DOC_NOT_FOUND', '別專案的人引用預設專案的文件');
  // 卡片「只給人看」的附件：AI 也會看到群組訊息，所以不能貼
  const card = (await req(liu.token, '/api/cards', 'POST', { project: PJ, type: '工作', title: '附件', requestId: 'p481_card' })).body;
  const hid = await upDoc(liu.token, PJ, '只給人看.png', png(6));
  const seq = (await db.get('SELECT seq FROM cards ORDER BY seq DESC LIMIT 1')).seq;
  await db.run('INSERT INTO card_attachments (doc_id, card_seq, human_only) VALUES (?,?,1)', hid, seq);
  assert.ok(card, '3 建卡');
  await bad(liu.token, { docIds: [hid] }, 404, 'DOC_NOT_FOUND', '只給人看的卡片附件');
  await db.run('UPDATE card_attachments SET human_only = 0 WHERE doc_id = ?', hid);
  const okHid = await post(liu.token, { text: '[通知] 一般卡片附件可以貼', recipientIds: [], replyFrom: [], docIds: [hid] });
  assert.equal(okHid.status, 201, '3 一般卡片附件可以引用');
  // 發文後才改成只給人看／人類紀錄卡：舊訊息不再露出檔名（人、AI 讀都一樣）
  const hidMsg = (okHid.body.message || okHid.body).messageId;
  assert.equal((await req(aiToken, `/api/messages/${hidMsg}`)).body.docs[0].name, '只給人看.png', '3 改之前看得到');
  await db.run('UPDATE card_attachments SET human_only = 1 WHERE doc_id = ?', hid);
  for (const t of [liu.token, aiToken]) assert.deepEqual((await req(t, `/api/messages/${hidMsg}`)).body.docs, [{ docId: hid, available: false }], '3 後來改成只給人看：舊訊息不露檔名');
  await db.run('UPDATE card_attachments SET human_only = 0 WHERE doc_id = ?', hid);
  await db.run("UPDATE cards SET type = '人類紀錄' WHERE seq = ?", seq);
  assert.deepEqual((await req(aiToken, `/api/messages/${hidMsg}`)).body.docs, [{ docId: hid, available: false }], '3 卡片後來改成人類紀錄：舊訊息不露檔名');
  const listedHid = (await req(aiToken, `/api/messages?project=${encodeURIComponent(PJ)}`)).body.items.find(x => x.messageId === hidMsg);
  assert.deepEqual(listedHid.docs, [{ docId: hid, available: false }], '3 列表批次讀取也一樣');
  await db.run("UPDATE cards SET type = '工作' WHERE seq = ?", seq);

  // ---------- 4 冪等 ----------
  const again = await post(aiToken, { requestId: 'p481_shots', text: '[通知] 截圖附上，1280 和 375 各一張，另附驗收清單。', recipientIds: [], replyFrom: [], docIds: [d1, d2, d3] });
  assert.equal((again.body.message || again.body).messageId, m1.messageId, '4 同 requestId 同內容回同一則');
  assert.equal((await post(aiToken, { requestId: 'p481_shots', text: '[通知] 截圖附上，1280 和 375 各一張，另附驗收清單。', recipientIds: [], replyFrom: [], docIds: [d1] })).status, 409, '4 換 docIds 回 409');

  // ---------- 5 MCP ----------
  const list = await req(aiToken, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rid, method: 'tools/list' });
  const postTool = list.body.result.tools.find(t => t.name === 'aigile_post');
  assert.equal(postTool.inputSchema.properties.docIds.maxItems, 4, '5 aigile_post 有 docIds、最多 4 個');
  assert.match(postTool.description, /docIds/, '5 工具說明寫怎麼附截圖');
  assert.match(list.body.result.tools.find(t => t.name === 'aigile_doc_upload').description, /docIds/, '5 上傳工具說明提到 docIds');
  const p = await tool(aiToken, 'aigile_post', { project: PJ, text: '[通知] MCP 附圖', replyFrom: [], docIds: [d1, d4] });
  assert.ok(p.messageId, '5 aigile_post 帶 docIds 發得出去：' + JSON.stringify(p));
  const rd = await tool(aiToken, 'aigile_read', { messageId: p.messageId });
  assert.deepEqual(rd.docs.map(d => d.docId), [d1, d4], '5 aigile_read 帶 docs');
  // 收件匣精簡格式（slimMessage）：給 AI 的訊息只列 docId、name、available
  const toAi = await post(liu.token, { text: '@林志明的設計助手 這兩張看一下', recipientIds: [ai.participantId], docIds: [d1, d4] });
  assert.equal(toAi.status, 201, '5 人類發給 AI 帶 docIds');
  const slim = slimMessage((await req(aiToken, `/api/messages/${(toAi.body.message || toAi.body).messageId}`)).body);
  assert.deepEqual(slim.docs, [{ docId: d1, name: 'search-1280.png', available: true }, { docId: d4, name: '4.png', available: true }], '5 收件匣精簡列出 docs');

  console.log('message-docs-test：全部通過');
} finally {
  await db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
