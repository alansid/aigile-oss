// 畫面測試：桌面頂欄單排整合＋「«」收合鈕（含中英文切換、各頁與手機版）
// 用法：node scripts/topbar-ui-test.js（設 TOPBAR_SHOTS=資料夾 可另存英文實測截圖）
import './test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('topbar-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('tb471');
try {
  const { call } = kit;
  const PJ = '預設專案';
  const boss = (await call(null, '/api/join', 'POST', { name: '林小安', role: 'PO' })).body;
  const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '開發助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  await call(boss.token, '/api/messages', 'POST', { project: PJ, requestId: 'tb_m1', text: '大家好，確認頂欄整合。' });
  await call(kit.aiToken(ai.participantId), '/api/messages', 'POST', { project: PJ, requestId: 'tb_m2', text: '[需確認] 頂欄收合好用嗎？', recipientIds: [boss.participant.participantId], replyFrom: [boss.participant.participantId] });
  await call(boss.token, '/api/cards', 'POST', { requestId: 'tb_c1', project: PJ, title: '頂欄測試卡', reason: '驗證頂欄' });

  const { js, login, cdp } = await kit.browser(1520, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shotDir = process.env.TOPBAR_SHOTS;
  const shot = async name => {
    if (!shotDir) return;
    fs.mkdirSync(shotDir, { recursive: true });
    await sleep(250);
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  // 1. 中文 1520 展開 → « 收合 → 小面板 → <1400 自動收合 → 全站頁面 → 手機 375
  await size(1520, 900);
  await login(boss.token, '/p/main/messages');
  await until(() => js("!!document.querySelector('#topbar-title') && document.querySelectorAll('#messages .msg').length >= 1"), 15000, '進訊息頁');
  await sleep(300);
  assert.equal(await js("!!document.querySelector('#crumbs')"), false, '已拿掉麵包屑');
  assert.equal(await js("document.querySelector('#topbar-title').textContent"), '訊息', '頂欄顯示頁名');
  assert.equal(await js("!document.querySelector('[data-tb-collapse]')"), true, '拿掉 «／» 收合鈕');
  assert.equal(await js("document.querySelector('[data-tb-filter]').textContent"), '篩選 ▾', '預設收合顯示篩選 ▾');
  assert.equal(await js("document.querySelector('#msg-flt-drawer').hidden"), true, '進頁預設收合篩選列');
  assert.equal(await js("getComputedStyle(document.querySelector('#filter-bar')).display"), 'none', '桌面隱藏舊 filter-bar');

  await js("document.querySelector('[data-tb-filter]').click(); true");
  await until(() => js("!document.querySelector('#msg-flt-drawer').hidden"), 3000, '展開篩選列');
  assert.equal(await js("document.querySelector('[data-tb-filter]').getAttribute('aria-controls')"), 'msg-flt-drawer', '篩選鈕有 aria-controls');
  await js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true");
  assert.equal(await js("document.querySelector('#msg-flt-drawer').hidden && document.activeElement?.matches('[data-tb-filter]')"), true, 'Esc 關掉展開列並回焦點');

  await size(1280, 860);
  await until(() => js("!!document.querySelector('[data-tb-filter]')"), 4000, '1280 顯示篩選鈕');
  assert.equal(await js("document.querySelector('[data-tb-collapse]')?.getClientRects().length || 0"), 0, '1280 不顯示 »');

  assert.equal(await js("!!document.querySelector('.topbar [data-dm-toggle] svg.dm-ico') && getComputedStyle(document.querySelector('.topbar [data-dm-toggle]')).opacity === '1'"), true, '私訊圖示深色非停用態');
  for (const [sel, title] of [['[data-nav="work"]', '看板'], ['[data-nav="inbox"]', '要你處理'], ['[data-nav="team"]', '團隊'], ['[data-nav="files"]', '文件'], ['[data-nav="overview"]', '概觀']]) {
    await js(`document.querySelector(${JSON.stringify(sel)}).click(); true`);
    await until(() => js(`document.querySelector('#topbar-title')?.textContent === ${JSON.stringify(title)}`), 10000, title);
    assert.ok(await js("document.querySelector('.topbar').getBoundingClientRect().height <= 60 && document.documentElement.scrollWidth <= innerWidth + 1"), `${title} 單排不橫捲`);
  }

  // 2. 英文介面驗證
  await size(1520, 900);
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await login(boss.token, '/p/main/messages');
  await until(() => js("document.documentElement.lang === 'en' && document.querySelector('#topbar-title')?.textContent === 'Messages' && !!document.querySelector('[data-tb-filter]')"), 15000, '英文訊息頁');
  await sleep(300);
  assert.equal(await js("document.querySelector('[data-tb-filter]').textContent"), 'Filter ▾', '英文顯示 Filter ▾');
  await shot('topbar-展開-en-1520');
  await js("document.querySelector('.topbar .help-btn').dispatchEvent(new PointerEvent('pointerover', { bubbles: true })); true");
  assert.equal(await js("document.querySelector('.tb-hint').textContent"), 'Help', '英文 ? tooltip 為 Help');
  await js("document.querySelector('[data-tb-filter]').click(); true");
  await until(() => js("document.querySelector('[data-tb-filter]')?.textContent === 'Filter ▴' && !document.querySelector('#msg-flt-drawer').hidden"), 3000, '英文展開變 Filter ▴');
  await js("document.querySelector('[data-nav=\"work\"]').click(); true");
  await until(() => js("document.querySelector('#topbar-title')?.textContent === 'Board'"), 5000, '英文看板頁名為 Board');

  // 3. 手機 375 不動
  await size(375, 812);
  await js("localStorage.setItem('aigile-lang', 'zh'); true");
  await login(boss.token, '/p/main/messages');
  await until(() => js("!!document.querySelector('#f-open') && getComputedStyle(document.querySelector('.m-scope')).display !== 'none'"), 15000, '手機訊息頁');
  assert.equal(await js("getComputedStyle(document.querySelector('.topbar')).display"), 'none', '手機不顯示桌面頂欄');
  assert.ok(await js("document.documentElement.scrollWidth <= innerWidth + 1"), '手機 375 不橫向捲動');

  console.log('topbar-ui-test：全部通過');
} finally {
  await kit.stop();
}
