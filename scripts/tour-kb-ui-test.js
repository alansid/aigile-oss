// 第 6 章「知識庫」聚光燈導覽（一般成員不顯示入口）
// A. leader 在第 6 章章首看到入口「約 1 分鐘、5 步」；一般成員看不到；第 2 章入口照樣寫 4 步
// B. 什麼都還沒設：1 框「📚 知識庫」分頁 → 2 打開 ⚙ 選單框「📚 知識庫整理 AI」→ 3 技能彈窗、沒有技能改框「＋ 新增技能」
//    → 4 空知識庫框兩顆鈕 → 5 到「要你處理」框側欄；按「完成」回說明第 6 章，選單、彈窗都收掉；設定、技能都沒被改
// C. 已指定整理 AI、套了「知識庫整理」技能還沒同步、知識庫有文件：2 改框 ⚙ 寫「整理 AI：名字」→ 3 打開技能抽屜框「裝到哪些 AI」、
//    提示請主人同步 → 上一步回 2 抽屜和彈窗收掉 → 4 框頁頂「⬆ 上傳到知識庫」；Esc 結束；同步回報已裝後第 3 步不再提示
// D. 375 寬：章首不出現導覽入口（導覽只在寬 ≥1000）、不橫向捲動
// E. 英文介面：入口、章名、各步說明都是英文
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 SHOT_DIR=資料夾 另外截圖。用法：node scripts/tour-kb-ui-test.js
import assert from 'node:assert';
import fs from 'node:fs';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';
import { SKILL_TEMPLATES, templateIn } from '../src/skill-templates.js';

if (!findBrowser()) { console.log('tour-kb-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('tourkb');
try {
  const { call } = kit;
  const PJ = encodeURIComponent('預設專案'), KB = `/api/projects/${PJ}/kb`;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'), lead = await join('林小安', 'SM'), chen = await join('陳大文', 'PG');
  const id = x => x.participant.participantId;
  for (const p of [lead, chen]) await call(liu.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: ['預設專案'] });
  await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(lead), leaderOf: ['預設專案'] }] });
  const snap = async () => JSON.stringify({ ai: (await call(lead.token, `${KB}/settings`)).body.aiId, sk: (await call(lead.token, '/api/skills')).body.items.map(s => [s.skillId, s.status, s.version]) });

  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h = 900) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shot = async name => { if (!process.env.SHOT_DIR) return; fs.mkdirSync(process.env.SHOT_DIR, { recursive: true }); await sleep(350); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${process.env.SHOT_DIR}/${name}.png`, Buffer.from(r.result.data, 'base64')); };
  const toHelp = async (t, ch) => { await login(t, `/help/${ch}`); await until(() => js(`document.querySelector('.help-ch')?.dataset.helpCh === '${ch}'`), 15000, `說明第 ${ch} 章`); };
  const entry = () => J("(() => { const e = document.querySelector('.help-head .help-tour'); return e && e.getClientRects().length ? e.innerText.replace(/\\s+/g, ' ').trim() : ''; })()");
  const pop = () => J(`(() => { const p = document.querySelector('.tour-pop'); if (!p) return null; const h = document.querySelector('.tour-hole').getBoundingClientRect();
    return { meta: p.querySelector('.tour-meta')?.textContent || '', title: p.querySelector('.tour-title')?.textContent || '', text: p.querySelector('.tour-text')?.textContent || '', tip: p.querySelector('.tour-tip')?.textContent || '',
      btns: [...p.querySelectorAll('.tour-foot .btn')].map(b => b.textContent), loading: p.classList.contains('loading'), paused: p.classList.contains('paused'),
      hole: { l: h.left, t: h.top, r: h.right, b: h.bottom }, page: decodeURIComponent(location.pathname) }; })()`);
  const covers = (h, sel) => J(`(() => { const e = ${sel}; if (!e || !e.getClientRects().length) return false; const b = e.getBoundingClientRect(); const h = ${JSON.stringify(h)};
    return b.left >= h.l - 8 && b.top >= h.t - 8 && b.right <= h.r + 8 && b.bottom <= h.b + 8; })()`);
  const stepIs = async (n, label) => { await until(async () => { const p = await pop(); return p && !p.loading && p.meta === `第 6 章　知識庫 · ${n} / 5`; }, 8000, label); await sleep(400); return pop(); };
  const tourBtn = async a => { await js(`document.querySelector('.tour-foot [data-tour="${a}"]').click(); true`); };
  const esc = async () => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
  const menuOpen = () => js("!!document.querySelector('#pset-menu') && !document.querySelector('#pset-menu').hidden");
  const leftovers = () => J("({ menu: !!document.querySelector('#pset-menu') && !document.querySelector('#pset-menu').hidden, modal: !!document.querySelector('#modal-root').firstElementChild, drawer: !!document.querySelector('.sk-drawer-wrap'), tour: !!document.querySelector('.tour-pop, .tour-hole') })");
  const STEP3 = '沒裝也會整理，但頁數少很多、也不會照規則問你。看到「已裝」才算好。';

  // ---------- A 入口 ----------
  await size(1280);
  await toHelp(lead.token, 6);
  assert.equal(await entry(), '▶ 帶我在畫面上走一次 約 1 分鐘、5 步。只框出要按的地方，不會替你按、不會動到資料；隨時按 Esc 結束。', 'A leader 看到第 6 章入口');
  await shot('A-1280-第6章入口-leader');
  assert.ok(!/最容易漏/.test(await js("document.querySelector('.help-ch').innerText")), 'A 說明第 6 章第 3 步不寫「這步最容易漏」');
  assert.match(await js("document.querySelector('.help-ch').innerText"), /替它裝「知識庫整理」技能\s+沒裝也會整理，但整理出來的頁少很多、也不會照規則問你。/, 'A 第 3 步保留後半句');
  await js(`(() => { const e = [...document.querySelectorAll('.help-ch *')].find(x => !x.children.length && x.textContent.includes("替它裝「知識庫整理」技能")); e?.scrollIntoView({ block: 'start' }); return !!e; })()`);
  await shot('A-1280-說明第6章第3步');
  await toHelp(chen.token, 6);
  assert.equal(await entry(), '', 'A 一般成員沒有第 6 章入口');
  await shot('A-1280-第6章-一般成員沒有入口');
  await toHelp(chen.token, 2);
  assert.match(await entry(), /約 1 分鐘、4 步/, 'A 第 2 章照樣 4 步');

  // ---------- B 什麼都還沒設 ----------
  const before = await snap();
  await toHelp(lead.token, 6);
  await js("document.querySelector('[data-tour-start=\"6\"]').click(); true");
  let p = await stepIs(1, 'B 第 1 步');
  assert.equal(p.title, '知識庫在「文件」的第一個分頁');
  assert.equal(p.text, '只有放進這裡的文件會被 AI 整理、被搜尋，回答會附出處。一般專案文件只存檔。');
  assert.equal(p.page, '/p/main/files', 'B 帶到文件頁');
  assert.ok(await covers(p.hole, `document.querySelector('[data-files-tab="kb"]')`), 'B 第 1 步框「📚 知識庫」分頁');
  assert.ok(await js("document.querySelector('[data-files-tab=\"kb\"]').getAttribute('aria-selected') === 'true'"), 'B 停在知識庫分頁');
  assert.deepEqual(p.btns, ['下一步']);
  await shot('B1-1280-知識庫分頁');

  await tourBtn('next');
  p = await stepIs(2, 'B 第 2 步');
  assert.equal(p.title, '先指定整理 AI');
  assert.equal(p.text, '按 ⚙，選「📚 知識庫整理 AI」，挑一隻 AI 負責把文件寫成知識頁，建議用 PO 或 BA。導覽不會替你選。');
  assert.ok(await menuOpen(), 'B 第 2 步打開 ⚙ 選單');
  assert.ok(await covers(p.hole, `document.querySelector('#pset-menu [data-pset-act="kbai"]')`), 'B 第 2 步框「📚 知識庫整理 AI」');
  await shot('B2-1280-指定整理AI-還沒指定');

  await tourBtn('next');
  p = await stepIs(3, 'B 第 3 步');
  assert.ok(!(await menuOpen()), 'B 第 3 步收起 ⚙ 選單');
  assert.equal(p.title, '這個專案還沒有「知識庫整理」技能');
  assert.equal(p.text, '按「＋ 新增技能」，套用範本「知識庫整理」。沒裝也會整理，但頁數少很多、也不會照規則問你。');
  assert.equal(p.tip, '導覽不會替你按。');
  assert.ok(!/最容易漏/.test(p.title + p.text + p.tip), 'B 第 3 步不寫「最容易漏」');
  assert.ok(await covers(p.hole, `document.querySelector('#modal-root .sk-bar [data-sknew]')`), 'B 第 3 步框「＋ 新增技能」');
  await shot('B3-1280-還沒有知識庫整理技能');

  await tourBtn('next');
  p = await stepIs(4, 'B 第 4 步');
  assert.deepEqual(await leftovers(), { menu: false, modal: false, drawer: false, tour: true }, 'B 第 4 步技能彈窗收掉');
  assert.equal(p.title, '把文件放進知識庫');
  assert.equal(p.text, '新文件按「⬆ 上傳到知識庫」；已經在專案文件的，到「專案文件」勾選後按「📚 加入知識庫」。放進來的會自動排進整理卡。');
  assert.ok(await covers(p.hole, `document.querySelector('.kb-empty-btns')`), 'B 第 4 步空知識庫框兩顆鈕');
  assert.ok(await js(`(() => { const a = document.querySelector('.kb-empty a').getBoundingClientRect(), p = document.querySelector('.tour-pop').getBoundingClientRect();
    return a.right <= p.left || a.left >= p.right || a.bottom <= p.top || a.top >= p.bottom; })()`), 'B 第 4 步說明框不蓋到「第一次用？看教學」那行');
  await shot('B4-1280-上傳到知識庫-空的');

  await tourBtn('next');
  p = await stepIs(5, 'B 第 5 步');
  assert.equal(p.title, '整理 AI 會來問你');
  assert.equal(p.text, '兩份文件規定不一樣時，整理 AI 會發 [需確認] 問你以哪份為準，出現在「要你處理」。選一個，它就照你的答案寫。');
  assert.equal(p.tip, '導覽到這裡結束。整理好的頁到 📚 知識庫看，不對就按「退回」。');
  assert.ok(await covers(p.hole, `document.querySelector('.sidebar [data-nav="inbox"]')`), 'B 第 5 步框「要你處理」');
  assert.deepEqual(p.btns, ['上一步', '完成']);
  await shot('B5-1280-要你處理');

  await tourBtn('next');
  await until(() => js(`document.querySelector('.help-ch')?.dataset.helpCh === '6'`), 8000, 'B 完成回說明第 6 章');
  assert.deepEqual(await leftovers(), { menu: false, modal: false, drawer: false, tour: false }, 'B 完成後不留遮罩、選單、彈窗');
  assert.equal(await snap(), before, 'B 導覽沒改任何設定或技能');

  // ---------- C 已指定整理 AI、技能發了還沒裝、知識庫有文件 ----------
  const kbAi = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PO', role: '產品負責', name: '整理助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  assert.equal((await call(lead.token, `${KB}/settings`, 'PUT', { aiId: kbAi.participantId })).status, 200, 'C 指定整理 AI');
  const tpl = templateIn(SKILL_TEMPLATES.find(t => t.name === 'kb-curation'), 'zh');
  const sk = await call(lead.token, `/api/projects/${PJ}/skills`, 'POST', { files: [{ path: 'SKILL.md', text: tpl.text }], aiIds: [kbAi.participantId] });
  assert.equal(sk.status, 201, 'C 套用知識庫整理範本');
  const up = await fetch(`${kit.BASE}/api/projects/${PJ}/docs?${new URLSearchParams({ name: '員工手冊.md', declared: 'true', kb: '1' })}`, { method: 'POST', headers: { Authorization: 'Bearer ' + lead.token }, body: '# 員工手冊\n年假 7 天。' });
  assert.equal(up.status, 201, 'C 上傳到知識庫');

  const before2 = await snap();
  await toHelp(lead.token, 6);
  await js("document.querySelector('[data-tour-start=\"6\"]').click(); true");
  await stepIs(1, 'C 第 1 步');
  await tourBtn('next');
  p = await stepIs(2, 'C 第 2 步');
  assert.equal(p.title, '整理 AI：整理助手');
  assert.equal(p.text, '這個專案已經指定好了。要換人，再從 ⚙ ›「📚 知識庫整理 AI」改。');
  assert.ok(!(await menuOpen()), 'C 已指定：不打開選單');
  assert.ok(await covers(p.hole, `[...document.querySelectorAll('.ph-gear[data-pset]')].find(b => b.getClientRects().length)`), 'C 第 2 步框 ⚙');
  await shot('C2-1280-已指定整理AI');

  await tourBtn('next');
  p = await stepIs(3, 'C 第 3 步');
  assert.equal(p.title, '確認它裝了「知識庫整理」技能');
  assert.equal(p.text, STEP3);
  assert.equal(p.tip, '還沒裝：請 AI 的主人到「我的 AI › 🧩 技能」按「同步」。');
  assert.ok(await js("!!document.querySelector('.sk-drawer-wrap')"), 'C 第 3 步打開技能抽屜');
  assert.ok(await covers(p.hole, `document.querySelector('.sk-drawer [data-sk-installs]')`), 'C 第 3 步框「裝到哪些 AI」');
  assert.match(await js("document.querySelector('.sk-drawer [data-sk-installs]').innerText.replace(/\\s+/g, ' ')"), /整理助手（林志明）· 還沒同步/, 'C 抽屜列出整理助手還沒同步');
  await shot('C3-1280-技能還沒同步');

  await tourBtn('prev');
  p = await stepIs(2, 'C 上一步回第 2 步');
  assert.deepEqual(await leftovers(), { menu: false, modal: false, drawer: false, tour: true }, 'C 回第 2 步：抽屜、技能彈窗收掉');
  await tourBtn('next');
  await stepIs(3, 'C 再到第 3 步');
  await tourBtn('next');
  p = await stepIs(4, 'C 第 4 步');
  assert.deepEqual(await leftovers(), { menu: false, modal: false, drawer: false, tour: true }, 'C 第 4 步抽屜、技能彈窗收掉');
  assert.ok(await covers(p.hole, `document.querySelector('#kb-form [data-kb-up]')`), 'C 第 4 步框頁頂「⬆ 上傳到知識庫」');
  await shot('C4-1280-上傳到知識庫');
  await esc();
  await until(() => js(`document.querySelector('.help-ch')?.dataset.helpCh === '6'`), 8000, 'C Esc 回說明第 6 章');
  assert.deepEqual(await leftovers(), { menu: false, modal: false, drawer: false, tour: false }, 'C Esc 後不留東西');

  // 同步回報已裝：第 3 步不再提示；在第 3 步按 Esc 也把抽屜和彈窗收掉
  await call(kit.aiToken(kbAi.participantId), '/api/me/skills/installed', 'POST', { skillIds: [sk.body.skillId] });
  await toHelp(lead.token, 6);
  await js("document.querySelector('[data-tour-start=\"6\"]').click(); true");
  await stepIs(1, 'C2 第 1 步'); await tourBtn('next');
  await stepIs(2, 'C2 第 2 步'); await tourBtn('next');
  p = await stepIs(3, 'C2 第 3 步');
  assert.equal(p.tip, '', 'C 已裝：不提示同步');
  assert.match(await js("document.querySelector('.sk-drawer [data-sk-installs]').innerText.replace(/\\s+/g, ' ')"), /整理助手（林志明）· 已裝/, 'C 抽屜顯示已裝');
  await shot('C3b-1280-技能已裝');
  await esc();
  await until(() => js(`document.querySelector('.help-ch')?.dataset.helpCh === '6'`), 8000, 'C 第 3 步 Esc 回說明第 6 章');
  assert.deepEqual(await leftovers(), { menu: false, modal: false, drawer: false, tour: false }, 'C 第 3 步 Esc 後抽屜、彈窗收掉');
  assert.equal(await snap(), before2, 'C 導覽沒改整理 AI、技能');

  // ---------- D 375 ----------
  await size(375, 812);
  await toHelp(lead.token, 6);
  assert.equal(await entry(), '', 'D 375 不出現導覽入口');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), 'D 375 不橫向捲動');
  await shot('D-375-第6章');

  // ---------- E 英文介面 ----------
  await size(1280);
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await toHelp(lead.token, 6);
  assert.equal(await entry(), "▶ Show me on screen About 1 minute, 5 steps. It only highlights where to click. It won't click for you or change any data; press Esc to stop anytime.", 'E 英文入口');
  assert.ok(!/people miss|最容易漏/.test(await js("document.querySelector('.help-ch').innerText")), 'E 英文說明第 6 章第 3 步也拿掉那句');
  assert.match(await js("document.querySelector('.help-ch').innerText"), /Install the "Knowledge base curation" skill\s+Without it the AI still organizes/, 'E 英文第 3 步保留後半句');
  await js(`(() => { const e = [...document.querySelectorAll('.help-ch *')].find(x => !x.children.length && x.textContent.startsWith('Install the') && x.textContent.includes('Knowledge base curation')); e?.scrollIntoView({ block: 'start' }); return !!e; })()`);
  await shot('E0-1280-英文-說明第6章第3步');
  await js("window.scrollTo(0, 0); document.querySelector('[data-tour-start=\"6\"]').scrollIntoView({ block: 'center' }); true");
  await js("document.querySelector('[data-tour-start=\"6\"]').click(); true");
  const stepEn = async (n, label) => { await until(async () => { const q = await pop(); return q && !q.loading && q.meta === `Chapter 6: Knowledge base · ${n} / 5`; }, 8000, label); await sleep(400); return pop(); };
  p = await stepEn(1, 'E 第 1 步');
  assert.deepEqual([p.title, p.text], ['The knowledge base is the first tab in Docs', 'Only documents placed here are organized by AI and searchable, and answers cite their sources. Regular project docs are just stored.']);
  await shot('E1-1280-英文-知識庫分頁');
  await tourBtn('next');
  p = await stepEn(2, 'E 第 2 步');
  assert.deepEqual([p.title, p.text], ['Curator AI: 整理助手', 'This project already has one. To change it, go to ⚙ › "📚 Knowledge base curator AI".']);
  await tourBtn('next');
  p = await stepEn(3, 'E 第 3 步');
  assert.deepEqual([p.title, p.text, p.tip], ['Check that it has the "Knowledge base curation" skill', "Without it the AI still organizes, but writes far fewer pages and won't ask you as the rules say. You're set once it shows \"Installed\".", '']);
  assert.match(await js("document.querySelector('.sk-drawer [data-sk-installs]').innerText.replace(/\\s+/g, ' ')"), /整理助手（林志明）· Installed v1/, 'E 抽屜的「已裝」也是英文');
  assert.equal(await js("document.querySelector('.sk-drawer .sk-dh .muted').innerText.replace(/\\s+/g, ' ')"), 'Default project · 1 selected AI · v1', 'E 抽屜標題列的專案名、發給誰也是英文');
  assert.match(await js("document.querySelector('.sk-drawer').innerText"), /From template version 2/, 'E 抽屜「來自範本第 2 版」也是英文');
  await shot('E3-1280-英文-技能已裝');
  await tourBtn('next');
  p = await stepEn(4, 'E 第 4 步');
  assert.equal(p.title, 'Put documents in the knowledge base');
  await tourBtn('next');
  p = await stepEn(5, 'E 第 5 步');
  assert.deepEqual([p.title, p.tip, p.btns], ['The curator AI will ask you', 'The tour ends here. Check finished pages in 📚 Knowledge base; if one is wrong, click "Send back".', ['Back', 'Done']]);
  await shot('E5-1280-英文-要你處理');
  await tourBtn('next');
  await until(() => js(`document.querySelector('.help-ch')?.dataset.helpCh === '6'`), 8000, 'E 完成回說明第 6 章');
  assert.deepEqual(await leftovers(), { menu: false, modal: false, drawer: false, tour: false }, 'E 完成後不留東西');

  console.log('tour-kb-ui-test：全部通過（英文介面、第 6 章導覽：leader 才有入口、5 步框位與說法、已指定／未指定、技能沒有／沒同步／已裝、收掉選單抽屜彈窗、不改資料、375 不出現）');
} finally {
  await kit.stop();
}
