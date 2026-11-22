// 網頁：個人設定 › 帳號密碼「忘記目前密碼？」（裝置登入才出現）
// 點了收起目前密碼欄、帳號鎖住，填新密碼兩次 → 確認框寫清楚其他裝置會登出 → 存好；說明改成「已登入用這個，完全登不進來才找管理員」
// 手機 375 不橫向捲動。本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。用法：node scripts/password-forgot-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('password-forgot-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('pwforgot');
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const dev = (await kit.call(null, '/api/auth/code', 'POST', { code: liu.token })).body.token; // 用裝置登入（登入碼直接用不會出現這個選項）
  const PW = 'correct horse 1', PW2 = 'battery staple 2';
  assert.equal((await kit.call(dev, '/api/me/password', 'PUT', { username: 'yuchih', newPassword: PW, newPasswordAgain: PW })).status, 200);
  const other = (await kit.call(null, '/api/auth/password', 'POST', { username: 'yuchih', password: PW })).body.token;
  const { js, login, cdp } = await kit.browser(1280, 900);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await login(dev);
  const openAcct = async () => {
    await js("document.querySelector('.topbar .av-btn').click(); true");
    await until(() => js("!!document.querySelector('#av-menu [data-av=\"settings\"]')"), 5000, '頭像選單');
    await js("document.querySelector('#av-menu [data-av=\"settings\"]').click(); true");
    await until(() => js("!!document.querySelector('#st-acct')"), 5000, '個人設定');
    await js("document.querySelector('#st-acct').click(); true");
    await until(() => js("!document.querySelector('#pwd-set-form').hidden"), 5000, '帳號密碼表單');
    await sleep(200);
  };
  await openAcct();
  const st = () => js(`JSON.stringify((() => { const f = document.querySelector('#pwd-set-form'); return {
    link: !document.querySelector('#pwd-forgot-row').hidden, on: !document.querySelector('#pwd-forgot-on').hidden, cur: !document.querySelector('#pwd-cur-l').hidden,
    user: f.username.disabled, help: document.querySelector('#pwd-forgot').textContent, hscroll: document.documentElement.scrollWidth > innerWidth + 1 }; })())`).then(JSON.parse);
  let s = await st();
  assert.ok(s.link && s.cur && !s.on && !s.user, '一開始：有目前密碼欄與「忘記目前密碼？」：' + JSON.stringify(s));
  assert.match(s.help, /忘了目前密碼：在這台按上面的「忘記目前密碼？」直接設新的。\s*完全登不進來時/, '說明改成已登入用這個、登不進來才找人');
  assert.ok(!s.hscroll, '375 沒有橫向捲動');
  // 點「忘記目前密碼？」
  await js("document.querySelector('#pwd-forgot-cur').click(); true");
  await sleep(150);
  s = await st();
  assert.ok(!s.cur && s.on && !s.link && s.user, '忘記模式：收起目前密碼、帳號鎖住、顯示說明：' + JSON.stringify(s));
  assert.equal(await js("document.querySelector('#pwd-user-hint').textContent"), '這個模式只能改密碼', '帳號欄下面寫只能改密碼');
  assert.equal(await js("document.querySelector('#pwd-set-form button[type=submit]').textContent"), '設新密碼', '主按鈕叫設新密碼');
  assert.ok(await js("document.activeElement?.name === 'newPassword'"), '游標到新密碼');
  // 「我記得」切回去
  await js("document.querySelector('#pwd-forgot-back').click(); true"); await sleep(150);
  s = await st(); assert.ok(s.cur && !s.on && !s.user, '切回填目前密碼');
  await js("document.querySelector('#pwd-forgot-cur').click(); true"); await sleep(150);
  // 填新密碼送出 → 確認框
  await js(`(() => { const f = document.querySelector('#pwd-set-form'); f.newPassword.value = ${JSON.stringify(PW2)}; f.again.value = ${JSON.stringify(PW2)}; f.querySelector('button[type=submit]').click(); return true; })()`);
  await until(() => js("!!document.querySelector('.confirm-root .confirm-msg')"), 5000, '確認框');
  const msg = await js("document.querySelector('.confirm-root').textContent");
  assert.equal(await js("document.querySelectorAll('.confirm-root .confirm-list li').length"), 3, '確認框分三行');
  for (const k of ['不用目前密碼，直接設新密碼？', '你其他所有裝置', '都會登出', '這台不會登出', '舊的登入碼會失效', '安全通知']) assert.ok(msg.includes(k), '確認框寫：' + k + '｜' + msg);
  await js("document.querySelector('.confirm-root [data-ok]').click(); true");
  await until(() => js("/已設新密碼/.test(document.querySelector('#pwd-status')?.textContent || '')"), 8000, '存好');
  assert.match(await js("document.querySelector('#pwd-status').textContent"), /另外 \d+ 台裝置已登出/);
  s = await st(); assert.ok(s.cur && !s.on && !s.user, '存好後回到一般模式');
  assert.equal(await js("document.querySelector('#pwd-set-form button[type=submit]').textContent"), '儲存', '一般模式按鈕回到儲存');
  // 安全通知：不寫「這台」，認不出裝置寫「不明裝置」
  await login(dev, '/p/main/inbox');
  await until(() => js("!!document.querySelector('.sec-note')"), 10000, '安全通知');
  const note = await js("[...document.querySelectorAll('.sec-note')].map(n => n.textContent).join('|')");
  assert.match(note, /用一台已登入的裝置（[^）]+）重設了你的密碼，沒有填目前密碼 · [^。]+。其他裝置都已登出。/, '安全通知文字：' + note);
  assert.ok(!/在這台裝置/.test(note), '不寫「這台」');
  assert.equal((await kit.call(other, '/api/me')).status, 401, '另一台被登出');
  assert.equal((await kit.call(null, '/api/auth/password', 'POST', { username: 'yuchih', password: PW2 })).status, 200, '新密碼可以登入');
  // 英文介面：兩句說明各自翻到、安全通知與連結都是英文
  await js("localStorage.setItem('aigile-lang', 'en'); window.__staleReload = 1; location.reload(); true");
  await until(() => js('!window.__staleReload'), 20000, '重新整理後換成新頁面');
  await until(() => js("document.documentElement.lang === 'en' && !!document.querySelector('.sec-note')"), 15000, '英文介面');
  const enNote = await js("[...document.querySelectorAll('.sec-note')].map(n => n.textContent).join('|')");
  assert.match(enNote, /Your password was reset from a signed-in device \([^)]+\) without entering the current password/, '安全通知英文：' + enNote);
  await openAcct();
  assert.equal(await js("document.querySelector('#pwd-forgot-cur').textContent.trim()"), 'Forgot current password?');
  const enHelp = await js("document.querySelector('#pwd-forgot').textContent");
  assert.match(enHelp, /Forgot your current password\? On this device[\s\S]*If you can't sign in at all/, '說明兩句都翻到：' + enHelp);
  assert.ok(!/[\u4e00-\u9fff]/.test(enHelp.replace(/林志明|管理員/g, '')), '說明沒有殘留中文：' + enHelp);
  await js("document.querySelector('#pwd-forgot-cur').click(); true"); await sleep(150);
  assert.equal(await js("document.querySelector('#pwd-set-form button[type=submit]').textContent.trim()"), 'Set new password');
  assert.equal(await js("document.querySelector('#pwd-user-hint').textContent.trim()"), 'Only the password can be changed here');
  // 直接用登入碼呼叫 API 被擋（網頁登入一律換成裝置，所以網頁上一定看得到）：見 password-forgot-test
  console.log('password-forgot-ui-test：全部通過');
} catch (e) {
  console.error('password-forgot-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
