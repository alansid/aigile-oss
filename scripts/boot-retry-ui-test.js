// 畫面測試（真的瀏覽器）：網頁啟動時連不上伺服器，不會被登出
// 以前 start() 出任何錯都刪掉 Token、變回登入頁（CI 慢機器上 board-wrap 重新整理後偶發看到登入頁）；
// 現在只有 Token 無效（401）才登出，其他錯誤自動重試 2 次，還是不行就留在載入畫面、寫出錯誤和「重新整理」
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/boot-retry-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('boot-retry-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('bootretry');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const { js, login, cdp, on } = await kit.browser(1280, 900);
  await login(boss.token, '/');
  const dev = await js("localStorage.getItem('aigile-switch-token')"); // 登入後網頁換成這台裝置自己的 Token
  assert.ok(dev, '登入後有 Token');
  const tokenKept = async () => (await js("localStorage.getItem('aigile-switch-token')")) === dev;

  // 讓 /api/me 失敗 fail 次（網路斷）：攔截請求，前 fail 次回失敗、之後照常
  let fail = 0, failed = 0;
  on(m => {
    if (m.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = m.params;
    if (/\/api\/me$/.test(new URL(request.url).pathname) && failed < fail) { failed++; cdp('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }); }
    else cdp('Fetch.continueRequest', { requestId });
  });
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/me*' }] });

  // 1. 斷一次：自動重試、進得去，Token 還在
  fail = 1; failed = 0;
  await js('location.reload(); true');
  await until(() => js("!!document.querySelector('.av-btn') && document.querySelector('#join')?.hidden !== false"), 20000, '斷一次後自動重試進得去');
  assert.equal(failed, 1, '真的斷過一次');
  assert.ok(await tokenKept(), '斷一次：Token 還在');
  await until(() => js("sessionStorage.getItem('aigile-boot-retry') === null"), 10000, '啟動完成後重試次數歸零');

  // 2. 一直斷：重試 2 次後停在載入畫面，寫出錯誤、有「重新整理」，沒有變成登入頁、Token 還在
  fail = 99; failed = 0;
  await js('location.reload(); true');
  await until(() => js("!!document.querySelector('#boot:not([hidden]) .boot-line button')"), 20000, '重試用完停在載入畫面');
  const s = JSON.parse(await js(`JSON.stringify({ text: document.querySelector('#boot .boot-line').textContent, join: !document.querySelector('#join').hidden })`));
  assert.ok(/載入失敗/.test(s.text) && /重新整理/.test(s.text), '寫出載入失敗與重新整理：' + s.text);
  assert.equal(s.join, false, '沒有變成登入頁');
  assert.equal(failed, 3, '第一次＋自動重試 2 次：' + failed);
  assert.ok(await tokenKept(), '一直斷：Token 還在');

  // 3. 網路好了按「重新整理」就進得去（重試次數歸零）
  fail = 0;
  await js("document.querySelector('#boot .boot-line button').click(); true");
  await until(() => js("!!document.querySelector('.av-btn') && document.querySelector('#join')?.hidden !== false"), 20000, '按重新整理後進得去');
  await until(() => js("sessionStorage.getItem('aigile-boot-retry') === null"), 10000, '進得去後重試次數歸零');

  // 4. Token 真的無效（401）照舊登出、回登入頁
  await cdp('Fetch.disable');
  assert.equal((await kit.call(dev, '/api/auth/logout', 'POST')).status < 300, true, '伺服器端登出');
  await js('location.reload(); true');
  await until(() => js("document.querySelector('#join')?.hidden === false"), 20000, 'Token 無效回登入頁');
  assert.equal(await js("localStorage.getItem('aigile-switch-token')"), null, 'Token 無效：刪掉 Token');
  console.log('boot-retry-ui-test：全部通過');
} catch (e) {
  console.error('boot-retry-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
