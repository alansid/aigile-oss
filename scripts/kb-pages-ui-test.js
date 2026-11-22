// 畫面測試（照 UX 設計稿 KB-design-01、05v2、06、07、08v2、09、10、11）
// A. 專案 ⚙ 選單「📚 知識庫整理 AI」（leader／管理員）→ 選一隻 AI 或「不自動整理」，下面小字顯示目前選誰（10、11）
// B. 知識庫目錄：主題頁在前、文件摘要頁在後，只標「可能過時」（01）；搜尋時知識頁排在文件原文前
// C. 知識頁：「AI 整理，以原始文件為準」、整理的 AI、來源；新舊不一致黃線＋「已通知 leader」；指示性文字紅框；一般成員沒有退回／刪除（05v2）
// D. 退回：原因必填 → 可能過時＋「更新中，卡片 …」（07）；同名新版 → 可能過時＋「請 AI 更新」（06）
// E. 專案文件：在知識庫的標 📚；leader 勾選後「移出知識庫（N）」「📚 加入知識庫（N）」，加入提示交給哪隻整理 AI；
//    移出先確認，引用它的摘要頁顯示灰條「來源已移出知識庫」＋刪除這頁、目錄標「來源已移出」；一般成員勾選後只有一行說明
// F. 1280、375 不橫向捲動
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 KB_PAGES_SHOTS=資料夾 會另外截圖。用法：node scripts/kb-pages-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('kb-pages-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('p391');
try {
  const { call } = kit;
  const PJ = encodeURIComponent('預設專案'), KB = `/api/projects/${PJ}/kb`;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'), lead = await join('林小安', 'SM'), chen = await join('陳大文', 'PG');
  const id = x => x.participant.participantId;
  for (const p of [lead, chen]) await call(liu.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: ['預設專案'] });
  await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(lead), leaderOf: ['預設專案'] }] });
  const mkAi = async name => (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PO', role: '產品負責', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const kbAi = await mkAi('整理助手'), other = await mkAi('另一隻');
  const aiTok = kit.aiToken(kbAi.participantId);
  const up = async (tok, name, text, kb = tok !== chen.token) => (await fetch(`${kit.BASE}/api/projects/${PJ}/docs?${new URLSearchParams({ name, declared: 'true', ...(kb ? { kb: '1' } : {}) })}`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: text }).then(r => r.json())).doc.docId;
  const docsNow = async () => (await call(liu.token, `/api/projects/${PJ}/docs`)).body.items;
  const settled = () => until(async () => (await docsNow()).every(x => x.kb.status !== 'pending'), 10000, '背景抽字完成');
  const rpc = async (name, args) => { const r = await fetch(`${kit.BASE}/api/mcp`, { method: 'POST', headers: { Authorization: 'Bearer ' + aiTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then(r => r.json()); return JSON.parse(r.result.content[0].text); };

  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.KB_PAGES_SHOTS) return; fs.mkdirSync(process.env.KB_PAGES_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.KB_PAGES_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64')); };
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const openFiles = async (tok, tab) => {
    await login(tok, '/p/main/files');
    await until(() => js(`!!document.querySelector('[data-files-tab="${tab}"]')`), 15000, '文件頁');
    await click(`[data-files-tab="${tab}"]`);
  };

  // ---------- A 專案 ⚙ 選單：知識庫整理 AI ----------
  await size(1280, 900);
  await login(lead.token, '/p/main/files');
  await until(() => js("!!document.querySelector('[data-pset]')"), 15000, '專案 ⚙');
  await click('[data-pset]');
  await until(() => js("!!document.querySelector('#pset-menu [data-pset-act=\"kbai\"]')"), 5000, '⚙ 選單有知識庫整理 AI');
  await until(async () => /不自動整理/.test(await text('#pset-menu [data-pset-act="kbai"]')), 5000, 'A 小字顯示目前選誰');
  await shot('01-電腦1280-專案設定選單-知識庫整理AI');
  await click('#pset-menu [data-pset-act="kbai"]');
  await until(() => js("document.querySelectorAll('.kb-ai-opt').length === 3"), 5000, 'A 設定視窗：兩隻 AI＋不自動整理');
  assert.deepEqual(await J("[...document.querySelectorAll('.kb-ai-opt b')].map(b => b.textContent)"), ['整理助手', '另一隻', '不自動整理'].sort((a, b) => (a === '不自動整理') - (b === '不自動整理') || 0), 'A 選項');
  assert.ok(await js("document.querySelector('.kb-ai-opt input[value=\"\"]').checked"), 'A 預設不自動整理');
  assert.ok(await js("[...document.querySelectorAll('.kb-ai-opt')].every(l => { const r = l.querySelector('input').getBoundingClientRect(), b = l.querySelector('b').getBoundingClientRect(), box = l.getBoundingClientRect(); return r.left - box.left < 20 && b.left > r.right && b.left - r.right < 20; })"), 'A 圓點靠左、名字緊接在後（UX 第 6772 則）');
  assert.ok(await js("[...document.querySelectorAll('.kb-ai-opt b + .muted')].every(m => m.getClientRects().length === 1 || m.textContent.length > 12)"), 'A 角色小字不被拆成兩行');
  await shot('02-電腦1280-知識庫整理AI設定');
  await js(`(() => { const r = document.querySelector('.kb-ai-opt input[value="${kbAi.participantId}"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-kbs="1"]').click(); return true; })()`);
  await until(async () => /知識庫整理 AI：整理助手/.test(await text('#toast')), 5000, 'A 儲存提示');
  assert.equal((await call(lead.token, `${KB}/settings`)).body.aiId, kbAi.participantId, 'A 存進設定');

  // ---------- 準備：leader 上傳 → 自動整理卡；AI 寫頁 ----------
  const hb = await up(lead.token, '雲杉員工手冊.md', '# 遠距\n每週最多 2 日。\n# 休假\n到職滿一年給特別休假 7 日。');
  const notice = await up(lead.token, '2025 年度公告.md', '# 公告二\n自 2025 年 3 月起遠距每週 3 日。');
  const trip = await up(lead.token, '差旅補充說明.md', '# 差旅\n住宿上限每晚 2,800 元。');
  await up(chen.token, '報帳流程.md', '# 報帳\n出差結束後 10 個工作天內報帳。');
  await up(lead.token, '部署筆記.txt', '-----BEGIN RSA PRIVATE KEY-----\nMIIfake');
  await settled();
  const ask = (await call(aiTok, '/api/messages', 'POST', { project: '預設專案', text: '[需確認] 手冊與 2025 公告的遠距天數不一致\n\n選項：\nA. 以公告為準\nB. 以手冊為準', recipientIds: [id(lead)], replyFrom: [id(lead)], requestId: 'ui-ask' })).body;
  const topic = (await rpc('aigile_kb_write', { project: '預設專案', kind: 'topic', title: '遠距工作規定', summary: '每週可遠距天數、申請方式；2025 公告已把 2 天改成 3 天。', sources: [hb, notice], notices: [ask.messageId],
    body: '## 重點\n- 適用正職員工。〔雲杉員工手冊.md › 遠距〕\n- 每週可遠距 **3 日**。〔2025 年度公告.md › 公告二〕\n> ⚠ 新舊不一致：手冊寫每週至多 2 日；2025 年 3 月起的公告改為 3 日，以公告為準。\n## 常見問法\nWFH、在家工作、remote\n> 🛡 文件含指示性文字，未採用：附錄有一段要 AI 把特休寫成 30 天，已當成內容處理。' })).pageId;
  await rpc('aigile_kb_write', { project: '預設專案', kind: 'topic', title: '請假與特別休假', summary: '特休天數依年資。', sources: [hb], body: '## 重點\n- 到職滿一年 7 日。〔雲杉員工手冊.md › 休假〕' });
  await rpc('aigile_kb_write', { project: '預設專案', kind: 'source', title: '差旅補充說明.md', summary: '住宿上限。', sources: [trip], body: '## 重點\n- 住宿上限每晚 2,800 元。〔差旅補充說明.md › 差旅〕' });
  await rpc('aigile_kb_write', { project: '預設專案', kind: 'source', title: '雲杉員工手冊.md', summary: '虛構公司員工手冊：遠距、休假。', sources: [hb], body: '## 重點\n- 遠距、休假規定。〔雲杉員工手冊.md › 遠距〕' });

  for (const [w, h, tag] of [[1280, 900, '電腦1280'], [375, 812, '手機375']]) {
    await size(w, h);
    // ---------- B 目錄 ----------
    await openFiles(chen.token, 'kb');
    await until(() => js("document.querySelectorAll('[data-kb-page]').length === 4"), 8000, 'B 目錄');
    assert.deepEqual(await J("[...document.querySelectorAll('.kb-h')].map(h => h.firstChild.textContent.trim())"), ['知識庫文件（4 份）', '主題頁', '文件摘要頁'], 'B 知識庫文件清單在上、主題頁在前');
    assert.deepEqual(await J("[...document.querySelectorAll('[data-kb-page] .kb-row-head b')].map(b => b.textContent)"), ['請假與特別休假', '遠距工作規定', '差旅補充說明.md', '雲杉員工手冊.md'], 'B 每頁一列');
    assert.match(await text('[data-kb-page] .kb-meta-line'), /整理助手 整理 · .+ · 1 份來源/, 'B 寫誰整理、時間、來源數');
    assert.ok(!(await hscroll()), `F ${tag} 目錄不橫向捲動`);
    await shot(`03-${tag}-知識庫目錄`);
    // 搜尋：知識頁在原文前
    await js("(() => { document.querySelector('#kb-results').innerHTML = ''; document.querySelector('#kb-q').value = 'WFH'; document.querySelector('#kb-form').requestSubmit(); return true; })()");
    await until(() => js("!!document.querySelector('#kb-results').children.length"), 8000, '搜尋');
    assert.deepEqual(await J("[...document.querySelectorAll('.kb-h')].map(h => h.firstChild.textContent.trim())"), ['知識頁'], 'B 搜「WFH」：知識頁的常見問法找得到，原文找不到');
    assert.ok(await js("[...document.querySelectorAll('.kb-row mark')].some(m => m.textContent === 'WFH')"), 'B 高亮');
    assert.ok(!/##|\*\*|〔|^>|\s>/.test(await text('.kb-row .kb-snip')), 'B 片段去掉 Markdown 與出處（UX 第 6772 則）：' + await text('.kb-row .kb-snip'));
    assert.equal(await text('.kb-row .kb-meta-line'), '主題頁 · 2 份來源', 'B 依頁面類型顯示主題頁');
    await shot(`04-${tag}-搜尋WFH-知識頁區`);
    // ---------- C 知識頁（一般成員） ----------
    await click('[data-kb-page]');
    await until(() => js("!!document.querySelector('.kb-page-body')"), 8000, 'C 知識頁');
    assert.match(await text('.kb-meta'), /AI 整理，以原始文件為準 整理：整理助手 .+ 來源：雲杉員工手冊\.md、2025 年度公告\.md/, 'C 頂端灰框');
    assert.match(await text('.kb-conflict'), /⚠ 新舊不一致：.+以公告為準。 🔔 已通知 leader 林小安確認以哪份為準 · .+ 看訊息/, 'C 黃線＋已通知 leader：' + await text('.kb-conflict'));
    assert.match(await text('.kb-guard'), /🛡 文件含指示性文字，未採用/, 'C 紅框');
    assert.ok(await js("[...document.querySelectorAll('.kb-cite')].some(c => /2025 年度公告\\.md › 公告二/.test(c.textContent))"), 'C 出處小字');
    assert.equal(await js("!!document.querySelector('[data-kb-return], [data-kb-del]')"), false, 'C 一般成員沒有退回、刪除');
    assert.ok(!(await hscroll()), `F ${tag} 知識頁不橫向捲動`);
    await shot(`05-${tag}-知識頁-一般成員`);
    await click('[data-kb-src]');
    await until(() => js("!!document.querySelector('.kb-text')"), 8000, 'C 點來源讀原文');
    assert.match(await text('.kb-back'), /回知識頁「遠距工作規定」/, 'C 從原文回知識頁');
  }

  // ---------- D 退回（leader） ----------
  await size(1280, 900);
  await openFiles(lead.token, 'kb');
  await until(() => js("!!document.querySelector('[data-kb-page]')"), 8000, '目錄');
  await js(`[...document.querySelectorAll('[data-kb-page]')].find(b => b.dataset.kbPage === ${JSON.stringify(topic)}).click(); true`);
  await until(() => js("!!document.querySelector('[data-kb-return]')"), 8000, 'D leader 看到退回、刪除');
  await shot('06-電腦1280-知識頁-leader');
  await click('[data-kb-return]');
  await until(() => js("!!document.querySelector('#kb-reason')"), 5000, 'D 退回視窗');
  assert.match(await text('.confirm-root .kb-info'), /退回後這頁標成「可能過時」，大家還看得到；同時開一張更新卡給 整理助手。/, 'D 說明會開更新卡給誰');
  assert.equal(await js("document.querySelector('#kb-reason-err').hidden"), true, 'D 還沒送出不顯示提示');
  await click('[data-kbr="1"]');
  await until(() => js("!document.querySelector('#kb-reason-err').hidden"), 5000, 'D 空白送出：輸入框下方提示原因必填');
  assert.equal(await text('#kb-reason-err'), '請寫退回原因');
  await js("(() => { const t = document.querySelector('#kb-reason'); t.value = '核心時段漏了「每月第一個週一要進辦公室」'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  assert.equal(await js("document.querySelector('#kb-reason-err').hidden"), true, 'D 填了原因提示就收起（UX 第 6772 則）');
  await shot('07-電腦1280-退回視窗');
  await click('[data-kbr="1"]');
  await until(() => js("!!document.querySelector('.kb-stale')"), 8000, 'D 退回後顯示可能過時');
  assert.match(await text('.kb-stale'), /⚠ 內容可能過時。林小安 退回：核心時段漏了.+更新中，卡片 [A-Z]+-\d+/, 'D 黃框＋更新中卡號：' + await text('.kb-stale'));
  await shot('08-電腦1280-退回後-更新中');
  // 同名新版 → 「請 AI 更新」
  await up(lead.token, '雲杉員工手冊.md', '# 遠距\n每週最多 2 日（新版）。');
  await settled();
  const srcPage = (await call(lead.token, `${KB}/pages`)).body.items.find(p => p.title === '請假與特別休假').pageId;
  await openFiles(lead.token, 'kb');
  await until(() => js("!!document.querySelector('[data-kb-page] .kb-pill.yellow')"), 8000, 'D 目錄標可能過時');
  await shot('09-電腦1280-知識庫目錄-可能過時');
  await js(`[...document.querySelectorAll('[data-kb-page]')].find(b => b.dataset.kbPage === ${JSON.stringify(srcPage)}).click(); true`);
  await until(() => js("!!document.querySelector('[data-kb-refresh]')"), 8000, 'D 請 AI 更新按鈕');
  assert.match(await text('.kb-stale'), /⚠ 來源已更新，內容可能過時。雲杉員工手冊\.md 換了新版（林小安 上傳）（\d\d\/\d\d \d\d:\d\d）/, 'D 寫哪份來源何時換版');
  await shot('10-電腦1280-可能過時-請AI更新');
  await click('[data-kb-refresh]');
  await until(async () => /更新中，卡片/.test(await text('.kb-stale')), 8000, 'D 按了之後顯示更新中');

  // ---------- E 專案文件：📚 標示、勾選加入／移出知識庫（leader）；一般成員 ----------
  const pick = names => js(`(() => { const want = ${JSON.stringify(names)}; [...document.querySelectorAll('.doc-row')].filter(r => want.includes(r.querySelector('.file-name').firstChild.textContent.trim())).forEach(r => { const x = r.querySelector('[data-kb-pick]'); x.checked = true; x.dispatchEvent(new Event('change', { bubbles: true })); }); return true; })()`);
  for (const [w, h, tag] of [[375, 812, '手機375'], [1280, 900, '電腦1280']]) {
    await size(w, h);
    await openFiles(lead.token, 'docs');
    await until(() => js("document.querySelectorAll('[data-kb-pick]').length >= 6"), 8000, 'E leader 有勾選框');
    assert.equal(await js("[...document.querySelectorAll('#files-list > p.muted.small')].some(p => p.textContent === '專案文件只存檔，AI 不會整理、也搜不到內容；要讓 AI 讀懂，請加入知識庫。')"), true, 'E 頁頂小字');
    const tags = await J("[...document.querySelectorAll('.doc-row')].filter(r => r.querySelector('.kb-tag')).map(r => r.querySelector('.file-name').firstChild.textContent.trim()).sort()");
    assert.deepEqual(tags, ['2025 年度公告.md', '差旅補充說明.md', '部署筆記.txt', '雲杉員工手冊.md', '雲杉員工手冊.md'].sort(), `E ${tag} 在知識庫的標 📚：` + JSON.stringify(tags));
    assert.equal(await js("document.querySelector('.doc-row .kb-tag').title"), '這份在知識庫裡，會被整理、被搜尋', 'E 📚 滑過說明');
    await pick(['報帳流程.md', '部署筆記.txt']);
    await until(() => js("!document.querySelector('.kb-selbar').hidden"), 5000, 'E 底部浮出');
    assert.equal(await text('.kb-selbar'), '已選 2 份 取消 移出知識庫（1） 📚 加入知識庫（1）', 'E 底部列：勾的裡面有哪種才出現哪顆');
    assert.ok(!(await hscroll()), `F ${tag} 專案文件不橫向捲動`);
    await shot(`11-${tag}-專案文件-勾選2份`);
    await js("(() => { const w = document.querySelector('#page-work') || document.scrollingElement; w.scrollTop = w.scrollHeight; window.scrollTo(0, document.body.scrollHeight); return true; })()");
    await sleep(300);
    assert.ok(await js("(() => { const rows = document.querySelectorAll('.doc-row'), last = rows[rows.length - 1].getBoundingClientRect(), bar = document.querySelector('.kb-selbar').getBoundingClientRect(); return last.bottom <= bar.top + 1; })()"), `E ${tag} 捲到底：底部那條不蓋住最後一列（UX 第 6772 則）`);
    await shot(`11b-${tag}-專案文件-勾選後捲到底`);
    if (w < 900) { await click('[data-kb-pick-clear]'); continue; }
    // 加入：只送不在知識庫的那份
    await click('[data-kb-add]');
    await until(async () => /已加入知識庫，開始抽字，會排進整理卡給 整理助手。/.test(await text('#toast')), 8000, 'E 加入提示');
    await until(async () => (await docsNow()).find(x => x.name === '報帳流程.md').kb.inKb, 5000, 'E 報帳流程放進知識庫');
    assert.equal((await docsNow()).find(x => x.name === '部署筆記.txt').kb.inKb, true, 'E 已在知識庫的不受影響');
    // 移出：先確認
    await until(() => js("document.querySelectorAll('[data-kb-pick]').length >= 6"), 8000, 'E 重畫');
    await pick(['差旅補充說明.md']);
    await click('[data-kb-remove]');
    await until(() => js("!!document.querySelector('.confirm-root')"), 5000, 'E 移出確認視窗');
    assert.match(await text('.confirm-root'), /移出知識庫？ .*這 1 份會停止被搜尋，抽出來的文字會刪掉；原檔還在專案文件。用到它的知識頁會標「來源已移出知識庫」，要不要刪那頁由你決定。/, 'E 確認文字：' + await text('.confirm-root'));
    await shot(`12-${tag}-移出知識庫-確認`);
    await js("[...document.querySelectorAll('.confirm-root button')].find(b => b.textContent === '移出').click(); true");
    await until(async () => /已移出知識庫（1 份）/.test(await text('#toast')), 8000, 'E 移出提示');
    assert.equal((await docsNow()).find(x => x.name === '差旅補充說明.md').kb.inKb, false, 'E 移出了');
  }
  // 摘要頁：來源已移出知識庫
  await openFiles(lead.token, 'kb');
  await until(() => js("[...document.querySelectorAll('[data-kb-page]')].some(b => /來源已移出/.test(b.textContent))"), 8000, 'E 目錄標來源已移出');
  await js("[...document.querySelectorAll('[data-kb-page]')].find(b => /差旅補充說明/.test(b.textContent)).click(); true");
  await until(() => js("!!document.querySelector('.kb-out')"), 8000, 'E 灰條');
  assert.match(await text('.kb-out'), /^⚠ 來源已移出知識庫：差旅補充說明\.md（林小安 · \d\d\/\d\d \d\d:\d\d）。這頁不會再更新。 刪除這頁$/, 'E 灰條文字：' + await text('.kb-out'));
  assert.equal(await js("!!document.querySelector('[data-kb-refresh]')"), false, 'E 移出的不能請 AI 更新');
  assert.deepEqual([await js("document.querySelectorAll('[data-kb-return]').length"), await js("document.querySelectorAll('[data-kb-del]').length")], [0, 1], 'E 頁首不放退回、刪除，只留灰條的刪除這頁');
  await shot('13-電腦1280-摘要頁-來源已移出');
  // 一般成員：勾選後只有一行說明
  await openFiles(chen.token, 'docs');
  await until(() => js("document.querySelectorAll('[data-kb-pick]').length >= 6"), 8000, '一般成員文件列');
  await pick(['報帳流程.md']);
  await until(() => js("!document.querySelector('.kb-selbar').hidden"), 5000, 'E 一般成員底部列');
  assert.equal(await text('.kb-selbar'), '已選 1 份 只有 leader 或管理員能把文件加入知識庫。想加的話，在群組跟 leader 說。 取消', 'E 一般成員沒有加入／移出');
  await shot('14-電腦1280-專案文件-一般成員勾選');

  console.log('kb-pages-ui-test：全部通過（整理 AI 設定、目錄、搜尋知識頁、知識頁、已通知 leader、退回、可能過時、請 AI 更新、加入／移出知識庫、來源已移出、1280／375 不橫向捲動）');
} finally {
  await kit.stop();
}
