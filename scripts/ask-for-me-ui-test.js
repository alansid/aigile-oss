// 畫面測試：拿掉「🔔 N 則等你回」黃色橫條，數字改放「給我的」分頁上
// A. 沒有 #ask-bar
// B.「給我的 N」：按下去只列要你回的訊息（[需確認]、要你回覆）；只是知會你的不列；0 則不顯示數字
// C. 數字跟左側「要你處理」同一套算法（這裡只有要你回的，所以兩邊數字一樣）
// D. 手機版頂部有「全部／給我的／與我相關」，不橫向捲動
// E. 英文介面：「For me」旁一樣有數字
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 ASK_SHOTS=資料夾 會另外截圖（電腦／手機）
// 用法：node scripts/ask-for-me-ui-test.js（找不到瀏覽器就略過）
import './test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('ask-for-me-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('askme');
try {
  const { call } = kit;
  const PJ = '預設專案';
  const lin = (await call(null, '/api/join', 'POST', { name: '林小安', role: 'PO' })).body;
  const LIN = lin.participant.participantId;
  const mk = async (name, roleKey) => { const a = (await call(lin.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, t: kit.aiToken(a.participantId) }; };
  const pg = await mk('小安的程式開發助手', 'PG'), po = await mk('claude-PO', 'PO');
  let n = 0;
  const post = async (t, body) => { const r = await call(t, '/api/messages', 'POST', { project: PJ, requestId: 'am_' + n++, ...body }); assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
  await post(lin.token, { text: '大家好，這週把搜尋做完。', audience: 'all' });
  const conf = await post(pg.t, { text: '[需確認] 搜尋框要不要支援模糊比對？\n\n問題1：要不要做？\nA. 要\nB. 不要', recipientIds: [LIN], replyFrom: [LIN] });
  const ask = await post(po.t, { text: '搜尋結果要不要高亮關鍵字？請林小安回一下。', recipientIds: [LIN], replyFrom: [LIN] });
  const fyi = await post(po.t, { text: '[通知] 搜尋的規格已寫進卡片，給你知道。', recipientIds: [LIN], replyFrom: [] });
  await post(pg.t, { text: '[進度] 搜尋 API 已接好。', replyFrom: [] });

  const { js, login, cdp } = await kit.browser(1280, 1000);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const open = async (w = 1280, wantN = true, lang = 'zh') => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: w < 700 ? 1100 : 1000, deviceScaleFactor: 1, mobile: w < 700 });
    await login(lin.token, '/p/main/messages');
    await js(`localStorage.setItem('aigile-lang', '${lang}'); location.reload(); true`);
    await sleep(400);
    await until(() => js("!!document.querySelector('.av-btn') && document.querySelectorAll('#messages .msg').length >= 3"), 20000, '訊息');
    if (wantN) await until(() => js("!document.querySelector('.seg-scope [data-scope=\"mine\"] .scope-n')?.hidden"), 10000, '給我的數字');
    await sleep(300);
  };
  const mineN = sel => js(`(() => { const c = document.querySelector('${sel} [data-scope="mine"] .scope-n'); return c && !c.hidden ? c.textContent : ''; })()`);

  // ---------- 電腦 1280 ----------
  await open(1280);
  assert.equal(await js("!!document.querySelector('#ask-bar, .ask-bar-btn')"), false, 'A 沒有黃色橫條');
  assert.equal(await mineN('#filter-bar > .seg-scope'), '2', 'B「給我的」上標 2（需確認＋要你回覆）');
  const side = await js("document.querySelector('.inbox-badge:not([hidden])')?.textContent || ''");
  assert.equal(side, '2', 'C 左側「要你處理」也是 2（同一套算法）');
  assert.match(await js("document.querySelector('#filter-bar > .seg-scope [data-scope=\"mine\"]').getAttribute('aria-label')"), /給我的，2 則要你回/, '報讀寫出則數');
  // B 按下去只列要你回的
  await js("document.querySelector('#filter-bar > .seg-scope [data-scope=\"mine\"]').click(); true");
  await until(() => js("document.querySelector('#filter-bar > .seg-scope [data-scope=\"mine\"]').getAttribute('aria-pressed') === 'true'"), 5000, '切到給我的');
  await sleep(300);
  const ids = await J("[...document.querySelectorAll('#messages article.msg')].map(a => a.id.replace('msg-', ''))");
  assert.deepEqual(ids.sort(), [conf.messageId, ask.messageId].sort(), '只列要你回的兩則：' + ids.join(','));
  assert.ok(!ids.includes(fyi.messageId), '只是知會你的不列');
  // 回掉一則 → 數字變 1，清單少一則
  await call(lin.token, '/api/messages', 'POST', { project: PJ, requestId: 'am_ans', text: '要高亮。', replyToMessageId: ask.messageId });
  await open(1280);
  assert.equal(await mineN('#filter-bar > .seg-scope'), '1', '回掉一則後剩 1');
  assert.equal(await js("document.querySelector('.inbox-badge:not([hidden])')?.textContent || ''"), '1', '左側也剩 1');
  if (process.env.ASK_SHOTS) {
    const dir = process.env.ASK_SHOTS; fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pc.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  }

  // ---------- 手機 375 ----------
  await open(375);
  const mob = await J(`(() => { const g = document.querySelector('.m-scope'), r = g.getBoundingClientRect(), fo = document.querySelector('#f-open').getBoundingClientRect();
    return { btns: [...g.querySelectorAll('button')].map(b => b.dataset.scope), visible: getComputedStyle(g).display !== 'none', right: Math.round(Math.max(r.right, fo.right)), hscroll: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
  assert.ok(mob.visible, 'D 手機頂部有範圍按鈕');
  assert.deepEqual(mob.btns, ['all', 'mine', 'related'], 'D 手機頂部：全部／給我的／與我相關');
  assert.equal(await mineN('.m-scope'), '1', '手機「給我的」也有數字');
  assert.ok(await js("(() => { const b = document.querySelector('.m-scope [data-scope=\"mine\"]'), n = b.querySelector('.scope-n'); return n.getBoundingClientRect().left - b.firstChild.parentElement.getBoundingClientRect().left > 0 && parseFloat(getComputedStyle(b).columnGap) >= 4; })()"), '手機「給我的」和數字中間有間隔（UX 提醒）');
  assert.ok(mob.right <= 375 && !mob.hscroll, '手機 375 放得下、不橫向捲動：' + JSON.stringify(mob));
  // 「篩選 ▾」跟三顆圓角按鈕同高、字垂直置中（UX 在平台 v0.100.28 提的，PLAT-378）
  const al = await J(`(() => { const mid = el => { const rg = document.createRange(); rg.selectNodeContents(el); const rs = [...rg.getClientRects()]; return (Math.min(...rs.map(r => r.top)) + Math.max(...rs.map(r => r.bottom))) / 2; };
    const p = document.querySelector('.m-scope button'), f = document.querySelector('#f-open'), pr = p.getBoundingClientRect(), fr = f.getBoundingClientRect();
    return { ph: pr.height, fh: fr.height, pt: pr.top, ft: fr.top, ptx: mid(p), ftx: mid(f), fc: (fr.top + fr.bottom) / 2 }; })()`);
  assert.ok(Math.abs(al.fh - al.ph) < 1 && Math.abs(al.ft - al.pt) < 1, '「篩選 ▾」跟圓角按鈕同高同排：' + JSON.stringify(al));
  assert.ok(Math.abs(al.ftx - al.fc) < 1.5 && Math.abs(al.ftx - al.ptx) < 1.5, '「篩選 ▾」字垂直置中：' + JSON.stringify(al));
  if (process.env.ASK_SHOTS) fs.writeFileSync(path.join(process.env.ASK_SHOTS, 'phone.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
  await js("document.querySelector('.m-scope [data-scope=\"mine\"]').click(); true");
  await until(() => js("document.querySelectorAll('#messages article.msg').length === 1"), 5000, '手機按給我的只剩要你回的');
  assert.equal(await js("document.querySelector('#f-open').textContent"), '篩選 ▾', '「給我的」在頂部，不算進篩選數');

  // E 英文介面
  await open(1280, true, 'en');
  await until(() => js("document.documentElement.lang === 'en'"), 8000, '英文');
  const enBtn = await J(`(() => { const b = document.querySelector('#filter-bar > .seg-scope [data-scope="mine"]'); return { text: b.innerText.replace(/\\s+/g, ' ').trim(), label: b.getAttribute('aria-label') }; })()`);
  assert.equal(enBtn.text, 'For me 1', '英文：「For me」旁有數字：' + enBtn.text);
  assert.equal(enBtn.label, 'For me, 1 to reply', '英文：報讀：' + enBtn.label);
  if (process.env.ASK_SHOTS) { await sleep(300); fs.writeFileSync(path.join(process.env.ASK_SHOTS, 'PLAT-373-5-開源英文-For-me-1.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); }

  // 0 則不顯示數字
  await call(lin.token, '/api/messages', 'POST', { project: PJ, requestId: 'am_ans2', text: 'A', replyToMessageId: conf.messageId });
  await open(1280, false);
  await sleep(1500);
  assert.equal(await js("(() => { const c = document.querySelector('#filter-bar > .seg-scope [data-scope=\"mine\"] .scope-n'); return !c || c.hidden; })()"), true, '0 則不顯示數字');
  console.log('ask-for-me-ui-test：全部通過');
} finally { await kit.stop(); }
