// 知識庫英文介面（真的瀏覽器）：切成英文後，知識庫每個畫面都沒有殘留中文（人名、專案名、文件內容這些資料除外）
// 畫面：專案 ⚙ 選單、整理 AI 設定（含沒裝技能的黃字）、空的知識庫（教學連結）、目錄、搜尋結果、知識頁（黃線、已通知 leader、紅框）、
//       讀一段原文、退回視窗、可能過時、知識庫文件清單與狀態字、專案文件（📚 標示、⋯ 選單、勾選列、移出確認、加入提示）、
//       一般成員的說明、來源移出知識庫的摘要頁、說明第 6 章；寬度 1280、375 各跑一次
// 設 KB_EN_SHOTS=資料夾 會另外截圖。本機暫存資料庫＋無頭 Chrome／Edge。用法：node scripts/kb-en-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('kb-en-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('kben');
try {
  const { call } = kit;
  const PJ = encodeURIComponent('預設專案'), KB = `/api/projects/${PJ}/kb`;
  const join = async (name, role) => { const r = await call(null, '/api/join', 'POST', { name, role }); assert.ok(r.body?.participant, `加入 ${name}：` + JSON.stringify(r.body).slice(0, 200)); return r.body; };
  const boss = await join('AlexLin', 'PO'), lead = await join('SamLee', 'SM'), chen = await join('DanaChen', 'PG');
  const id = x => x.participant.participantId;
  for (const p of [lead, chen]) await call(boss.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: ['預設專案'] });
  await call(boss.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(lead), leaderOf: ['預設專案'] }] });
  const mkAi = async name => (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PO', role: 'PO', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const kbAi = await mkAi('Curator'), other = await mkAi('Helper');
  const aiTok = kit.aiToken(kbAi.participantId);
  // leader 上傳帶 kb=1（放進知識庫）；一般成員上傳成一般專案文件
  const up = async (tok, name, text, kb = tok !== chen.token) => (await fetch(`${kit.BASE}/api/projects/${PJ}/docs?${new URLSearchParams({ name, declared: 'true', ...(kb ? { kb: '1' } : {}) })}`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: text }).then(r => r.json())).doc.docId;
  const rpc = async (name, args) => { const r = await fetch(`${kit.BASE}/api/mcp`, { method: 'POST', headers: { Authorization: 'Bearer ' + aiTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then(x => x.json()); return JSON.parse(r.result.content[0].text); };
  const DATA = ['預設專案', '第二專案', 'AlexLin', 'SamLee', 'DanaChen', 'Curator', 'Helper', '[需確認]', '選項：'];

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shot = async name => { if (!process.env.KB_EN_SHOTS) return; fs.mkdirSync(process.env.KB_EN_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.KB_EN_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64')); };
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const leftover = () => js(`(() => {
    const SKIP = '.msg-text,.msg-rest,.dm-text,.dmsg-text,.cr-title,.sw-text,.kb-text,.kb-snip,.kb-page-body h2,.kb-page-body li,.kb-page-body p,.kb-conflict > :not(.kb-notice),code,pre,textarea,script,style,[data-nt]';
    const DATA = ${JSON.stringify(DATA)};
    const out = new Set();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.replace(/\\s+/g, ' ').trim(), el = n.parentElement;
      if (!t || [...t].length === 1 || !/[\\u3400-\\u9fff]/.test(t) || !el || el.closest(SKIP) || !el.offsetParent) continue;
      let rest = t; for (const d of DATA) rest = rest.split(d).join('');
      if (/[\\u3400-\\u9fff]/.test(rest)) out.add(t);
    }
    for (const el of document.querySelectorAll('input[placeholder], [aria-label], [title]')) if (el.offsetParent) for (const a of ['placeholder', 'aria-label', 'title']) { let v = el.getAttribute(a) || ''; for (const d of DATA) v = v.split(d).join(''); if (/[\\u3400-\\u9fff]/.test(v)) out.add(a + '：' + el.getAttribute(a)); }
    return JSON.stringify([...out].slice(0, 30));
  })()`).then(JSON.parse);
  const check = async label => { await sleep(400); const l = await leftover(); assert.deepEqual(l, [], `${label} 還有中文：${l.join(' ｜ ')}`); };
  const english = async (tok, url) => {
    await login(tok, '/');
    await js("localStorage.setItem('aigile-lang', 'en'); true");
    await login(tok, url);
    await until(() => js("document.documentElement.lang === 'en' && !document.documentElement.classList.contains('i18n-wait')"), 15000, '英文介面');
  };
  const openFiles = async (tok, tab) => {
    await english(tok, '/p/main/files');
    await until(() => js(`!!document.querySelector('[data-files-tab="${tab}"]')`), 15000, '文件頁');
    await click(`[data-files-tab="${tab}"]`);
  };

  for (const [w, h, tag] of [[1280, 900, '1280'], [375, 812, '375']]) {
    await size(w, h);
    const fresh = tag === '1280';
    // 空的知識庫＋教學連結（第一次跑時還沒有文件）
    if (fresh) {
      await openFiles(lead.token, 'kb');
      await until(() => js("!!document.querySelector('.kb-empty')"), 8000, '空的知識庫');
      assert.equal(await js("document.querySelector('.kb-empty a[href=\"/help/6\"]')?.textContent"), 'New here? Read the guide: setting up the knowledge base ›');
      await check('空的知識庫');
      await shot(`en-${tag}-01-empty`);
      // 專案 ⚙ 選單、整理 AI 設定（沒裝技能的黃字）
      await click('[data-pset]');
      await until(() => js("!!document.querySelector('#pset-menu [data-pset-act=\"kbai\"]')"), 5000, '⚙ 選單');
      await check('專案 ⚙ 選單');
      await click('#pset-menu [data-pset-act="kbai"]');
      await until(() => js("document.querySelectorAll('.kb-ai-opt').length === 3"), 5000, '整理 AI 設定');
      await js(`(() => { const r = document.querySelector('.kb-ai-opt input[value="${kbAi.participantId}"]'); r.click(); return true; })()`);
      assert.match(await js("document.querySelector('.kb-skill-warn').textContent"), /doesn't have the "Knowledge base curation" skill yet/, '黃字是英文');
      await check('整理 AI 設定');
      await shot(`en-${tag}-02-curator-setting`);
      await click('[data-kbs="1"]');
      await until(async () => (await call(lead.token, `${KB}/settings`)).body.aiId === kbAi.participantId, 5000, '存整理 AI');
      // 準備資料：leader 上傳到知識庫（自動整理卡）、成員上傳一般專案文件、含密鑰、PDF；整理 AI 寫頁、問 leader
      const hb = await up(lead.token, 'Employee handbook.md', '# Remote work\nUp to 2 days a week.\n# Leave\nAfter one year you get 7 days of paid leave.');
      const notice = await up(lead.token, '2025 notice.md', '# Notice\nFrom March 2025, remote work is up to 3 days a week.');
      await up(chen.token, 'Travel notes.md', '# Travel\nHotel cap is 2,800 per night.');
      await up(lead.token, 'Deploy notes.txt', '-----BEGIN RSA PRIVATE KEY-----\nMIIfake');
      await up(lead.token, 'Org chart.pdf', '%PDF-1.4\n%%EOF\n');
      await until(async () => (await call(lead.token, `/api/projects/${PJ}/docs`)).body.items.every(x => x.kb.status !== 'pending'), 10000, '抽字完成');
      const ask = (await call(aiTok, '/api/messages', 'POST', { project: '預設專案', text: '[需確認] Handbook and 2025 notice disagree on remote days\n\n選項：\nA. Follow the notice\nB. Follow the handbook', recipientIds: [id(lead)], replyFrom: [id(lead)], requestId: 'kben-ask' })).body;
      await rpc('aigile_kb_write', { project: '預設專案', kind: 'topic', title: 'Remote work', summary: 'Days per week; the 2025 notice changed 2 to 3.', sources: [hb, notice], notices: [ask.messageId],
        body: '## Key points\n- Up to **3 days** a week. [2025 notice.md > Notice]\n> ⚠ Conflict: the handbook says 2 days; the 2025 notice says 3.\n> 🛡 Document contains instructions, not followed: none\n## Common ways to ask\n- WFH, work from home' });
      await rpc('aigile_kb_write', { project: '預設專案', kind: 'source', title: 'Employee handbook.md', summary: 'Remote work and leave.', sources: [hb], body: '## Key points\n- 7 days of paid leave after one year. [Employee handbook.md > Leave]' });
      await up(lead.token, 'Employee handbook.md', '# Remote work\nUp to 3 days a week.'); // 同名新版：知識頁標可能過時
      await until(async () => (await call(lead.token, `/api/projects/${PJ}/docs`)).body.items.every(x => x.kb.status !== 'pending'), 10000, '新版抽字完成');
    }
    // 目錄（上面是知識庫文件清單與狀態字）
    await openFiles(lead.token, 'kb');
    await until(() => js("document.querySelectorAll('[data-kb-page]').length === 2 && document.querySelectorAll('.kb-doc-row').length >= 4"), 8000, '目錄');
    assert.ok(await js("!!document.querySelector('.kb-search [data-kb-up]')"), 'leader 有「上傳到知識庫」');
    await check(`${tag} 目錄`);
    await shot(`en-${tag}-03-index`);
    // 搜尋：知識頁＋原文
    await js("(() => { document.querySelector('#kb-results').innerHTML = ''; document.querySelector('#kb-q').value = 'remote'; document.querySelector('#kb-form').requestSubmit(); return true; })()");
    await until(() => js("document.querySelectorAll('#kb-results .kb-h').length === 2"), 8000, '搜尋結果兩區');
    await check(`${tag} 搜尋結果`);
    await shot(`en-${tag}-04-search`);
    // 沒找到
    await js("(() => { document.querySelector('#kb-results').innerHTML = ''; document.querySelector('#kb-q').value = 'zzzz'; document.querySelector('#kb-form').requestSubmit(); return true; })()");
    await until(() => js("!!document.querySelector('#kb-results').children.length"), 8000, '沒找到');
    await check(`${tag} 沒找到`);
    // 知識頁（leader：退回、刪除、可能過時、請 AI 更新）
    await openFiles(lead.token, 'kb');
    await until(() => js("document.querySelectorAll('[data-kb-page]').length === 2"), 8000, '目錄');
    await click('[data-kb-page]');
    await until(() => js("!!document.querySelector('.kb-page-body')"), 8000, '知識頁');
    await check(`${tag} 知識頁`);
    await shot(`en-${tag}-05-page`);
    // 退回視窗
    await click('[data-kb-return]');
    await until(() => js("!!document.querySelector('#kb-reason')"), 5000, '退回視窗');
    await click('[data-kbr="1"], .confirm-root .btn.primary');
    await check(`${tag} 退回視窗（含必填提示）`);
    await shot(`en-${tag}-06-send-back`);
    await js("document.querySelector('.confirm-root [data-close], .confirm-root .btn:not(.primary)')?.click(); true");
    // 讀一段原文
    await click('[data-kb-src]');
    await until(() => js("!!document.querySelector('.kb-text')"), 8000, '讀原文');
    await check(`${tag} 讀原文`);
    await shot(`en-${tag}-07-read`);
    // 專案文件：📚 標示、⋯ 選單、勾選列（加入＋移出）、移出確認、加入提示
    await openFiles(lead.token, 'docs');
    await until(() => js("document.querySelectorAll('.doc-row .kb-tag').length >= 4"), 8000, '專案文件');
    await check(`${tag} 專案文件`);
    await click('[data-doc-more]');
    await check(`${tag} ⋯ 選單`);
    await js("document.body.click(); true");
    await js("(() => { const rows = [...document.querySelectorAll('.doc-row')].filter(r => r.querySelector('[data-kb-pick]')); [rows.find(r => r.querySelector('.kb-tag')), rows.find(r => !r.querySelector('.kb-tag'))].filter(Boolean).forEach(r => r.querySelector('[data-kb-pick]').click()); return true; })()");
    await until(() => js("!document.querySelector('.kb-selbar').hidden"), 5000, '勾選列');
    if (fresh) assert.ok(await js("!!document.querySelector('[data-kb-add]') && !!document.querySelector('[data-kb-remove]')"), '勾選列有加入、移出');
    await check(`${tag} 勾選列`);
    await shot(`en-${tag}-08-docs-selected`);
    await click('[data-kb-remove]');
    await until(() => js("!!document.querySelector('.confirm-root')"), 5000, '移出確認');
    await check(`${tag} 移出確認`);
    await shot(`en-${tag}-09-remove-confirm`);
    await js("[...document.querySelectorAll('.confirm-root button')].find(b => b.textContent.trim() === 'Cancel')?.click(); true");
    await until(() => js("!document.querySelector('.confirm-root')"), 5000, '關掉移出確認');
    if (fresh) {
      await click('[data-kb-add]');
      await until(() => js("/Added to the knowledge base/.test(document.querySelector('#toast')?.textContent || '')"), 8000, '加入提示');
      await check(`${tag} 加入提示`);
      // 一般成員：知識庫分頁一行說明、勾選列一行說明
      await openFiles(chen.token, 'kb');
      await until(() => js("!!document.querySelector('.kb-doc-row')"), 8000, '一般成員知識庫');
      assert.ok(await js("!document.querySelector('[data-kb-up]')"), '一般成員沒有上傳到知識庫');
      await check(`${tag} 一般成員知識庫`);
      await openFiles(chen.token, 'docs');
      await until(() => js("document.querySelectorAll('[data-kb-pick]').length >= 4"), 8000, '一般成員專案文件');
      await click('[data-kb-pick]');
      await until(() => js("!!document.querySelector('.kb-selbar-note')"), 5000, '一般成員勾選列');
      await check(`${tag} 一般成員勾選列`);
    }
    // 說明第 6 章
    await english(lead.token, '/help/6');
    await until(() => js("!!document.querySelector('[data-help-try=\"kb\"]')"), 10000, '第 6 章');
    await check(`${tag} 說明第 6 章`);
    await shot(`en-${tag}-10-help6`);
    assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), `${tag} 不橫向捲動`);
  }
  // 來源移出知識庫：摘要頁灰條＋刪除這頁、目錄標「來源已移出」；主題頁另一份來源還在，照一般可能過時顯示
  await size(1280, 900);
  const hbId = (await call(lead.token, `/api/projects/${PJ}/docs`)).body.items.find(x => x.name === 'Employee handbook.md').docId;
  assert.equal((await call(lead.token, `${KB}/docs`, 'POST', { action: 'remove', docIds: [hbId] })).status, 200, '移出手冊');
  await openFiles(lead.token, 'kb');
  await until(() => js("[...document.querySelectorAll('[data-kb-page]')].some(b => /Source removed/.test(b.textContent))"), 8000, '目錄標來源已移出');
  await check('來源已移出 目錄');
  await js("[...document.querySelectorAll('[data-kb-page]')].find(b => b.querySelector('.kb-row-head b').textContent === 'Employee handbook.md').click(); true"); // 只有這頁的來源全都移出
  await until(() => js("!!document.querySelector('.kb-out')"), 8000, '灰條');
  assert.match(await js("document.querySelector('.kb-out').textContent"), /^⚠ Source removed from knowledge base: Employee handbook\.md \(SamLee · .+\)\. This page won't be updated\.Delete this page$/, '灰條是英文：' + await js("document.querySelector('.kb-out').textContent"));
  await check('來源已移出 摘要頁');
  await shot('en-1280-11-source-removed');
  await click('[data-kb-back]');
  await until(() => js("document.querySelectorAll('[data-kb-page]').length === 2"), 8000, '回目錄');
  await click('[data-kb-page]');
  await until(() => js("!!document.querySelector('.kb-stale')"), 8000, '主題頁可能過時');
  await check('來源已移出 主題頁');
  console.log('kb-en-ui-test：全部通過（英文介面：知識庫每個畫面沒有殘留中文，1280／375）');
} catch (e) {
  console.error('kb-en-ui-test 失敗：', e);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
