// 畫面測試（真的瀏覽器）：頂欄下方整排展開篩選、時間快選＋自訂日曆、「已套用」小標籤、看板最後有動靜時間、中英文、手機 375
// 用法：node scripts/filter-row-time-ui-test.js（設 OSS478_SHOTS=資料夾 可另存實測截圖）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('filter-row-time-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('flt478');
try {
  const { call, sql } = kit;
  const PJ = '預設專案';
  const boss = (await call(null, '/api/join', 'POST', { name: '林小安', role: 'PO' })).body;
  const mate = (await call(boss.token, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  await call(boss.token, `/api/participants/${mate.participant.participantId}/projects`, 'PUT', { projects: [PJ] });

  const localDayIso = (daysAgo, hour = 12) => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo, hour, 0, 0).toISOString();
  };
  const localDayYmd = daysAgo => {
    const n = new Date(), d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo);
    const p2 = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };

  const m12 = (await call(mate.token, '/api/messages', 'POST', { project: PJ, requestId: 'o478_m12', text: '12 天前的訊息' })).body;
  const m5 = (await call(mate.token, '/api/messages', 'POST', { project: PJ, requestId: 'o478_m5', text: '5 天前的訊息' })).body;
  const m2 = (await call(mate.token, '/api/messages', 'POST', { project: PJ, requestId: 'o478_m2', text: '前天的訊息' })).body;
  await call(mate.token, '/api/messages', 'POST', { project: PJ, requestId: 'o478_m0', text: '[進度] 今天的最新訊息' });
  sql('UPDATE messages SET created_at = ? WHERE id = ?', localDayIso(12), m12.messageId);
  sql('UPDATE messages SET created_at = ? WHERE id = ?', localDayIso(5), m5.messageId);
  sql('UPDATE messages SET created_at = ? WHERE id = ?', localDayIso(2), m2.messageId);

  await call(boss.token, '/api/cards', 'POST', { requestId: 'o478_c_old', project: PJ, title: '12天前舊卡', ownerId: mate.participant.participantId });
  await call(boss.token, '/api/cards', 'POST', { requestId: 'o478_c_5', project: PJ, title: '5天前更新卡', ownerId: mate.participant.participantId });
  const cComment = (await call(boss.token, '/api/cards', 'POST', { requestId: 'o478_c_cmt', project: PJ, title: '10天前但今天留言卡', ownerId: mate.participant.participantId })).body;
  await call(boss.token, '/api/messages', 'POST', { project: PJ, requestId: 'o478_c_cmt_msg', cardId: cComment.cardId, text: `[回覆] ${cComment.cardId}：今天補一則留言` });
  sql('UPDATE cards SET created_at = ?, updated_at = ? WHERE seq = ?', localDayIso(12), localDayIso(12), 1);
  sql('UPDATE cards SET created_at = ?, updated_at = ? WHERE seq = ?', localDayIso(5), localDayIso(5), 2);
  sql('UPDATE cards SET created_at = ?, updated_at = ? WHERE seq = ?', localDayIso(10), localDayIso(10), 3);

  const { js, login, cdp } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shotDir = process.env.OSS478_SHOTS;
  const shot = async name => {
    if (!shotDir) return;
    fs.mkdirSync(shotDir, { recursive: true });
    await sleep(250);
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };

  // 1. 中文 1280 訊息＋時間＋已套用＋看板最後動靜
  await size(1280, 860);
  await login(boss.token, '/p/main/messages');
  await until(() => js("document.querySelectorAll('#messages .msg').length >= 1"), 15000, '進訊息頁');
  await sleep(300);
  assert.equal(await js("document.querySelector('#msg-flt-drawer').hidden && !document.querySelector('[data-tb-collapse]')"), true, '預設收起且無 «／»');

  await js("document.querySelector('[data-tb-filter]').click(); true");
  await until(() => js("!document.querySelector('#msg-flt-drawer').hidden"), 3000, '展開整排');
  await js(`const m = document.querySelector('[data-flt-member]'); m.value = ${JSON.stringify(mate.participant.participantId)}; m.dispatchEvent(new Event('change', { bubbles: true })); true`);
  await js("document.querySelector('[data-flt-time-btn]').click(); true");
  await until(() => js("!document.querySelector('#tb-time-menu').hidden"), 3000, '開時間選單');
  await js("document.querySelector('#tb-time-menu [data-tm-val=\"today\"]').click(); true");
  await until(() => js("document.querySelectorAll('#messages .msg').length === 1"), 5000, '今天 1 則');

  await js("document.querySelector('[data-flt-time-btn]').click(); true");
  await until(() => js("!document.querySelector('#tb-time-menu').hidden"), 3000, '開時間選單 custom');
  await js("document.querySelector('#tb-time-menu [data-tm-val=\"custom\"]').click(); true");
  await until(() => js("!document.querySelector('#tb-date-pop').hidden"), 3000, '打開自訂日曆');
  const y12 = localDayYmd(12), y5 = localDayYmd(5);
  await js(`(() => {
    const f = document.querySelector('#tb-date-pop [data-dp-from]'), t = document.querySelector('#tb-date-pop [data-dp-to]');
    f.value = ${JSON.stringify(y12.replace(/-/g, '/'))}; f.dispatchEvent(new Event('input', { bubbles: true }));
    t.value = ${JSON.stringify(y5.replace(/-/g, '/'))}; t.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await js("document.querySelector('#tb-date-pop [data-dp-apply]').click(); true");
  await until(() => js("document.querySelector('#tb-date-pop').hidden && document.querySelectorAll('#messages .msg').length === 2"), 8000, '自訂日期篩出 2 則');

  await js("document.querySelector('#msg-flt-drawer [data-flt-hide]').click(); true");
  await until(() => js("document.querySelector('#msg-flt-drawer').hidden && !document.querySelector('#msg-flt-applied').hidden"), 3000, '出現已套用列');
  assert.equal(await js("document.querySelector('[data-tb-filter]').textContent"), '篩選 · 2 ▾');
  await js("document.querySelector('#msg-flt-applied [data-flt-clear]').click(); true");

  await js("document.querySelector('[data-nav=\"work\"]').click(); true");
  await until(() => js("document.querySelector('#topbar-title')?.textContent === '看板' && document.querySelectorAll('.crow, .ctile').length === 3"), 10000, '進看板見 3 張卡');
  await js("document.querySelector('[data-tb-filter]').click(); true");
  await until(() => js("!document.querySelector('#work-flt-drawer').hidden"), 3000, '看板展開');
  await js("document.querySelector('#work-flt-drawer [data-flt-time-btn]').click(); true");
  await until(() => js("!document.querySelector('#tb-time-menu').hidden"), 3000, '看板時間選單');
  await js("document.querySelector('#tb-time-menu [data-tm-val=\"today\"]').click(); true");
  await until(() => js("document.querySelectorAll('.crow, .ctile').length === 1"), 5000, '看板今天僅剩今天有留言動靜的卡');
  assert.match(await js("document.querySelector('#work-body').innerText"), /10天前但今天留言卡/);
  assert.match(await js("document.querySelector('.crow .crow-time')?.textContent || ''"), /^今天 \d\d:\d\d/, '看板顯示最後動靜時間');
  assert.equal(await js("document.querySelector('.crow .crow-time')?.getAttribute('title')"), '最後有動靜');

  // 2. 英文版 1280 ＋ 375
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await login(boss.token, '/p/main/messages');
  await until(() => js("document.documentElement.lang === 'en' && document.querySelector('#topbar-title')?.textContent === 'Messages'"), 15000, '英文訊息頁');
  assert.equal(await js("document.querySelector('[data-tb-filter]').textContent"), 'Filter ▾', '英文顯示 Filter ▾');
  await js("document.querySelector('[data-tb-filter]').click(); true");
  await until(() => js("!document.querySelector('#msg-flt-drawer').hidden"), 3000, '英文展開');
  assert.equal(await js("document.querySelector('[data-flt-time-btn]').textContent.trim()"), 'TimeAll time ▾', '英文時間鈕顯示 Time All time');
  assert.ok(await js("document.querySelector('[data-flt-tag]').closest('.flt-pill').getBoundingClientRect().width < 150"), '英文 Type 膠囊寬度跟著字走');
  assert.match(await js("document.querySelector('[data-flt-member]').closest('.flt-pill')?.innerText || ''"), /^Member\s/, '英文標籤為 Member');
  await js("document.querySelector('[data-flt-time-btn]').click(); true");
  await until(() => js("!document.querySelector('#tb-time-menu').hidden"), 3000, '英文時間選單');
  await js("document.querySelector('#tb-time-menu [data-tm-val=\"7d\"]').click(); true");
  await until(() => js("(() => { const tx = [...document.querySelectorAll('#messages .msg')].map(e => e.innerText).join('\\n'); return tx.includes('5 天前的訊息') && tx.includes('今天的最新訊息') && !tx.includes('12 天前的訊息'); })()"), 8000, '英文最近 7 天顯示含 5 天前且排除 12 天前');
  assert.match(await js("document.querySelector('#messages .win-divider')?.textContent || ''"), /^Last 7 days \(.+? – .+?\) · \d+ messages?$/, '英文頂端範圍標籤正確');
  assert.equal(await js("document.querySelector('#messages .msg-start')?.textContent"), 'No earlier messages in this range', '英文頂端無更早訊息說明正確');
  await shot('OSS-478-1-1280-EN-展開');
  await js("document.querySelector('#msg-flt-drawer [data-flt-hide]').click(); true");
  await until(() => js("!document.querySelector('#msg-flt-applied').hidden"), 3000, '英文收起顯示 Applied');
  assert.match(await js("document.querySelector('#msg-flt-applied').innerText"), /Applied/);
  assert.equal(await js("document.querySelector('[data-tb-filter]').textContent"), 'Filter · 1 ▾');
  await shot('OSS-478-2-1280-EN-已套用');

  // 英文 375
  await size(375, 812);
  await login(boss.token, '/p/main/messages');
  await until(() => js("!!document.querySelector('#f-open') && document.documentElement.lang === 'en'"), 15000, '英文 375');
  await js("document.querySelector('#f-open').click(); true");
  await until(() => js("!document.querySelector('#msg-flt-drawer').hidden"), 3000, '英文 375 展開');
  await js("const s = document.querySelector('#msg-flt-drawer [data-flt-time-sel]'); s.value = 'custom'; s.dispatchEvent(new Event('change', { bubbles: true })); true");
  await until(() => js("!!document.querySelector('[data-flt-m-from]') && !!document.querySelector('[data-flt-m-to]')"), 3000, '英文 375 自訂日期兩格');
  assert.ok(await js("document.documentElement.scrollWidth <= innerWidth + 1"), '英文 375 無橫捲');
  await shot('OSS-478-3-375-EN-自訂日期');

  console.log('filter-row-time-ui-test：全部通過');
} finally {
  await kit.stop();
}
