// 驗收測試：知識庫改成自己挑文件放進去（docs.in_kb）
// 修正前：專案文件區每份上傳的文件都自動抽字、被搜到；leader 上傳的自動排整理卡
// 修正後：只有放進知識庫（上傳帶 kb=1，或 POST /kb/docs 加入）的文件才抽字、整理、被搜；一般專案文件只存原檔，
//         aigile_doc_read 回原檔網址；只有 leader／管理員能放進或移出；移出刪段落、引用的知識頁標「來源已移出知識庫」；
//         舊資料升級（migrations/006_kb_opt_in.sql）：有知識頁引用或排在整理卡的留在知識庫，其他刪段落
// 測試資料全部由程式產生，不連正式庫。用法：node scripts/kb-opt-in-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-kb-opt-in-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const docText = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('../docs/api-reference.md', import.meta.url), 'utf8');
const app = createApp({ db, storage: dbStorage(db), docStorage: memStorage(), docText, config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const BASE = 'http://localhost';
const req = async (token, p, method = 'GET', body, raw) => {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { 'Content-Type': 'application/json' }) };
  const r = await app(new Request(BASE + p, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) }), BASE);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const code = r => r.body?.error?.code;
const enc = s => new TextEncoder().encode(s);
const pj = encodeURIComponent('預設專案'), KB = `/api/projects/${pj}/kb`;
const flush = () => app.flushBackground();
let rpc = 0;
const tool = async (tok, name, args) => {
  const r = (await req(tok, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } })).body.result;
  return r.isError ? { isError: true, text: r.content[0].text } : JSON.parse(r.content[0].text);
};

try {
  const liu = (await req(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 管理員
  const lead = (await req(null, '/api/join', 'POST', { name: '林小安', role: 'SM' })).body;
  const chen = (await req(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const id = x => x.participant.participantId;
  for (const p of [lead, chen]) await req(liu.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: ['預設專案'] });
  await req(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(lead), leaderOf: ['預設專案'] }] });
  const kbAi = (await req(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PO', role: '產品負責', name: '整理助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  await req(lead.token, `${KB}/settings`, 'PUT', { aiId: kbAi.participantId });
  const up = (tok, name, text, kb) => req(tok, `/api/projects/${pj}/docs?name=${encodeURIComponent(name)}&declared=true${kb ? '&kb=1' : ''}`, 'POST', null, enc(text));
  const docs = async () => new Map((await req(liu.token, `/api/projects/${pj}/docs`)).body.items.map(d => [d.name, d]));
  const hits = async q => (await req(chen.token, `${KB}/search?q=${encodeURIComponent(q)}`)).body.items.map(x => x.docName);
  const orgCards = () => db.all("SELECT * FROM cards WHERE title LIKE '整理知識庫%' ORDER BY seq");

  // ---------- 1) 一般專案文件：不抽字、不整理、搜不到；doc_read 回原檔 ----------
  let r = await up(lead.token, '會議紀錄.md', '# 週會\n下週三上線。');
  assert.deepEqual([r.status, r.body.doc.kb.inKb, r.body.doc.kb.status], [201, false, 'off'], '沒帶 kb：一般專案文件');
  const memo = r.body.doc.docId;
  await flush();
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?', memo)).n, 0, '一般文件不抽字');
  assert.deepEqual(await hits('上線'), [], '一般文件搜不到');
  assert.equal((await orgCards()).length, 0, 'leader 上傳一般文件：不排整理卡');
  let t = await tool(kbAi.token, 'aigile_doc_read', { project: '預設專案', docId: memo });
  assert.ok(t.original && t.downloadUrl && t.status === 'off' && /不在知識庫/.test(t.note), 'aigile_doc_read 讀一般文件：回原檔網址（本機轉接腳本會下載）：' + JSON.stringify(t));
  assert.equal(code(await req(lead.token, `${KB}/reindex`, 'POST', { docId: memo })), 'KB_NOT_IN', '一般文件不能補建索引');
  assert.equal(code(await req(lead.token, `${KB}/organize`, 'POST', { docIds: [memo] })), 'KB_NOTHING', '一般文件不能請 AI 整理');

  // ---------- 2) 只有 leader／管理員能放進知識庫 ----------
  assert.equal(code(await up(chen.token, '成員想放.md', '# x\n內容', true)), 'FORBIDDEN', '一般成員上傳到知識庫：擋下');
  assert.match((await tool(kbAi.token, 'aigile_doc_upload', { project: '預設專案', name: 'AI想放.md', content: '# x', declared: true, kb: true })).text, /FORBIDDEN|leader/, 'AI 帶 kb=true：擋下');
  t = await tool(kbAi.token, 'aigile_doc_upload', { project: '預設專案', name: 'AI上傳.md', content: '# AI\n報表格式', declared: true });
  assert.deepEqual([!!t.docId, t.inKb], [true, false], 'AI 上傳預設是一般專案文件');
  assert.ok((await req(kbAi.token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rpc, method: 'tools/list' })).body.result.tools.find(x => x.name === 'aigile_doc_upload').inputSchema.properties.kb, 'aigile_doc_upload 有 kb 選項');

  // ---------- 3) 上傳到知識庫：抽字、搜得到、自動排整理卡 ----------
  r = await up(lead.token, '員工手冊.md', '# 休假\n## 特別休假\n到職滿一年給 7 日。', true);
  assert.deepEqual([r.status, r.body.doc.kb.inKb, r.body.doc.kb.status], [201, true, 'pending'], 'kb=1：放進知識庫、抽字中');
  const hb = r.body.doc.docId;
  await flush();
  assert.deepEqual(await hits('特別休假'), ['員工手冊.md'], '知識庫文件搜得到');
  assert.deepEqual((await orgCards()).map(c => c.title), ['整理知識庫：1 份文件'], '放進知識庫：自動排整理卡');

  // ---------- 4) 從專案文件勾選加入 ----------
  assert.equal(code(await req(chen.token, `${KB}/docs`, 'POST', { action: 'add', docIds: [memo] })), 'FORBIDDEN', '一般成員不能加入');
  assert.equal(code(await req(lead.token, `${KB}/docs`, 'POST', { action: 'move', docIds: [memo] })), 'INVALID_REQUEST', 'action 只能 add／remove');
  assert.equal(code(await req(lead.token, `${KB}/docs`, 'POST', { action: 'add', docIds: [] })), 'INVALID_REQUEST', 'docIds 至少 1 份');
  r = await req(lead.token, `${KB}/docs`, 'POST', { action: 'add', docIds: [memo, hb, 'doc_nope'] });
  assert.deepEqual([r.status, r.body.done, r.body.skipped], [200, [memo], [hb, 'doc_nope']], '加入：已在知識庫、找不到的跳過');
  await flush();
  let ds = await docs();
  assert.deepEqual([ds.get('會議紀錄.md').kb.inKb, ds.get('會議紀錄.md').kb.status, ds.get('會議紀錄.md').kb.org], [true, 'indexed', 'todo'], '加入後抽字、排進整理卡');
  assert.deepEqual(await hits('上線'), ['會議紀錄.md'], '加入後搜得到');

  // ---------- 5) 移出知識庫：刪段落、搜不到、知識頁標「來源已移出知識庫」 ----------
  const card = ds.get('員工手冊.md').kb.cardId;
  t = await tool(kbAi.token, 'aigile_kb_write', { project: '預設專案', kind: 'source', title: '員工手冊.md', summary: '休假', sources: [hb], cardId: card, body: '## 重點\n- 特別休假 7 日。〔員工手冊.md › 特別休假〕' });
  const page = t.pageId;
  assert.equal(code(await req(chen.token, `${KB}/docs`, 'POST', { action: 'remove', docIds: [hb] })), 'FORBIDDEN', '一般成員不能移出');
  r = await req(lead.token, `${KB}/docs`, 'POST', { action: 'remove', docIds: [hb, memo] });
  assert.deepEqual([r.status, r.body.done.sort()], [200, [hb, memo].sort()], '移出兩份');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id IN (?, ?)', hb, memo)).n, 0, '移出：刪段落');
  assert.deepEqual([await hits('特別休假'), await hits('上線')], [[], []], '移出後搜不到');
  ds = await docs();
  assert.deepEqual([ds.get('員工手冊.md').kb.inKb, ds.get('員工手冊.md').kb.status, ds.get('會議紀錄.md').kb.org], [false, 'off', 'none'], '移出：一般文件、清掉整理排程（原檔留著）');
  r = await req(lead.token, `${KB}/pages/${page}`);
  assert.deepEqual([r.body.status, r.body.sources[0].inKb, r.body.sources[0].exists], ['stale', false, true], '摘要頁標過時、來源不在知識庫');
  assert.match(r.body.staleNote, /來源已移出知識庫：員工手冊\.md（林小安）/);
  assert.equal(code(await req(lead.token, `${KB}/pages/${page}/refresh`, 'POST', {})), 'KB_SOURCE_OUT', '來源都移出了：不能請 AI 更新（leader 決定刪不刪）');
  assert.equal((await req(lead.token, `${KB}/pages/${page}`, 'DELETE')).status, 200, 'leader 可以刪這頁');
  t = await tool(kbAi.token, 'aigile_doc_read', { project: '預設專案', docId: hb });
  assert.ok(t.original && t.status === 'off', '移出後 doc_read 回原檔');
  // 再加入：重新抽字
  await req(liu.token, `${KB}/docs`, 'POST', { action: 'add', docIds: [hb] });
  await flush();
  assert.deepEqual(await hits('特別休假'), ['員工手冊.md'], '管理員再加入：重新抽字、搜得到');

  // ---------- 6) 舊資料升級：有知識頁引用或在整理卡的留，其他刪段落 ----------
  const mk = async (name, text) => { const x = await up(lead.token, name, text, true); return x.body.doc.docId; };
  const [cited, queued, plain] = [await mk('被引用.md', '# a\n甲乙'), await mk('排整理.md', '# b\n丙丁'), await mk('沒整理.md', '# c\n戊己')];
  await flush();
  await db.run("UPDATE docs SET kb_org = NULL, kb_card = NULL WHERE id IN (?, ?)", cited, plain);
  await db.run("UPDATE docs SET kb_org = 'todo' WHERE id = ?", queued);
  await tool(kbAi.token, 'aigile_kb_write', { project: '預設專案', kind: 'topic', title: '舊頁', body: 'x', sources: [cited] });
  await db.run("UPDATE docs SET kb_org = NULL, kb_card = NULL WHERE id IN (?, ?)", cited, plain);
  await db.run('UPDATE docs SET in_kb = 0'); // 升級前：還沒有 in_kb，全部是 0
  const sql = fs.readFileSync(new URL('../migrations/006_kb_opt_in.sql', import.meta.url), 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('--') && !/^ALTER TABLE/.test(l));
  for (const s of sql) await db.run(s);
  const st = async x => db.get('SELECT in_kb, kb_status, kb_chunks FROM docs WHERE id = ?', x);
  assert.deepEqual([(await st(cited)).in_kb, (await st(queued)).in_kb, (await st(plain)).in_kb], [1, 1, 0], '有知識頁引用、在整理卡的留；其他移出');
  assert.deepEqual([(await st(plain)).kb_status, (await st(plain)).kb_chunks, (await db.get('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?', plain)).n], [null, 0, 0], '移出的刪段落、清狀態');
  assert.ok((await db.get('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?', cited)).n > 0, '留下的段落不動');
  assert.deepEqual([await hits('甲乙'), await hits('戊己')], [['被引用.md'], []], '升級後：留下的搜得到、移出的搜不到');

  console.log('kb-opt-in-test：全部通過');
} catch (e) {
  console.error('kb-opt-in-test 失敗：', e);
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
