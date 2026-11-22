// 驗收測試：知識庫上層（AI 寫知識頁、上傳自動開整理卡、（不需核准）
// 修正前：只有文件原文索引，沒有知識頁（/api/projects/:id/kb/pages 404）、沒有整理卡、沒有「知識庫整理 AI」設定
// 修正後：leader／管理員上傳的文件抽完字自動排進整理 AI 的整理卡（併進還沒接單的卡、每張 ≤10 份）；一般成員上傳、含密鑰的不排；
//         AI 用 aigile_kb_write 寫頁直接生效、清掉排程；已整理的不重整；leader 手動「請 AI 整理」會重整；
//         文件矛盾：頁面帶 notices（給 leader 的 [需確認]）顯示已通知；退回（原因必填）→ 可能過時＋更新卡給原 AI；
//         來源刪除、同名換新版 → 可能過時；請 AI 更新 → 整理 AI 的更新卡（已有就沿用）；leader 刪頁；搜尋知識頁排在原文前
// 測試資料全部由程式產生，不連正式庫。用法：node scripts/kb-pages-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-kb-pages-'));
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
  const bank = (await req(null, '/api/join', 'POST', { name: '第二專案端', role: 'BA' })).body;
  const id = x => x.participant.participantId;
  for (const [p, ps] of [[lead, ['預設專案']], [chen, ['預設專案']], [bank, ['第二專案']]]) await req(liu.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: ps });
  await req(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(lead), leaderOf: ['預設專案'] }] });
  const mkAi = async (name, projects = ['預設專案']) => (await req(liu.token, '/api/my-ais', 'POST', { projects, roleKey: 'PO', role: '產品負責', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const kbAi = await mkAi('整理助手'), other = await mkAi('另一隻'), bankAi = await mkAi('第二專案助手', ['第二專案']);
  // leader／管理員上傳到知識庫（kb=1）；一般成員只能上傳一般專案文件
  const up = async (tok, name, text, kb = tok !== chen.token) => { const r = await req(tok, `/api/projects/${pj}/docs?name=${encodeURIComponent(name)}&declared=true${kb ? '&kb=1' : ''}`, 'POST', null, enc(text)); assert.equal(r.status, 201, name + ' 上傳'); return r.body.doc.docId; };
  const docs = async () => new Map((await req(liu.token, `/api/projects/${pj}/docs`)).body.items.map(d => [d.name, d]));
  const cards = () => db.all("SELECT * FROM cards WHERE title LIKE '整理知識庫%' OR title LIKE '更新知識頁%' ORDER BY seq");

  // ---------- 1) 設定：知識庫整理 AI（leader／管理員；只能選這個專案、不是唯讀的 AI） ----------
  let r = await req(chen.token, `${KB}/settings`);
  assert.equal(r.status, 200, '設定 API 要存在：' + JSON.stringify(r.body));
  assert.deepEqual([r.body.aiId, r.body.canManage, r.body.candidates.map(c => c.name).sort()], [null, false, ['另一隻', '整理助手']], '預設沒設；候選只有這個專案的 AI');
  assert.equal(code(await req(chen.token, `${KB}/settings`, 'PUT', { aiId: kbAi.participantId })), 'FORBIDDEN', '一般成員不能設');
  assert.equal(code(await req(lead.token, `${KB}/settings`, 'PUT', { aiId: id(chen) })), 'INVALID_REQUEST', '不能選人類');
  assert.equal(code(await req(lead.token, `${KB}/settings`, 'PUT', { aiId: bankAi.participantId })), 'INVALID_REQUEST', '不能選別專案的 AI');
  // 沒設整理 AI：leader 上傳也只抽字
  await up(lead.token, '沒設之前.md', '# 規定\n早上九點上班');
  await flush();
  assert.equal((await docs()).get('沒設之前.md').kb.org, 'none', '沒設整理 AI：不自動整理');
  r = await req(lead.token, `${KB}/settings`, 'PUT', { aiId: kbAi.participantId });
  assert.deepEqual([r.status, r.body.aiId], [200, kbAi.participantId], 'leader 設定整理 AI');

  // ---------- 2) 自動開整理卡：leader／管理員上傳才排；併進還沒接單的卡；一般成員、含密鑰的不排 ----------
  const hb = await up(lead.token, '員工手冊.md', '# 休假\n## 特別休假\n到職滿一年給 7 日。\n## 遠距\n每週最多 2 日。');
  await flush();
  let cs = await cards();
  assert.deepEqual(cs.map(c => [c.title, c.owner_id, c.status]), [['整理知識庫：1 份文件', kbAi.participantId, '待處理']], 'leader 上傳：自動開整理卡給整理 AI');
  const n1 = (await req(kbAi.token, '/api/notifications?status=pending&limit=50')).body.items;
  assert.ok(n1.some(n => n.ask && /\[交接\] .+ 請整理知識庫文件：員工手冊\.md/.test(n.preview || '')), '整理 AI 收到要回覆的 [交接]（叫醒）：' + JSON.stringify(n1.map(n => n.preview)));
  const notice2 = await up(liu.token, '2025 公告.md', '# 公告二\n自 2025 年 3 月起遠距每週 3 日。');
  await up(chen.token, '一般成員.md', '# 筆記\n住宿上限 2,500 元。');
  await up(lead.token, '含密鑰.txt', '-----BEGIN RSA PRIVATE KEY-----\nMIIfake');
  const pdf = await req(lead.token, `/api/projects/${pj}/docs?name=${encodeURIComponent('組織圖.pdf')}&declared=true&kb=1`, 'POST', null, enc('%PDF-1.4\n%%EOF\n'));
  await flush();
  cs = await cards();
  assert.deepEqual(cs.map(c => c.title), ['整理知識庫：3 份文件'], '管理員上傳、PDF 都併進同一張還沒接單的卡（不會一份一張）');
  let ds = await docs();
  assert.deepEqual(['員工手冊.md', '2025 公告.md', '組織圖.pdf', '一般成員.md', '含密鑰.txt', '沒設之前.md'].map(n => ds.get(n).kb.org), ['todo', 'todo', 'todo', 'none', 'none', 'none'], '一般成員上傳、含密鑰、設定前的：不排');
  const card1 = ds.get('員工手冊.md').kb.cardId;
  assert.ok(/^[A-Z]+-\d+$/.test(card1) && ds.get('組織圖.pdf').kb.cardId === card1, '文件清單標整理卡卡號');
  const n2 = (await req(kbAi.token, '/api/notifications?status=pending&limit=50')).body.items.filter(n => /請整理知識庫文件/.test(n.preview || ''));
  assert.equal(n2.length, 1, '併進同一張卡不再叫醒第二次');
  // 已接單的卡不再加：AI [接單] 後，下一份另開一張
  await req(kbAi.token, '/api/messages', 'POST', { project: '預設專案', text: `[接單] ${card1} 開始整理`, cardId: card1, requestId: 'claim1' });
  await up(lead.token, '差旅.md', '# 差旅\n住宿上限每晚 2,800 元。');
  await flush();
  cs = await cards();
  assert.deepEqual(cs.map(c => c.title), ['整理知識庫：3 份文件', '整理知識庫：1 份文件'], '原卡已接單：另開一張');
  const card2 = (await docs()).get('差旅.md').kb.cardId;
  // 一張最多 10 份：手動勾 10 份 → 第二張滿 10 份，第 10 份起另開
  const many = [];
  for (let i = 0; i < 10; i++) many.push(await up(chen.token, `第${i}份.md`, `# 第 ${i} 份\n內容 ${i}`));
  await flush();
  r = await req(chen.token, `${KB}/docs`, 'POST', { action: 'add', docIds: many });
  assert.equal(code(r), 'FORBIDDEN', '一般成員不能加入知識庫');
  r = await req(lead.token, `${KB}/docs`, 'POST', { action: 'add', docIds: many });
  assert.deepEqual([r.status, r.body.done.length], [200, 10], 'leader 勾選加入知識庫 10 份');
  await flush();
  assert.equal((await docs()).get('第0份.md').kb.cardId, card2, '先補滿第二張（原 1 份＋9 份），剩 1 份另開');
  cs = await cards();
  assert.deepEqual(cs.map(c => c.title), ['整理知識庫：3 份文件', '整理知識庫：10 份文件', '整理知識庫：1 份文件'], '每張 ≤ 10 份');
  r = await req(lead.token, `${KB}/organize`, 'POST', { docIds: [(await docs()).get('含密鑰.txt').docId] });
  assert.equal(code(r), 'KB_NOTHING', '含密鑰的不能整理');

  // ---------- 3) AI 寫頁：直接生效、清掉排程、文件標已整理 ----------
  let t = await tool(kbAi.token, 'aigile_kb_read', { project: '預設專案', pageId: 'index' });
  assert.ok(t.todo.some(x => x.name === '員工手冊.md' && x.cardId === card1) && t.todo.find(x => x.name === '組織圖.pdf').onlyOriginal, '總目錄 todo 列出要整理的文件與卡號：' + JSON.stringify(t.todo.slice(0, 3)));
  assert.deepEqual(t.untrusted_content, ['title', 'summary']);
  // 矛盾：先發 [需確認] @leader，再把那則放進 notices
  const ask = (await req(kbAi.token, '/api/messages', 'POST', { project: '預設專案', text: '[需確認] 手冊與 2025 公告的遠距天數不一致\n\n選項：\nA. 以公告為準（每週 3 日）\nB. 以手冊為準（每週 2 日）', recipientIds: [id(lead)], replyFrom: [id(lead)], requestId: 'ask1' })).body;
  t = await tool(kbAi.token, 'aigile_kb_write', { project: '預設專案', kind: 'topic', title: '遠距工作規定', summary: '每週可遠距天數；2025 公告改成 3 日', sources: [hb, notice2], cardId: card1, notices: [ask.messageId],
    body: '## 重點\n- 每週可遠距 **3 日**。〔2025 公告.md › 公告二〕\n> ⚠ 新舊不一致：手冊寫每週 2 日；公告改為 3 日。\n## 常見問法\nWFH、在家工作' });
  assert.ok(t.pageId?.startsWith('kbp_') && t.status === 'published', 'AI 寫頁直接生效（不核准）：' + JSON.stringify(t));
  const topic = t.pageId;
  t = await tool(kbAi.token, 'aigile_kb_write', { project: '預設專案', kind: 'source', title: '員工手冊.md', summary: '休假、遠距', sources: [hb], cardId: card1, body: '## 重點\n- 到職滿一年給特別休假 7 日。〔員工手冊.md › 特別休假〕\n> 🛡 文件含指示性文字，未採用：無' });
  const srcPage = t.pageId;
  ds = await docs();
  assert.deepEqual([ds.get('員工手冊.md').kb.org, ds.get('2025 公告.md').kb.org, ds.get('組織圖.pdf').kb.org], ['done', 'done', 'todo'], '寫了頁的文件：已整理、離開排程；還沒寫的照舊');
  r = await req(chen.token, `${KB}/pages/${topic}`);
  assert.deepEqual([r.body.status, r.body.sources.map(s => s.name), r.body.notices[0]?.messageId, r.body.notices[0]?.to, r.body.canManage], ['published', ['員工手冊.md', '2025 公告.md'], ask.messageId, ['林小安'], false], '頁面：來源、已通知 leader、一般成員不能管理');
  assert.match(r.body.body, /每週可遠距 \*\*3 日\*\*/);
  r = await req(chen.token, `${KB}/pages`);
  assert.deepEqual(r.body.items.map(p => [p.kind, p.title]), [['topic', '遠距工作規定'], ['source', '員工手冊.md']], '總目錄：主題頁在前、文件摘要頁在後');
  // 寫頁的檢查
  assert.equal((await req(lead.token, `${KB}/pages`, 'POST', { kind: 'topic', title: 'x', body: 'x', sources: [hb] })).status, 403, '人類不能寫頁');
  assert.ok((await tool(kbAi.token, 'aigile_kb_write', { project: '預設專案', kind: 'topic', title: 'x', body: 'x', sources: ['doc_nope'] })).isError, '來源要是這個專案的文件');
  assert.match((await tool(kbAi.token, 'aigile_kb_write', { project: '預設專案', kind: 'topic', title: 'x', body: `Token：${other.token}`, sources: [hb] })).text, /SECRET_IN_TEXT/, '頁面含成員 Token：不能存');
  const bankMsg = (await req(bankAi.token, '/api/messages', 'POST', { project: '第二專案', text: '[通知] 第二專案的事', requestId: 'b1' })).body;
  assert.match((await tool(kbAi.token, 'aigile_kb_write', { project: '預設專案', kind: 'topic', title: 'x', body: 'x', sources: [hb], notices: [bankMsg.messageId] })).text, /notices/, 'notices 要是這個專案的訊息');
  assert.equal((await req(bank.token, `${KB}/pages/${topic}`)).status, 404, '別專案的人讀不到知識頁');
  assert.equal((await tool(bankAi.token, 'aigile_kb_read', { project: '預設專案', pageId: 'index' })).isError, true, '別專案的 AI 讀不到總目錄');

  // ---------- 4) 已整理的不重整；leader 手動勾選會重整 ----------
  await req(liu.token, `${KB}/reindex`, 'POST', { docId: hb });
  await flush();
  assert.equal((await docs()).get('員工手冊.md').kb.org, 'done', '重建索引不會把已整理的放回整理卡');
  r = await req(lead.token, `${KB}/organize`, 'POST', { docIds: [hb] });
  assert.equal(r.status, 200, 'leader 勾選已整理的：重整');
  assert.equal((await docs()).get('員工手冊.md').kb.org, 'todo');
  await tool(kbAi.token, 'aigile_kb_write', { project: '預設專案', pageId: srcPage, sources: [hb] });

  // ---------- 5) 搜尋：知識頁排在原文前；scope ----------
  await db.run("DELETE FROM app_settings WHERE key LIKE 'sq:%'");
  r = await req(chen.token, `${KB}/search?q=${encodeURIComponent('遠距')}`);
  assert.deepEqual([r.body.pages[0]?.title, r.body.pages[0]?.pageKind, r.body.items.length > 0], ['遠距工作規定', 'topic', true], '知識頁與原文兩區：' + JSON.stringify(r.body.pages));
  await db.run("DELETE FROM app_settings WHERE key LIKE 'sq:%'");
  t = await tool(kbAi.token, 'aigile_kb_search', { project: '預設專案', q: 'WFH', scope: 'pages' });
  assert.deepEqual([t.pages.map(p => p.title), t.items.length], [['遠距工作規定'], 0], 'scope=pages：知識頁的常見問法搜得到「WFH」，原文搜不到');

  // ---------- 6) 退回：原因必填 → 可能過時＋更新卡給原 AI；已有更新卡就沿用；AI 改寫後恢復 ----------
  assert.equal(code(await req(chen.token, `${KB}/pages/${topic}/return`, 'POST', { reason: '漏了' })), 'FORBIDDEN', '一般成員不能退回');
  assert.equal(code(await req(lead.token, `${KB}/pages/${topic}/return`, 'POST', { reason: ' ' })), 'INVALID_REQUEST', '原因必填');
  r = await req(lead.token, `${KB}/pages/${topic}/return`, 'POST', { reason: '核心時段漏了' });
  assert.deepEqual([r.status, r.body.status, r.body.ai?.name], [200, 'stale', '整理助手'], '退回：標可能過時、開更新卡給原本寫的 AI');
  const upd = r.body.cardId;
  r = await req(chen.token, `${KB}/pages/${topic}`);
  assert.deepEqual([r.body.status, r.body.staleNote, r.body.updateCard], ['stale', '林小安 退回：核心時段漏了', upd], '頁面寫為什麼過時、更新中的卡');
  assert.ok((await docs()).get('員工手冊.md').kb.cardId === upd, '來源文件排進更新卡');
  await up(lead.token, '退回後上傳.md', '# x\n內容'); // 更新卡還沒接單：新上傳的不能併進「更新知識頁」卡
  await flush();
  assert.ok((await docs()).get('退回後上傳.md').kb.cardId !== upd, '新文件不併進更新卡，另開整理卡');
  assert.ok((await cards()).some(c => c.title === '更新知識頁「遠距工作規定」'), '更新卡標題不被改成整理卡');
  r = await req(liu.token, `${KB}/pages/${topic}/return`, 'POST', { reason: '再退一次' });
  assert.deepEqual([r.body.cardId, r.body.reused], [upd, true], '已有更新卡在做：沿用，不重開');
  t = await tool(kbAi.token, 'aigile_kb_write', { project: '預設專案', pageId: topic, body: '## 重點\n- 每週可遠距 3 日、核心時段 10:00–16:00。〔員工手冊.md › 遠距〕' });
  r = await req(chen.token, `${KB}/pages/${topic}`);
  assert.deepEqual([r.body.status, r.body.staleNote, r.body.updateCard, r.body.notices.length], ['published', undefined, undefined, 1], 'AI 改寫後恢復已發布（notices 沒帶就保留）');

  // ---------- 7) 來源刪除、同名換新版 → 可能過時；請 AI 更新給整理 AI ----------
  await up(lead.token, '2025 公告.md', '# 公告二\n自 2025 年 3 月起遠距每週 4 日。'); // 同名新版
  await flush();
  r = await req(chen.token, `${KB}/pages/${topic}`);
  assert.deepEqual([r.body.status, /^2025 公告\.md 換了新版（林小安 上傳）$/.test(r.body.staleNote)], ['stale', true], '同名新文件取代舊的：可能過時：' + r.body.staleNote);
  assert.equal((await docs()).get('員工手冊.md').kb.org, 'stale', '文件清單標可能過時');
  assert.equal(code(await req(lead.token, `${KB}/pages/${srcPage}/refresh`, 'POST', {})), 'KB_NOT_STALE', '沒過時的不用更新');
  await req(lead.token, `${KB}/settings`, 'PUT', { aiId: other.participantId });
  r = await req(lead.token, `${KB}/pages/${topic}/refresh`, 'POST', {});
  assert.deepEqual([r.status, r.body.ai?.name], [200, '另一隻'], '請 AI 更新：交給目前的整理 AI');
  await req(lead.token, `/api/projects/${pj}/docs/${hb}`, 'DELETE');
  r = await req(chen.token, `${KB}/pages/${srcPage}`);
  assert.deepEqual([r.body.status, /^來源文件「員工手冊\.md」被 林小安 刪除$/.test(r.body.staleNote), r.body.sources[0].exists], ['stale', true, false], '來源刪除：可能過時、來源標已刪');

  // ---------- 8) 刪頁（leader／管理員）；設成不自動整理 ----------
  assert.equal(code(await req(chen.token, `${KB}/pages/${srcPage}`, 'DELETE')), 'FORBIDDEN', '一般成員不能刪頁');
  assert.equal((await req(liu.token, `${KB}/pages/${srcPage}`, 'DELETE')).status, 200, '管理員刪頁');
  assert.equal((await req(chen.token, `${KB}/pages/${srcPage}`)).status, 404, '刪掉的讀不到');
  assert.ok(!(await req(chen.token, `${KB}/pages`)).body.items.some(p => p.pageId === srcPage), '總目錄不列');
  await req(lead.token, `${KB}/settings`, 'PUT', { aiId: null });
  const nb = (await cards()).length;
  await up(lead.token, '設定關掉後.md', '# x\n內容');
  await flush();
  assert.equal((await cards()).length, nb, '「不自動整理」：leader 上傳也不開卡');
  assert.equal(code(await req(lead.token, `${KB}/organize`, 'POST', { docIds: [(await docs()).get('設定關掉後.md').docId] })), 'KB_NO_AI', '沒有整理 AI 又沒選：請先設定');
  r = await req(lead.token, `${KB}/organize`, 'POST', { docIds: [(await docs()).get('設定關掉後.md').docId], aiId: kbAi.participantId });
  assert.deepEqual([r.status, r.body.ai.name], [200, '整理助手'], '手動整理可以指定一隻 AI');

  console.log('kb-pages-test：全部通過');
} catch (e) {
  console.error('kb-pages-test 失敗：', e);
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
