// 驗收測試：放進知識庫時可以選「只抽字、不要 AI 整理」
// 修正前：放進知識庫（上傳 kb=1、POST /kb/docs add）就一定排進整理卡
// 修正後：上傳帶 curate=0、add 帶 curate:false＝照樣抽字、搜得到原文，但不排整理卡（文件清單 kb.org＝off）；
//         leader／管理員之後可以「請 AI 整理」（/kb/organize）；已整理的可以 action:stop 改回不整理（已寫的頁留著，不再自動排整理）；
//         aigile_doc_upload 的 kb 也支援 curate
// 測試資料全部由程式產生，不連正式庫。用法：node scripts/kb-no-curate-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-kb-no-curate-'));
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
  const up = (tok, name, text, extra = '') => req(tok, `/api/projects/${pj}/docs?name=${encodeURIComponent(name)}&declared=true&kb=1${extra}`, 'POST', null, enc(text));
  const docs = async () => new Map((await req(liu.token, `/api/projects/${pj}/docs`)).body.items.map(d => [d.name, d]));
  const hits = async q => (await req(chen.token, `${KB}/search?q=${encodeURIComponent(q)}`)).body.items.map(x => x.docName);
  const orgCards = () => db.all("SELECT * FROM cards WHERE title LIKE '整理知識庫%' ORDER BY seq");

  // ---------- A) 上傳到知識庫帶 curate=0：照樣抽字、搜得到，但不排整理卡 ----------
  let r = await up(lead.token, '報價單範本.md', '# 報價\n單價含稅 1,200 元。', '&curate=0');
  assert.deepEqual([r.status, r.body.doc.kb.inKb], [201, true], 'curate=0 仍放進知識庫');
  const quote = r.body.doc.docId;
  await flush();
  assert.deepEqual(await hits('含稅'), ['報價單範本.md'], '只抽字不整理：搜得到原文');
  assert.equal((await orgCards()).length, 0, '只抽字不整理：不排整理卡');
  let ds = await docs();
  assert.deepEqual([ds.get('報價單範本.md').kb.status, ds.get('報價單範本.md').kb.org], ['indexed', 'off'], '清單狀態 org=off（只搜原文，不整理）');
  assert.equal((await req(lead.token, `${KB}/pages`)).body.todo.length, 0, 'AI 的待整理清單沒有它');
  // 預設（不帶 curate）照舊排整理卡
  r = await up(lead.token, '員工手冊.md', '# 休假\n## 特別休假\n到職滿一年給 7 日。');
  const hb = r.body.doc.docId;
  await flush();
  assert.deepEqual((await orgCards()).map(c => c.title), ['整理知識庫：1 份文件'], '預設 curate：照舊排整理卡');
  // 補建索引也不會把 off 的排進整理卡
  await req(lead.token, `${KB}/reindex`, 'POST', { docId: quote });
  await flush();
  assert.equal((await docs()).get('報價單範本.md').kb.org, 'off', '補建索引後仍是 off');
  assert.deepEqual((await orgCards()).map(c => c.title), ['整理知識庫：1 份文件'], '補建索引不排整理卡');

  // ---------- B) 從專案文件加入帶 curate:false ----------
  const plain = (await req(lead.token, `/api/projects/${pj}/docs?name=${encodeURIComponent('表單.md')}&declared=true`, 'POST', null, enc('# 請假單\n填寫日期與事由。'))).body.doc.docId;
  assert.equal(code(await req(lead.token, `${KB}/docs`, 'POST', { action: 'add', docIds: [plain], curate: 'no' })), 'INVALID_REQUEST', 'curate 要是布林');
  r = await req(lead.token, `${KB}/docs`, 'POST', { action: 'add', docIds: [plain], curate: false });
  assert.deepEqual([r.status, r.body.done], [200, [plain]], '加入（不整理）');
  await flush();
  ds = await docs();
  assert.deepEqual([ds.get('表單.md').kb.inKb, ds.get('表單.md').kb.status, ds.get('表單.md').kb.org], [true, 'indexed', 'off'], '加入不整理：抽字、org=off');
  assert.deepEqual(await hits('事由'), ['表單.md'], '加入不整理：搜得到');
  assert.equal((await orgCards()).length, 1, '加入不整理：不開新整理卡');

  // ---------- B2) 「請 AI 整理」：off 的也能排進整理卡 ----------
  r = await req(lead.token, `${KB}/organize`, 'POST', { docIds: [quote] });
  assert.deepEqual([r.status, r.body.queued], [200, 1], '請 AI 整理：排進整理卡');
  ds = await docs();
  assert.equal(ds.get('報價單範本.md').kb.org, 'todo', '請 AI 整理後是 todo');
  const card = ds.get('報價單範本.md').kb.cardId;
  await tool(kbAi.token, 'aigile_kb_write', { project: '預設專案', kind: 'source', title: '報價單範本.md', summary: '報價', sources: [quote], cardId: card, body: '## 重點\n- 含稅 1,200 元。〔報價單範本.md › 報價〕' });
  assert.deepEqual([(await docs()).get('報價單範本.md').kb.org, (await docs()).get('報價單範本.md').kb.pages], ['done', 1], '寫完頁：已整理');

  // ---------- B3) 已整理的改回不整理：頁留著，原文換版不再自動排整理 ----------
  assert.equal(code(await req(chen.token, `${KB}/docs`, 'POST', { action: 'stop', docIds: [quote] })), 'FORBIDDEN', '一般成員不能改成不整理');
  r = await req(lead.token, `${KB}/docs`, 'POST', { action: 'stop', docIds: [quote, plain] });
  assert.deepEqual([r.status, r.body.done, r.body.skipped], [200, [quote], [plain]], '改成不整理：已經是 off 的跳過');
  ds = await docs();
  assert.deepEqual([ds.get('報價單範本.md').kb.org, ds.get('報價單範本.md').kb.pages], ['off', 1], 'off，頁數照樣帶（知識頁保留）');
  assert.equal((await req(lead.token, `${KB}/pages`)).body.items.length, 1, '知識頁保留');
  assert.deepEqual(await hits('含稅'), ['報價單範本.md'], '改成不整理後原文照樣搜得到');
  // 原文換新版（同名上傳、不整理）：頁標可能過時，但不自動排整理卡
  const cardsBefore = (await orgCards()).length;
  await up(lead.token, '報價單範本.md', '# 報價\n單價含稅 1,300 元。', '&curate=0');
  await flush();
  const pid = (await req(lead.token, `${KB}/pages`)).body.items[0].pageId;
  assert.equal((await req(lead.token, `${KB}/pages/${pid}`)).body.status, 'stale', '原文換新版：頁標可能過時');
  assert.equal((await orgCards()).length, cardsBefore, '原文換新版：不自動排整理卡');
  // 請 AI 更新那頁：開更新卡，但 off 的來源不改回 todo
  r = await req(lead.token, `${KB}/pages/${pid}/refresh`, 'POST', {});
  assert.equal(r.status, 200, '手動請 AI 更新仍可以');
  assert.equal((await docs()).get('報價單範本.md').kb.org, 'off', '更新卡不把 off 的來源改回整理排程');
  // 在整理卡裡（todo）的也能改成不整理：從卡裡拿掉
  r = await req(lead.token, `${KB}/docs`, 'POST', { action: 'stop', docIds: [hb] });
  assert.deepEqual(r.body.done, [hb], 'todo 的改成不整理');
  assert.deepEqual([(await docs()).get('員工手冊.md').kb.org, (await req(lead.token, `${KB}/pages`)).body.todo.length], ['off', 0], '從整理卡拿掉、AI 待整理清單沒有它');
  // 移出再加入（預設 curate）：清掉 off，照常排整理
  await req(lead.token, `${KB}/docs`, 'POST', { action: 'remove', docIds: [plain] });
  await req(lead.token, `${KB}/docs`, 'POST', { action: 'add', docIds: [plain] });
  await flush();
  assert.equal((await docs()).get('表單.md').kb.org, 'todo', '移出再加入（預設）：照常排整理');

  // ---------- C) MCP：aigile_doc_upload 的 kb 支援 curate ----------
  const schema = (await req(kbAi.token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rpc, method: 'tools/list' })).body.result.tools.find(x => x.name === 'aigile_doc_upload').inputSchema.properties;
  assert.ok(schema.curate?.type === 'boolean', 'aigile_doc_upload 有 curate 選項');
  // AI 不能放進知識庫（只有人類 leader／管理員），帶 curate 也一樣擋下
  assert.match((await tool(kbAi.token, 'aigile_doc_upload', { project: '預設專案', name: 'AI想放.md', content: '# x', declared: true, kb: true, curate: false })).text, /FORBIDDEN/, 'AI 帶 kb+curate：照樣擋下');

  console.log('kb-no-curate-test：全部通過');
} catch (e) {
  console.error('kb-no-curate-test 失敗：', e);
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
