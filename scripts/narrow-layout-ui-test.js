// 畫面測試（真的瀏覽器）：手機與窄畫面排版、頁面用詞
// 1. 版本紀錄頁標題一行不直排、沒有「‹ 返回」；頂端麵包屑每段一行
// 2. 手機頂欄只放頁名，專案名放副標
// 3. 看板「還有 N 欄」放在看板上方工具列，不蓋到卡片；欄名「待確認」改叫「待驗收／決定」
// 4. 團隊成員表：桌機有欄名列、「未讀 N 則」；手機沒有欄名列，格子裡寫「目前工作」，名字一行、角色下一行
// 5. 頻道 0 則：不放「↑ 載入更早」大按鈕和「0 則」分隔線
// 6. 「要你處理」頁（原收件匣）標題與副標；卡片抽屜點灰底不關，按 × 才關
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。用法：node scripts/narrow-layout-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('narrow-layout-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('narrow');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const mk = async (name, role = '程式開發') => (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const ais = [await mk('程式助手'), await mk('測試助手'), await mk('設計助手', '使用體驗')];
  for (let i = 0; i < 12; i++) await kit.call(boss.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'm' + i, text: `[需確認] 第 ${i} 則`, recipientIds: [ais[0].participantId] });
  for (const [i, st] of ['待處理', '進行中', '待確認', '受阻', '待處理', '進行中'].entries()) await kit.call(boss.token, '/api/cards', 'POST', { requestId: 'c' + i, project: '預設專案', title: `第 ${i + 1} 張卡：手機排版要看得到標題`, status: st });

  const { js, login, cdp } = await kit.browser(1280, 900);
  await login(boss.token, '/');
  const open = async (w, url, ready, view = 'A') => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: w < 600 ? 812 : 800, deviceScaleFactor: 1, mobile: w < 600 });
    await js(`localStorage.setItem('aigile-switch-work-view', '${view}'); true`);
    for (let i = 0; ; i++) {
      await cdp('Page.navigate', { url: kit.BASE + url });
      try { await until(() => js(`!!document.querySelector(${JSON.stringify(ready)})`), 10000, url); break; } catch (e) { if (i) throw e; }
    }
    await sleep(400);
  };
  // 文字佔幾行：只看文字節點的位置，上下差 6px 內算同一行
  const lines = sel => js(`(() => {
    const w = document.createTreeWalker(document.querySelector(${JSON.stringify(sel)}), NodeFilter.SHOW_TEXT), tops = [];
    for (let n; (n = w.nextNode());) { if (!n.textContent.trim()) continue; const g = document.createRange(); g.selectNodeContents(n); for (const r of g.getClientRects()) tops.push(r.top); }
    return tops.sort((a, b) => a - b).filter((t, i, a) => !i || t - a[i - 1] > 6).length;
  })()`);

  // 1. 375：版本紀錄頁標題一行、沒有「‹ 返回」；1024：麵包屑不直排
  await open(375, '/releases', '.work-title h2');
  assert.equal(await lines('.work-title h2'), 1, '版本紀錄標題一行');
  assert.ok(!(await js("!!document.querySelector('[data-rel-back]')")), '版本紀錄沒有「‹ 返回」（手機用左上 ‹）');
  await open(1024, '/p/main/work', '#page-work .work-title');
  assert.ok(JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#crumbs > *')].map(e => e.getBoundingClientRect().height))`)).every(h => h < 40), '麵包屑不直排');

  // 2. 手機頂欄：只放頁名，專案名放副標
  await open(375, '/p/main/work', '#page-work .work-title');
  assert.equal(await js("document.querySelector('#m-title').textContent"), '工作', '手機標題只放頁名');
  assert.equal(await js("document.querySelector('#m-sub').textContent"), '預設專案', '專案名放副標');
  await open(375, '/my-ai', '#myai-pane');
  assert.equal(await js("document.querySelector('#m-sub').hidden"), true, '第一層頁面沒有副標');

  // 3. 看板「還有 N 欄」放在看板上方工具列，不蓋到任何卡片；欄名改「待驗收／決定」
  await open(1024, '/p/main/work', '#page-work .board .ctile', 'B');
  await until(() => js("!!document.querySelector('.board-more:not([hidden])')"), 5000, '還有 N 欄');
  const more = JSON.parse(await js(`JSON.stringify((() => {
    const b = document.querySelector('.board-more:not([hidden])'), r = b.getBoundingClientRect();
    const hit = [...document.querySelectorAll('.board .ctile, .board .bcol-head')].filter(c => { const x = c.getBoundingClientRect(); return x.right > r.left && x.left < r.right && x.bottom > r.top && x.top < r.bottom; }).length;
    return { t: b.textContent, inTools: !!b.closest('.board-tools'), pos: getComputedStyle(b).position, hit };
  })())`));
  assert.ok(/還有 \d+ 欄 →/.test(more.t) && more.inTools && more.pos === 'static' && more.hit === 0, '還有 N 欄不蓋卡片：' + JSON.stringify(more));
  assert.equal(await js("document.querySelector('.bcol[data-col=\"待確認\"] .bcol-head b').textContent"), '待驗收／決定', '欄名改「待驗收／決定」，狀態值不變');

  // 4. 團隊頁：桌機有欄名列；「未讀 N 則」
  await open(1280, '/p/main/team', '.tm-row[data-tm-id]');
  const th = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.tm-th > div')].map(e => e.textContent))`));
  assert.deepEqual(th, ['', '狀態', '目前工作', '未讀訊息', 'Token 到期'], '欄名');
  assert.ok(await js("getComputedStyle(document.querySelector('.tm-th')).display !== 'none'"), '桌機看得到欄名列');
  const row = id => `.tm-row[data-tm-id="${id}"]`;
  assert.match(await js(`document.querySelector('${row(ais[0].participantId)} .tm-pend').textContent`), /^未讀 12 則/, '未讀 N 則');
  assert.equal(await js(`document.querySelector('${row(ais[1].participantId)} .tm-pend').textContent`), '未讀 0');
  assert.ok(!/待處理 \d+ 則|待處理 0/.test(await js("document.querySelector('.tm-list').textContent")), '不再叫「待處理 N 則」');
  assert.equal(await js(`getComputedStyle(document.querySelector('${row(ais[0].participantId)} .tm-token .tm-lbl')).display`), 'none', '桌機格子裡不重複寫欄名');

  // 375：沒有欄名列，格子裡寫「目前工作」；名字一行、角色放下一行
  await open(375, '/p/main/team', '.tm-row[data-tm-id]');
  assert.equal(await js("getComputedStyle(document.querySelector('.tm-th')).display"), 'none', '手機不放欄名列');
  assert.notEqual(await js(`getComputedStyle(document.querySelector('${row(ais[0].participantId)} .tm-state .tm-lbl')).display`), 'none', '手機格子裡寫「目前工作」');
  const who = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.tm-row[data-tm-id] .tm-who')].map(w => { const b = w.querySelector('b'), r = w.querySelector('.muted.small'); return { n: b.textContent, full: b.scrollWidth <= b.clientWidth + 1, below: r.getBoundingClientRect().top >= b.getBoundingClientRect().bottom - 1 }; }))`));
  assert.ok(who.length >= 3 && who.every(w => w.full && w.below), '名字一行沒被截、角色在下一行：' + JSON.stringify(who));

  // 5. 跨專案頻道 0 則：不放「↑ 載入更早」大按鈕和「0 則」分隔線；有訊息的頻道照舊
  await open(375, '/cross/messages', '#messages .empty');
  assert.ok(!(await js("!!document.querySelector('#load-older') || !!document.querySelector('#messages .win-divider')")), '0 則不放大按鈕和分隔線');
  assert.equal(await js("document.querySelector('#m-title').textContent"), '訊息');
  assert.equal(await js("document.querySelector('#m-sub').textContent"), '跨專案頻道');
  await open(375, '/p/main/messages', '#messages .win-divider');

  // 6. 「要你處理」頁：標題、副標「N 件」，不再有重複的「要你處理」區塊標題
  await open(1280, '/p/main/inbox', '#page-work .work-title h2');
  assert.equal(await js("document.querySelector('#page-work .work-title h2').textContent"), '要你處理', '頁名');
  assert.match(await js("document.querySelector('#page-work .work-title .muted').textContent"), /^(\d+ 件|目前沒有)$/, '副標');
  assert.ok(!(await js("[...document.querySelectorAll('.inbox-block-title')].some(e => e.textContent.trim() === '要你處理')")), '不重複區塊標題');
  // 卡片抽屜（窄畫面才有灰底）：點灰底不關，按 × 才關
  await open(700, '/p/main/work', '#page-work .ctile', 'B');
  await js("document.querySelector('#page-work .ctile').click(); true");
  await until(() => js("!!document.querySelector('.drawer-overlay')"), 5000, '抽屜');
  await js("document.querySelector('.drawer-overlay').click(); true"); await sleep(300);
  assert.ok(await js("!!document.querySelector('.drawer')"), '點灰底不關');
  await js("document.querySelector('.drawer [data-close-drawer]').click(); true");
  await until(() => js("!document.querySelector('.drawer')"), 5000, '按 × 關掉');

  console.log('narrow-layout-ui-test：全部通過');
} catch (e) {
  console.error('narrow-layout-ui-test 失敗：', e.message); process.exitCode = 1;
} finally { await kit.stop(); }
