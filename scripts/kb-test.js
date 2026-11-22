// 驗收測試：知識庫底層（上傳文件自動抽字、分段、搜尋、AI 分段讀）
// 修正前：專案文件區只存原檔，AI 和人都搜不到文件內容（/api/projects/:id/kb/search 404）
// 修正後：上傳 md／txt／docx／pptx／xlsx 背景抽字分段（kb_chunks），PDF、圖片標「只有原檔」；含密鑰不建索引；
//         單檔 20 萬字截斷、全站上限只存原檔；搜尋只掃同專案、每個詞都要出現、超過段數上限擋下；刪文件連分段一起刪；
//         leader／管理員可補建索引；MCP aigile_kb_search、aigile_doc_read 標 untrusted_content
// 測試資料全部由程式產生（scripts/kb-fixtures.js），不連正式庫
// 用法：node scripts/kb-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';
import { extractChunks, splitLong, kbTerms, KB_MAX_CHARS_PER_DOC } from '../src/kb.js';
import { makeZip, makeDocx, makePptx, makeXlsx } from './kb-fixtures.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-kb-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const store = memStorage();
const docText = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('../docs/api-reference.md', import.meta.url), 'utf8');
const app = createApp({ db, storage: dbStorage(db), docStorage: store, docText, config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', kbMaxTotalChars: '300000' } });
const BASE = 'http://localhost';
const req = async (token, p, method = 'GET', body, raw) => {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { 'Content-Type': 'application/json' }) };
  const r = await app(new Request(BASE + p, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) }), BASE);
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, body: ct.includes('json') ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
};
const code = r => r.body?.error?.code;
const enc = s => new TextEncoder().encode(s);
const pj = encodeURIComponent('預設專案'), bankPj = encodeURIComponent('第二專案');
const flush = () => app.flushBackground();
// 搜尋每人每分鐘 10 次：每次搜尋前清掉計數（限流另外單獨測）
const search = async (tok, q, extra = '') => { await db.run("DELETE FROM app_settings WHERE key LIKE 'sq:%'"); return req(tok, `/api/projects/${pj}/kb/search?q=${encodeURIComponent(q)}${extra}`); };
let rpcId = 0;
const tool = async (tok, name, args) => {
  const r = await req(tok, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } });
  const res = r.body.result;
  return res.isError ? { isError: true, text: res.content[0].text } : JSON.parse(res.content[0].text);
};

try {
  // ---------- 1) 抽字單元：中英文、標題、表格、投影片備註、工作表；deflate 與不壓縮都讀得到 ----------
  const docx = await makeDocx([{ h: 1, text: '第三章 休假' }, { h: 2, text: '3.1 特別休假' }, { text: '到職滿一年者，給予特別休假 7 日。' }, { table: [['年資', '天數'], ['三年以上', '14 日']] }, { h: 2, text: '3.2 Remote Work' }, { text: 'Employees may work remotely 2 days per week.' }]);
  let r = await extractChunks('docx', docx);
  assert.deepEqual(r.chunks.map(c => c.section), ['第三章 休假 > 3.1 特別休假', '第三章 休假 > 3.2 Remote Work'], 'docx 依標題分段、section 是標題路徑：' + JSON.stringify(r.chunks));
  assert.match(r.chunks[0].content, /給予特別休假 7 日。\n年資\t天數\n三年以上\t14 日/, '表格每列一行、欄用 Tab');
  assert.match(r.chunks[1].content, /work remotely 2 days/, '英文照抽');
  r = await extractChunks('docx', await makeDocx([{ text: 'stored 不壓縮' }], { stored: true }));
  assert.equal(r.chunks[0].content, 'stored 不壓縮', '不壓縮的 zip 也讀得到');
  r = await extractChunks('pptx', await makePptx([{ lines: ['出貨流程', 'Step 1: 檢查訂單'], notes: ['備註：先打電話'] }, { lines: ['異常處理'] }]));
  assert.deepEqual(r.chunks.map(c => [c.section, c.content]), [['投影片第 1 頁', '出貨流程\nStep 1: 檢查訂單\n（講者備註）備註：先打電話'], ['投影片第 2 頁', '異常處理']], '一張投影片一段、附講者備註、頁碼欄位不算');
  r = await extractChunks('xlsx', await makeXlsx([{ name: '代碼表', rows: [['代碼', '說明', '', '金額'], ['A01', '國內出差', '', 1200]] }, { name: 'Sheet2', rows: [['only']] }]));
  assert.deepEqual(r.chunks.map(c => [c.section, c.content]), [['工作表：代碼表', '代碼\t說明\t\t金額\nA01\t國內出差\t\t1200'], ['工作表：Sheet2', 'only']], '每列一行、Tab 分欄、空格保留位置');
  r = await extractChunks('md', enc('# 手冊\n前言\n\n## 第一章\n' + '很長的一段。'.repeat(500)));
  assert.ok(r.chunks.length >= 2 && r.chunks.every(c => c.content.length <= 2000), 'md 太長的段落切到 2,000 字內');
  assert.ok(splitLong('一二三。'.repeat(600)).every(x => x.length <= 2000 && x.endsWith('。')), '在句號處切');
  r = await extractChunks('txt', enc('x'.repeat(KB_MAX_CHARS_PER_DOC + 5000)));
  assert.deepEqual([r.chars, r.truncated], [KB_MAX_CHARS_PER_DOC, true], '單檔最多 20 萬字，超過截斷');
  assert.equal(await extractChunks('pdf', enc('%PDF-')), null, 'PDF 不抽字');
  assert.deepEqual(kbTerms('  年假  WFH 年假 wfh a b c d '), ['年假', 'WFH', 'a', 'b', 'c'], '最多 5 個詞、不分大小寫去重');

  // ---------- 成員 ----------
  const liu = (await req(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 管理員
  const chen = (await req(null, '/api/join', 'POST', { name: '陳昭宇', role: 'PG' })).body;
  const bank = (await req(null, '/api/join', 'POST', { name: '第二專案端', role: 'BA' })).body;
  const ro = (await req(null, '/api/join', 'POST', { name: '唯讀者', role: 'BU' })).body;
  const lead = (await req(null, '/api/join', 'POST', { name: '專案組長', role: 'SM' })).body;
  const id = x => x.participant.participantId;
  for (const [p, ps] of [[chen, ['預設專案']], [bank, ['第二專案']], [ro, ['預設專案']], [lead, ['預設專案']]]) await req(liu.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: ps });
  await req(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(ro), readOnlyIn: ['預設專案'] }, { id: id(lead), leaderOf: ['預設專案'] }] });
  const ai = (await req(chen.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '陳的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const up = (tok, name, bytes, p = pj) => req(tok, `/api/projects/${p}/docs?name=${encodeURIComponent(name)}&declared=true&kb=1`, 'POST', null, bytes); // 上傳到知識庫才抽字（leader 才能放）

  // 修正前：搜尋 API 不存在
  r = await search(chen.token, '特別休假');
  assert.equal(r.status, 200, '知識庫搜尋 API 要存在：' + JSON.stringify(r.body).slice(0, 200));
  assert.deepEqual(r.body.items, [], '還沒有文件：空結果');

  // ---------- 2) 上傳後背景抽字；徽章資訊；只有原檔 ----------
  const hb = await up(lead.token, '員工手冊.docx', docx);
  assert.equal(hb.status, 201);
  assert.equal(hb.body.doc.kb.status, 'pending', '上傳不等抽字：先回「抽字中」');
  const files = { '出貨.pptx': await makePptx([{ lines: ['出貨流程', '異常時通知倉管 分機 1234'] }]), '代碼.xlsx': await makeXlsx([{ name: '代碼表', rows: [['A01', '國內出差']] }]),
    '說明.md': enc('# 報帳\n## 4.2 住宿\n住宿上限每晚 **2,500 元**。\n'), '流程圖.pdf': enc('%PDF-1.4\n%%EOF\n') };
  const ids = {};
  for (const [n, b] of Object.entries(files)) ids[n] = (await up(lead.token, n, b)).body.doc.docId;
  ids['員工手冊.docx'] = hb.body.doc.docId;
  await flush();
  let list = (await req(chen.token, `/api/projects/${pj}/docs`)).body;
  const kbOf = n => list.items.find(x => x.name === n).kb;
  assert.deepEqual(kbOf('員工手冊.docx'), { inKb: true, status: 'indexed', chunks: 2, chars: kbOf('員工手冊.docx').chars, truncated: false, org: 'none' }, '抽完：已抽字 2 段');
  assert.deepEqual(['出貨.pptx', '代碼.xlsx', '說明.md', '流程圖.pdf'].map(n => kbOf(n).status), ['indexed', 'indexed', 'indexed', 'original'], 'PDF 標只有原檔');
  assert.equal(list.canManageKb, false, '一般成員不能補建索引');
  assert.equal((await req(lead.token, `/api/projects/${pj}/docs`)).body.canManageKb, true, 'leader 可以');
  assert.equal((await req(liu.token, `/api/projects/${pj}/docs`)).body.canManageKb, true, '管理員可以');

  // ---------- 3) 搜尋：每個詞都要出現、section 加權、片段、專案隔離、唯讀可搜 ----------
  r = await search(chen.token, '特別休假');
  assert.deepEqual(r.body.items.map(x => [x.docName, x.section]), [['員工手冊.docx', '第三章 休假 > 3.1 特別休假']], '中文搜得到，附文件名與章節：' + JSON.stringify(r.body));
  assert.match(r.body.items[0].snippet, /給予特別休假 7 日/, '附命中前後的片段');
  r = await search(chen.token, 'remote WORK');
  assert.equal(r.body.items[0]?.section, '第三章 休假 > 3.2 Remote Work', '英文不分大小寫、多詞都要出現');
  assert.equal((await search(chen.token, '特別休假 Remote')).body.items.length, 0, '兩個詞不在同一段：不算');
  assert.equal((await search(chen.token, '分機 1234')).body.items[0]?.docName, '出貨.pptx', '投影片搜得到');
  assert.equal((await search(chen.token, '國內出差')).body.items[0]?.section, '工作表：代碼表', '工作表搜得到');
  assert.equal((await search(chen.token, '2,500')).body.items[0]?.docName, '說明.md', '數字照原文');
  assert.equal((await search(chen.token, '100%_')).body.items.length, 0, '% 和 _ 當一般字元，不當萬用字元');
  r = await search(ro.token, '特別休假');
  assert.equal(r.body.items.length, 1, '唯讀成員可以搜尋');
  assert.equal((await search(bank.token, '特別休假')).status, 404, '別專案的人搜不到（當作不存在）');
  await up(bank.token, '銀行手冊.md', enc('# 銀行\n特別休假 規定不同'), bankPj);
  await flush();
  r = await search(chen.token, '規定不同');
  assert.equal(r.body.items.length, 0, '只搜自己專案：第二專案的文件不會出現');
  assert.equal(code(await search(chen.token, '一')), 'INVALID_REQUEST', 'q 至少 2 字');

  // ---------- 4) 分段讀 ----------
  r = await req(chen.token, `/api/projects/${pj}/docs/${ids['員工手冊.docx']}/text?from=0&limit=1`);
  assert.deepEqual([r.body.status, r.body.totalChunks, r.body.items.length, r.body.items[0].idx, r.body.nextFrom], ['indexed', 2, 1, 0, 1], '分段讀：一次 1 段、回 nextFrom');
  r = await req(chen.token, `/api/projects/${pj}/docs/${ids['員工手冊.docx']}/text?from=1`);
  assert.deepEqual([r.body.items.map(x => x.idx), r.body.nextFrom], [[1], undefined], '讀到最後沒有 nextFrom');
  r = await req(chen.token, `/api/projects/${pj}/docs/${ids['流程圖.pdf']}/text`);
  assert.ok(r.body.original && r.body.downloadUrl && /只有原檔/.test(r.body.note) && !r.body.items.length, '只有原檔：回原因與下載網址');
  assert.equal((await req(bank.token, `/api/projects/${pj}/docs/${ids['員工手冊.docx']}/text`)).status, 404, '別專案讀不到');
  assert.equal((await req(chen.token, `/api/projects/${bankPj}/docs/${ids['員工手冊.docx']}/text`)).status, 404, '換專案路徑也讀不到');

  // ---------- 5) 密鑰不建索引、抽字失敗、截斷 ----------
  const sec1 = (await up(lead.token, '設定說明.md', enc(`# 接入\n請用這個 Token：${ai.token}`))).body.doc.docId;
  const sec2 = (await up(lead.token, '金鑰.txt', enc('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n'))).body.doc.docId;
  const sec3 = (await up(lead.token, '連線.md', enc('資料庫 postgres://app:S3cretPass@db.local/app'))).body.doc.docId;
  const bad = (await up(lead.token, '壞掉.docx', await makeZip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]], { stored: true }).then(z => { const v = new DataView(z.buffer); v.setUint16(8, 8, true); for (let p = 0; p < z.length - 4; p++) if (v.getUint32(p, true) === 0x02014b50) v.setUint16(p + 10, 8, true); return z; }))).body.doc.docId;
  const longId = (await up(lead.token, '很長.txt', enc('長'.repeat(KB_MAX_CHARS_PER_DOC + 100)))).body.doc.docId;
  await flush();
  list = (await req(chen.token, `/api/projects/${pj}/docs`)).body;
  const st = i => list.items.find(x => x.docId === i).kb;
  assert.deepEqual([sec1, sec2, sec3].map(i => st(i).status), ['secret', 'secret', 'secret'], '成員 Token、私鑰、連線字串密碼：不建索引');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id IN (?, ?, ?)', sec1, sec2, sec3)).n, 0, '含密鑰的沒有分段');
  assert.equal((await search(chen.token, '接入')).body.items.length, 0, '含密鑰的搜不到');
  assert.match((await req(chen.token, `/api/projects/${pj}/docs/${sec1}/text`)).body.note, /密鑰/, '分段讀回原因、不給文字');
  assert.equal(st(bad).status, 'failed', '解不開的檔：標抽字失敗');
  assert.deepEqual([st(longId).status, st(longId).chars, st(longId).truncated], ['indexed', KB_MAX_CHARS_PER_DOC, true], '超過 20 萬字截斷並標示');
  assert.ok((await req(chen.token, `/api/projects/${pj}/docs/${longId}/text?from=0&limit=1`)).body.truncated, '分段讀也標截斷');

  // ---------- 6) 全站字數上限：超過的新文件只存原檔 ----------
  const fullId = (await up(lead.token, '再一份.txt', enc('多'.repeat(150_000)))).body.doc.docId; // 測試上限 30 萬字，前面已用約 20 萬
  await flush();
  list = (await req(chen.token, `/api/projects/${pj}/docs`)).body;
  assert.equal(st(fullId).status, 'full', '全站字數滿了：新文件不抽字');

  // ---------- 7) 刪文件連分段一起刪；搜尋不再出現 ----------
  await req(chen.token, `/api/projects/${pj}/docs/${ids['說明.md']}`, 'DELETE');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?', ids['說明.md'])).n, 0, '刪文件刪分段');
  assert.equal((await search(chen.token, '2,500')).body.items.length, 0, '刪掉的搜不到');

  // ---------- 8) 補建索引：舊文件（沒有狀態）、失敗、卡住的；限 leader／管理員 ----------
  await db.run("UPDATE docs SET kb_status = NULL, kb_chunks = 0 WHERE id = ?", ids['代碼.xlsx']);
  await db.run('DELETE FROM kb_chunks WHERE doc_id = ?', ids['代碼.xlsx']);
  await db.run("UPDATE docs SET kb_status = 'pending', kb_at = ? WHERE id = ?", new Date(Date.now() - 11 * 60_000).toISOString(), ids['出貨.pptx']);
  list = (await req(chen.token, `/api/projects/${pj}/docs`)).body;
  assert.deepEqual([st(ids['代碼.xlsx']).status, st(ids['出貨.pptx']).status], ['none', 'failed'], '舊文件標還沒建；抽字中卡超過 10 分鐘當失敗');
  assert.equal(code(await req(chen.token, `/api/projects/${pj}/kb/reindex`, 'POST', {})), 'FORBIDDEN', '一般成員不能補建');
  assert.equal(code(await req(ai.token, `/api/projects/${pj}/kb/reindex`, 'POST', {})), 'FORBIDDEN', 'AI 不能補建');
  assert.equal((await req(ro.token, `/api/projects/${pj}/kb/reindex`, 'POST', {})).status, 403, '唯讀不能補建');
  r = await req(lead.token, `/api/projects/${pj}/kb/reindex`, 'POST', {});
  assert.deepEqual(r.body, { started: 3, remaining: 0 }, 'leader 補建：舊的、卡住的、失敗的各一份：' + JSON.stringify(r.body));
  await flush();
  list = (await req(chen.token, `/api/projects/${pj}/docs`)).body;
  assert.deepEqual([st(ids['代碼.xlsx']).status, st(ids['出貨.pptx']).status, st(bad).status], ['indexed', 'indexed', 'failed'], '補建後已抽字；壞檔照樣失敗');
  assert.equal((await search(chen.token, '國內出差')).body.items.length, 1, '補建後搜得到');
  r = await req(liu.token, `/api/projects/${pj}/kb/reindex`, 'POST', { docId: ids['員工手冊.docx'] });
  assert.deepEqual(r.body, { started: 1, remaining: 0 }, '管理員可指定一份重建');
  await flush();
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id = ?', ids['員工手冊.docx'])).n, 2, '重建不會重複分段');

  // ---------- 9) MCP：aigile_kb_search、aigile_doc_read ----------
  await db.run("DELETE FROM app_settings WHERE key LIKE 'sq:%'");
  let t = await tool(ai.token, 'aigile_kb_search', { project: '預設專案', q: '特別休假' });
  assert.ok(t.items?.[0]?.docId === ids['員工手冊.docx'] && t.items[0].section && t.items[0].snippet && t.items[0].score === undefined, 'MCP 搜尋回 docId、section、snippet：' + JSON.stringify(t));
  assert.deepEqual(t.untrusted_content, ['snippet', 'title'], '片段與知識頁標題標 untrusted_content');
  t = await tool(ai.token, 'aigile_doc_read', { project: '預設專案', docId: t.items[0].docId, limit: 1 });
  assert.ok(t.items[0].content && t.nextFrom === 1 && t.untrusted_content.includes('content'), 'MCP 分段讀標 untrusted_content');
  t = await tool(ai.token, 'aigile_doc_read', { project: '預設專案', docId: ids['流程圖.pdf'] });
  assert.ok(t.original && t.downloadUrl, 'MCP 讀只有原檔：回下載網址（本機轉接腳本會下載）');
  t = await tool(ai.token, 'aigile_doc_read', { project: '預設專案', docId: 'msg_x' });
  assert.ok(t.isError && /doc_/.test(t.text), 'docId 格式錯當場擋');

  // ---------- 10) 知識庫搜尋不限流（熱修：管理員 11/22 拿掉每分鐘 10 次）與專案段數上限 ----------
  await db.run("DELETE FROM app_settings WHERE key LIKE 'sq:%'");
  let last;
  for (let i = 0; i < 11; i++) last = await req(chen.token, `/api/projects/${pj}/kb/search?q=${encodeURIComponent('特別休假')}`);
  assert.equal(code(last), undefined, '第 11 次照樣能搜（不限流）');
  const app2 = createApp({ db, storage: dbStorage(db), docStorage: store, docText, config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', kbMaxProjectChunks: '3' } });
  await db.run("DELETE FROM app_settings WHERE key LIKE 'sq:%'");
  const r2 = await app2(new Request(`${BASE}/api/projects/${pj}/kb/search?q=${encodeURIComponent('特別休假')}`, { headers: { Authorization: `Bearer ${chen.token}` } }), BASE);
  const j2 = await r2.json();
  assert.deepEqual([r2.status, j2.error?.code], [409, 'KB_TOO_MANY'], '專案段數超過上限：不搜');
  assert.match(j2.error.message, /縮小範圍/);

  console.log('kb-test：全部通過');
} catch (e) {
  console.error('kb-test 失敗：', e);
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
