// 驗收測試：MCP 補齊建卡、上傳專案文件、讀歷史訊息、批次送出；重接設定寫明一次載入全部工具
// 修正前：MCP 沒有建卡、上傳文件、讀歷史，AI 只好寫 node／curl 腳本打 API（第 3 次 PO 寫了 12 支 taskNN.mjs）；
//         每要一個新工具就多一次 ToolSearch
// 修正後：
//   A aigile_card_create（requestId 不帶自動產生，重送回原卡）、aigile_doc_upload（本機 path 由轉接腳本讀檔上傳；短文字給 content）、
//     aigile_history（依卡或最近幾小時，精簡格式）
//   B aigile_batch：依序執行多個動作，遇錯就停、後面不做
//   C 重接設定（Claude Code）第一步：一次 ToolSearch 載入全部 aigile 工具
//   D 測試；工具說明繁中
// 用法：node scripts/mcp-write-tools-test.js
import { stopChild, stopServer } from './test-process.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';
import { MCP_TOOLS, HIST_CHARS } from '../src/mcp.js';
import { testToken } from './test-token.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p333-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docStorage: memStorage(), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  const t = await r.text(); let b; try { b = JSON.parse(t); } catch { b = t; }
  return { status: r.status, body: b };
};
let rid = 0;
const tool = async (token, name, args) => {
  const r = await call(token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } });
  const text = r.body.result.content[0].text;
  return r.body.result.isError ? { isError: true, text } : JSON.parse(text);
};
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
let bridge;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const mk = async (name, roleKey = 'PO') => { const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, tok: await testToken(db, a.participantId) }; };
  const po = await mk('產品助手'), pg = await mk('開發助手', 'PG');

  // D：工具說明繁中、16 個
  const names = MCP_TOOLS.map(t => t.name);
  for (const n of ['aigile_card_create', 'aigile_doc_upload', 'aigile_history', 'aigile_batch']) {
    const t = MCP_TOOLS.find(x => x.name === n);
    assert.ok(t && /[一-鿿]/.test(t.description), `${n} 有繁中說明`);
  }
  assert.equal(names.length, 23); // 16 個＋知識庫 4 個＋審查 3 個

  // A 建卡：requestId 不帶自動產生；重送同內容回原卡；負責人 me
  let r = await tool(po.tok, 'aigile_card_create', { project: '預設專案', title: 'PLAT 測試建卡', ownerId: 'me', status: '待處理', criteria: 'A. 做完' });
  assert.ok(/^[A-Z]+-\d+$/.test(r.cardId) && r.status === '待處理' && r.owner === '產品助手', '建卡回卡號、狀態、負責人：' + JSON.stringify(r));
  const again = await tool(po.tok, 'aigile_card_create', { project: '預設專案', title: 'PLAT 測試建卡', ownerId: 'me', status: '待處理', criteria: 'A. 做完' });
  assert.ok(again.duplicate && again.cardId === r.cardId, '重送回原卡');
  const card = r.cardId;
  r = await tool(po.tok, 'aigile_card_create', { project: '預設專案', title: '指派別人', ownerId: pg.id });
  assert.ok(r.isError && /AI 不能直接把卡片指派給別人/.test(r.text), 'AI 照舊不能指派別人');
  r = await tool(po.tok, 'aigile_card_create', { project: '預設專案', title: '要不要改', type: '決策', question: '要不要改登入頁？', options: ['要', '不要'] });
  assert.ok(r.cardId && r.status === '待確認', '決策卡');

  // A 歷史：依卡、最近幾小時
  for (let i = 0; i < 3; i++) await call(po.tok, '/api/messages', 'POST', { project: '預設專案', requestId: `h${i}`, cardId: card, recipientIds: [], text: `[進度] 第 ${i} 步 ${'很長'.repeat(200)}` });
  await call(po.tok, '/api/messages', 'POST', { project: '預設專案', requestId: 'other', recipientIds: [], text: '[通知] 沒掛卡的' });
  r = await tool(po.tok, 'aigile_history', { cardId: card });
  assert.equal(r.messages.length, 3, '只回掛在卡上的');
  assert.ok(r.messages.every(m => m.text.length <= HIST_CHARS + 1 && m.textLength > HIST_CHARS && m.from.startsWith('產品助手')), '精簡格式');
  assert.ok(r.messages[0].seq < r.messages[2].seq, '由舊到新');
  r = await tool(po.tok, 'aigile_history', { hours: 1, limit: 2 });
  assert.equal(r.messages.length, 2); assert.ok(r.hasMore && r.olderCursor, '可以往前翻');
  const older = await tool(po.tok, 'aigile_history', { hours: 1, limit: 2, before: r.olderCursor });
  assert.ok(older.messages.length >= 1 && older.messages.at(-1).seq < r.messages[0].seq, '往前翻接得上');

  // A 上傳文件：content（文字）
  r = await tool(po.tok, 'aigile_doc_upload', { project: '預設專案', name: '需求.md', content: '# 需求\n- 一\n', declared: true });
  assert.ok(r.docId && r.name === '需求.md', '文字直接上傳：' + JSON.stringify(r));
  const docs = (await call(po.tok, '/api/projects/預設專案/docs')).body;
  assert.ok(JSON.stringify(docs).includes('需求.md'), '文件區看得到');
  r = await tool(po.tok, 'aigile_doc_upload', { project: '預設專案', name: 'a.md', content: 'x', declared: false });
  assert.ok(r.isError && /declared/.test(r.text), 'declared 一定要 true');
  r = await tool(po.tok, 'aigile_doc_upload', { project: '預設專案', name: 'a.md', path: 'x.md', declared: true });
  assert.ok(r.isError && /本機轉接腳本/.test(r.text), '平台讀不到本機 path，說清楚');
  r = await tool(po.tok, 'aigile_doc_upload', { project: '預設專案', name: 'a.js', content: 'x', declared: true });
  assert.ok(r.isError, '程式碼副檔名照舊被擋');

  // B 批次：依序做、遇錯就停
  const pending = (await call(po.tok, '/api/notifications?status=pending')).body.items;
  await call(liu.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'askpo', recipientIds: [po.id], text: '[通知] PO 看一下' });
  const nid = (await call(po.tok, '/api/notifications?status=pending')).body.items.map(n => n.notificationId);
  assert.ok(nid.length > pending.length);
  r = await tool(po.tok, 'aigile_batch', { ops: [
    { tool: 'aigile_post', args: { project: '預設專案', text: '[進度] 批次第一步', cardId: card, replyFrom: [] } },
    { tool: 'aigile_card_update', args: { cardId: card, next: '批次改的下一步' } },
    { tool: 'aigile_ack', args: { notificationIds: nid } },
  ] });
  assert.equal(r.done, 3, '三步都做：' + JSON.stringify(r).slice(0, 300)); assert.ok(r.results.every(x => x.ok));
  assert.equal((await call(po.tok, `/api/cards/${card}`)).body.next, '批次改的下一步');
  assert.equal((await call(po.tok, '/api/notifications?status=pending')).body.items.length, 0, 'ACK 了');
  await call(liu.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'askpo2', recipientIds: [po.id], text: '[通知] PO 再看一下' });
  const nid2 = (await call(po.tok, '/api/notifications?status=pending')).body.items.map(n => n.notificationId);
  r = await tool(po.tok, 'aigile_batch', { ops: [
    { tool: 'aigile_card_update', args: { cardId: 'MAIN-99999', next: 'x' } },
    { tool: 'aigile_ack', args: { notificationIds: nid2 } },
  ] });
  assert.ok(r.done === 0 && /第 1 步失敗，後面 1 步沒做/.test(r.stopped) && r.results.length === 1, '第一步錯就停');
  assert.equal((await call(po.tok, '/api/notifications?status=pending')).body.items.length, 1, '前面失敗就不 ACK');
  r = await tool(po.tok, 'aigile_batch', { ops: [{ tool: 'aigile_ack', args: { notificationIds: ['msg_x'] } }] });
  assert.ok(r.done === 0 && /參數錯誤/.test(r.results[0].error), '每步參數照樣檢查');
  r = await tool(po.tok, 'aigile_batch', { ops: [{ tool: 'aigile_dm', args: { action: 'read' } }] });
  assert.ok(r.isError, '清單外的工具不能放進批次');

  // 試用者沒有新的寫入工具
  const tr = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'TRY', role: '試用', name: '試用助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  if (tr.participantId) {
    const ttok = await testToken(db, tr.participantId);
    const tl = (await call(ttok, '/api/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body.result.tools.map(t => t.name);
    if (!tl.includes('aigile_card_update')) for (const n of ['aigile_card_create', 'aigile_doc_upload', 'aigile_batch']) assert.ok(!tl.includes(n), `試用者沒有 ${n}`);
  }

  // A 上傳文件：本機 path 由轉接腳本讀檔直接上傳
  const work = fs.mkdtempSync(path.join(dataDir, 'w-')), dir = path.join(work, '.aigile', 'PO_X');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, '.token'), po.tok); fs.writeFileSync(path.join(dir, 'watcher.env'), `AIGILE_BASE=${BASE}\n`);
  fs.writeFileSync(path.join(work, '會議紀錄.md'), '# 會議\n' + '內容'.repeat(60000)); // 約 240 KB，超過 MCP 請求上限也能傳
  bridge = spawn(process.execPath, [path.join(ROOT, 'public', 'aigile-mcp.mjs')], { cwd: work, env: { ...process.env, AIGILE_DIR: work, AIGILE_AGENT: '', USERPROFILE: dataDir, HOME: dataDir }, stdio: 'pipe' });
  let out = ''; bridge.stdout.on('data', d => { out += d; });
  bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'aigile_doc_upload', arguments: { project: '預設專案', name: '會議紀錄.md', path: '會議紀錄.md', declared: true } } }) + '\n');
  const end = Date.now() + 15000; let line;
  while (Date.now() < end && !(line = out.split('\n').find(l => l.includes('"id":7')))) await new Promise(r => setTimeout(r, 50));
  assert.ok(line, '轉接腳本有回應');
  const res = JSON.parse(line).result;
  assert.ok(!res.isError, '上傳成功：' + res.content[0].text);
  const up = JSON.parse(res.content[0].text);
  assert.ok(up.docId && up.size > 200_000, '大檔直接上傳：' + JSON.stringify(up));

  // C：重接設定第一步（Claude Code）
  const rc = await (await app(new Request('http://localhost/api/me/reconnect?tool=claude', { headers: { Authorization: `Bearer ${po.tok}` } }), 'http://localhost')).text();
  assert.match(rc, /1\. 不要重新簽到。有 aigile MCP 工具就先用一次 ToolSearch 載入全部 aigile 工具/);
  const rcx = await (await app(new Request('http://localhost/api/me/reconnect?tool=codex', { headers: { Authorization: `Bearer ${po.tok}` } }), 'http://localhost')).text();
  assert.ok(!/ToolSearch/.test(rcx), 'Codex 沒有 ToolSearch，不寫');
  console.log('mcp-write-tools-test：全部通過');
} catch (e) {
  console.error('mcp-write-tools-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { await stopChild(bridge); } catch {}
  await stopServer(server);
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
