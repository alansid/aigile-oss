// 管理頁「專案」分頁的加入設定（真的瀏覽器）：切換開放註冊、設定／清除群組密碼，立刻生效並留在群組異動紀錄
// 1280 與 375 都能操作、不橫向捲動（第一次設定引導第 3 步的開關在 setup-wizard-ui-test）
// 用法：node scripts/group-settings-ui-test.js（找不到 Chrome／Edge 就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('group-settings-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('gsui');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 管理員
  const { js, login, cdp } = await kit.browser(1280, 860);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const open = async w => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 1, mobile: w < 600 });
    await login(boss.token, '/members');
    await until(() => js("!!document.querySelector('[data-pm-tab=\"projects\"]')"), 10000, '成員與權限');
    await click('[data-pm-tab="group"]');
    await until(() => js("!!document.querySelector('.pm-join-set [data-pp=\"openjoin\"]')"), 10000, '加入設定');
  };
  const sw = () => js("document.querySelector('.pm-join-set [data-pp=\"openjoin\"]').getAttribute('aria-checked')");
  const health = async () => (await kit.call(null, '/api/health')).body;

  // 1280：關閉開放註冊 → 立刻擋註冊
  await open(1280);
  assert.equal(await sw(), 'true', '預設開放');
  assert.match(await js("document.querySelector('.pm-join-set').textContent"), /未設定/, '群組密碼未設定');
  await click('.pm-join-set [data-pp="openjoin"]');
  await until(async () => (await sw()) === 'false', 8000, '開關切到關');
  assert.equal((await health()).openJoin, false);
  assert.equal((await kit.call(null, '/api/join', 'POST', { name: '陳大文', role: 'QA' })).status, 403, '關了不能自己註冊');
  await click('.pm-join-set [data-pp="openjoin"]');
  await until(async () => (await sw()) === 'true', 8000, '開回來');

  // 設定群組密碼：輸入框清空、顯示已設定；註冊要密碼
  await js("document.querySelector('#pm-room-code').value = 'abc'; true");
  await click('[data-pp="roomcode"]');
  await sleep(300);
  assert.equal((await health()).roomCodeRequired, false, '太短不送出');
  await js("document.querySelector('#pm-room-code').value = 'tea-house-42'; true");
  await click('[data-pp="roomcode"]');
  await until(() => js("!!document.querySelector('[data-pp=\"roomclear\"]')"), 8000, '顯示清除按鈕');
  assert.match(await js("document.querySelector('.pm-join-set').textContent"), /已設定/);
  assert.equal(await js("document.querySelector('#pm-room-code').value"), '', '密碼輸入框清空');
  assert.ok(!(await js("document.body.innerHTML.includes('tea-house-42')")), '頁面上看不到密碼原文');
  assert.equal((await health()).roomCodeRequired, true);
  assert.equal((await kit.call(null, '/api/join', 'POST', { name: '陳大文', role: 'QA', roomCode: 'tea-house-42' })).status, 201, '新密碼能註冊');

  // 異動紀錄
  await click('.pm-gs-log summary');
  const log = await js("document.querySelector('.pm-gs-log').textContent");
  for (const k of ['關閉開放註冊', '開放自己註冊', '設定群組密碼']) assert.ok(log.includes(k), `紀錄有「${k}」：` + log);

  // 375：清除群組密碼（確認框）；不橫向捲動
  await open(375);
  const fit = await js("document.documentElement.scrollWidth <= innerWidth + 1");
  assert.ok(fit, '375 不橫向捲動');
  const ctl = JSON.parse(await js("JSON.stringify((() => { const r = document.querySelector('#pm-room-code').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; })())"));
  assert.ok(ctl.l >= 0 && ctl.r <= ctl.w, '375 密碼輸入框在畫面內：' + JSON.stringify(ctl));
  await click('[data-pp="roomclear"]');
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '確認框');
  await click('.confirm-root [data-ok]');
  await until(async () => !(await health()).roomCodeRequired, 8000, '清除生效');
  await until(() => js("!document.querySelector('[data-pp=\"roomclear\"]')"), 8000, '畫面更新成未設定');
  console.log('group-settings-ui-test：全部通過');
} catch (e) {
  console.error('group-settings-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
