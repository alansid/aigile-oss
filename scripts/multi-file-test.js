// 一則訊息掛多個檔（群組發文一次帶多張截圖，最多 4 個）
// 1. POST /api/files?post=false 只存檔不發文；還沒掛上訊息前誰都下載不到
// 2. POST /api/messages 帶 fileIds（1～4）→ 一則訊息、通知只發一次；內文由平台產生，每個檔都有下載連結（只讀 text 的 AI 也拿得到）
// 3. 讀訊息：file＝第一個（舊版照讀）、files＝全部、照上傳順序；單檔不帶 files（跟 file 一樣）
// 4. 擋：超過 4 個、重複、空陣列、別人的檔、已掛在別則的檔、過期／刪除的檔；同一 requestId 重送回同一則
// 5. MCP aigile_read 回傳全部檔案；AI 自己也能一次發多張
// 6. 資料庫升級 003_files_message.sql：舊站重開會補套、有索引 idx_files_message（SQLite；設 AIGILE_TEST_PG_URL 時是 Postgres）
// 本機暫存資料庫，不連任何站。用法：node scripts/multi-file-test.js
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-multifile-'));
const dbFile = path.join(dataDir, 'switch.db');
let db = await openTestDb(dbFile);
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const req = async (token, p, method = 'GET', body, raw = false) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined }), 'http://localhost');
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.includes('json') ? await r.json().catch(() => null) : null };
};
const png = n => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);
const up = (token, name, n, extra = {}) => req(token, `/api/files?${new URLSearchParams({ name, declared: 'true', project: PJ, post: 'false', ...extra })}`, 'POST', png(n), true);
let rid = 0;
const tool = async (token, name, args) => {
  const r = await req(token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(r.status, 200, `${name} HTTP ${r.status}`);
  return JSON.parse(r.body.result.content[0].text);
};
const hasIndex = async d => !!(TEST_PG_URL
  ? await d.get("SELECT 1 AS x FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_files_message'")
  : await d.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_message'"));

try {
  const lin = (await req(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const chen = (await req(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const CHEN = chen.participant.participantId;
  assert.equal((await req(lin.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [PJ] })).status, 200, '陳大文加進預設專案');
  const ai = (await req(lin.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '林志明的程式開發助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiToken = await testToken(db, ai.participantId);

  // ---------- 1 只存檔不發文 ----------
  const before = (await req(lin.token, `/api/messages?project=${encodeURIComponent(PJ)}`)).body.items.length;
  const f = [];
  for (const [i, name] of ['1-搜尋結果.png', '2-搜尋框.png', '3-錯誤訊息.png'].entries()) {
    const r = await up(lin.token, name, i + 1);
    assert.equal(r.status, 201, '1 post=false 上傳 201：' + JSON.stringify(r.body));
    assert.ok(!r.body.message, '1 post=false 不發文');
    f.push(r.body.file.fileId);
  }
  assert.equal((await req(lin.token, `/api/messages?project=${encodeURIComponent(PJ)}`)).body.items.length, before, '1 沒有多出訊息');
  assert.equal((await req(lin.token, `/api/files/${f[0]}`)).status, 404, '1 還沒掛上訊息：下載不到');

  // ---------- 2 一次發成一則 ----------
  const post = body => req(lin.token, '/api/messages', 'POST', { project: PJ, requestId: 'mf_' + ++rid, ...body });
  const NOTE = '@陳大文 搜尋框打「台北」還是會吃字，1 是結果、2 是輸入中、3 是錯誤。';
  const r2 = await post({ requestId: 'mf_multi', text: NOTE, recipientIds: [CHEN], fileIds: f });
  assert.equal(r2.status, 201, '2 帶 fileIds 發文：' + JSON.stringify(r2.body));
  const m = r2.body;
  assert.equal(m.file.fileId, f[0], '2 file＝第一個（舊版照讀）');
  assert.deepEqual(m.files.map(x => x.fileId), f, '2 files＝全部、照上傳順序');
  assert.deepEqual(m.files.map(x => x.name), ['1-搜尋結果.png', '2-搜尋框.png', '3-錯誤訊息.png']);
  assert.match(m.text, /^@陳大文 搜尋框打「台北」.*\n\[文件\] 3 個檔案（已聲明不含程式碼與客戶個資；1 小時後自動刪除）\n1\. 1-搜尋結果\.png（12 B，SHA-256 [0-9a-f]{12}…）下載：GET \/api\/files\/file_/s, '2 內文：附註＋每個檔的下載連結：' + m.text);
  for (const id of f) assert.ok(m.text.includes(`GET /api/files/${id}`), '2 每個檔都有下載連結');
  const nt = (await req(chen.token, '/api/notifications')).body.items.filter(n => n.messageId === m.messageId);
  assert.equal(nt.length, 1, '2 通知只發一次');
  for (const id of f) assert.equal((await req(chen.token, `/api/files/${id}`)).status, 200, '2 掛上後收件人下載得到 ' + id);
  const listed = (await req(chen.token, `/api/messages?project=${encodeURIComponent(PJ)}`)).body.items.find(x => x.messageId === m.messageId);
  assert.deepEqual(listed.files.map(x => x.fileId), f, '3 列表也帶 files');
  assert.ok(listed.files.every(x => x.available && x.downloadUrl), '3 每個都 available、有 downloadUrl');
  assert.deepEqual((await req(chen.token, `/api/messages/${m.messageId}`)).body.files.map(x => x.fileId), f, '3 單則也帶 files');
  // 同一 requestId 重送 → 同一則
  const again = await post({ requestId: 'mf_multi', text: NOTE, recipientIds: [CHEN], fileIds: f });
  assert.ok(again.status === 200 && again.body.messageId === m.messageId, '4 同一 requestId 重送回同一則：' + JSON.stringify(again.body).slice(0, 200));
  assert.equal((await req(chen.token, '/api/notifications')).body.items.filter(n => n.messageId === m.messageId).length, 1, '4 重送不多發通知');

  // ---------- 3 舊的單檔上傳照舊 ----------
  const one = await req(lin.token, `/api/files?${new URLSearchParams({ name: '單張.png', declared: 'true', project: PJ, text: '單張' })}`, 'POST', png(9), true);
  assert.equal(one.status, 201);
  assert.match(one.body.message.text, /^單張\n\[文件\] 單張\.png（12 B/, '3 單檔內文格式不變');
  assert.ok(!one.body.message.files, '3 單檔不多帶 files（跟 file 一樣）');

  // ---------- 4 擋 ----------
  const five = [];
  for (let i = 0; i < 5; i++) five.push((await up(lin.token, `x${i}.png`, 20 + i)).body.file.fileId);
  let r = await post({ text: '五張', fileIds: five });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'TOO_MANY_FILES', '4 第 5 張擋下：' + JSON.stringify(r.body));
  assert.match(r.body.error.message, /最多 4 個/);
  r = await post({ text: '重複', fileIds: [five[0], five[0]] });
  assert.equal(r.status, 400, '4 重複擋下');
  r = await post({ text: '空', fileIds: [] });
  assert.equal(r.status, 400, '4 空陣列擋下');
  r = await post({ text: '不是陣列', fileIds: five[0] });
  assert.equal(r.status, 400, '4 不是陣列擋下');
  const chensFile = (await up(chen.token, 'chen.png', 30)).body.file.fileId;
  r = await post({ text: '別人的', fileIds: [five[0], chensFile] });
  assert.equal(r.status, 404, '4 別人的檔不能掛');
  r = await post({ text: '已掛過', fileIds: [f[1], five[0]] });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'FILE_ALREADY_POSTED', '4 已掛在別則的檔不能再掛');
  await req(lin.token, `/api/files/${five[1]}`, 'DELETE');
  r = await post({ text: '刪掉的', fileIds: [five[1]] });
  assert.equal(r.status, 404, '4 刪掉的檔不能掛');
  await db.run('UPDATE files SET expires_at = ? WHERE id = ?', Date.now() - 1000, five[2]);
  r = await post({ text: '過期的', fileIds: [five[2]] });
  assert.equal(r.status, 404, '4 過期的檔不能掛');
  assert.equal((await db.get('SELECT message_id FROM files WHERE id = ?', five[0])).message_id, null, '4 被擋時檔案沒有被掛走');
  // 附註可以空：只有檔案
  r = await post({ fileIds: [five[0], five[3]] });
  assert.equal(r.status, 201, '附註空也能發：' + JSON.stringify(r.body));
  assert.match(r.body.text, /^\[文件\] 2 個檔案/, '附註空：內文從 [文件] 開始');
  // 刪掉其中一個：那一格 available=false，其他照常
  await req(lin.token, `/api/files/${five[3]}`, 'DELETE');
  const part = (await req(lin.token, `/api/messages/${r.body.messageId}`)).body.files;
  assert.deepEqual(part.map(x => [x.fileId, x.available]), [[five[0], true], [five[3], false]], '只刪一個：其他留著');

  // ---------- 5 AI 用 MCP 讀到全部 ----------
  await req(lin.token, '/api/messages', 'POST', { project: PJ, requestId: 'mf_ai_ask', text: '@林志明的程式開發助手 看一下這三張', recipientIds: [ai.participantId], replyToMessageId: m.messageId });
  const read = await tool(aiToken, 'aigile_read', { messageId: m.messageId });
  const rm = read.message || read;
  assert.equal(rm.file.fileId, f[0], '5 MCP 仍有 file（第一個）');
  assert.deepEqual(rm.files.map(x => x.fileId), f, '5 MCP aigile_read 回傳全部檔案：' + JSON.stringify(rm).slice(0, 300));
  assert.deepEqual(rm.files.map(x => x.name), ['1-搜尋結果.png', '2-搜尋框.png', '3-錯誤訊息.png']);
  const ctx = await tool(aiToken, 'aigile_read', { messageId: m.messageId, context: true });
  assert.ok(JSON.stringify(ctx).includes(f[2]), '5 context 讀法也看得到第 3 個檔');
  const readOne = await tool(aiToken, 'aigile_read', { messageId: one.body.message.messageId });
  assert.ok(!(readOne.message || readOne).files, '5 單檔不多帶 files（省 token）');
  const a1 = (await up(aiToken, 'ai-1.png', 41)).body.file.fileId, a2 = (await up(aiToken, 'ai-2.png', 42)).body.file.fileId;
  r = await req(aiToken, '/api/messages', 'POST', { project: PJ, requestId: 'mf_ai_post', text: '[進度] 兩張畫面給你看', fileIds: [a1, a2], replyFrom: [] });
  assert.equal(r.status, 201, 'AI 也能一次發多張：' + JSON.stringify(r.body).slice(0, 300));
  assert.equal(r.body.files.length, 2);

  // ---------- 6 資料庫升級 003 ----------
  assert.ok(await hasIndex(db), '6 全新站有 idx_files_message');
  await db.run('DROP INDEX idx_files_message');
  await db.run("DELETE FROM schema_migrations WHERE name = '003_files_message.sql'");
  assert.ok(!(await hasIndex(db)), '6 模擬舊站：沒有索引');
  await db.close();
  const logs = [], log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try { db = await openTestDb(dbFile); } finally { console.log = log; }
  assert.ok(logs.some(l => l.includes('003_files_message.sql')), '6 舊站重開會補套 003：' + logs.join(' / '));
  assert.ok(await hasIndex(db), '6 補套後有索引');
  assert.ok(await db.get("SELECT 1 AS x FROM schema_migrations WHERE name = '003_files_message.sql'"), '6 記成已套');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM files WHERE message_id = ?', m.messageId)).n, 3, '6 升級後資料照舊');
  console.log(`multi-file-test：全部通過（${TEST_PG_URL ? 'Postgres' : 'SQLite'}）`);
} finally {
  try { await db.close?.(); } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
