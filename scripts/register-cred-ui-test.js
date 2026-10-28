// 自己註冊、邀請連結都要設帳號密碼，之後用帳密登入（真的瀏覽器，正式啟動模式：有預設管理員）
// 登入頁預設帳號密碼；配對裝置、登入碼收在「其他登入方式」。欄位下即時說哪裡不對；375 不橫向捲動
// 用法：node scripts/register-cred-ui-test.js（找不到 Chrome／Edge 就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('register-cred-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('regui', { env: { AIGILE_TEST_PROJECTS: '0' } });
try {
  await kit.call(null, '/api/health');
  const boss = (await kit.call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' })).body.token;
  await kit.call(boss, '/api/me/password', 'PUT', { username: 'boss.lin', currentPassword: 'admin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' });
  await kit.call(boss, '/api/setup-wizard/done', 'POST');

  const { js, cdp } = await kit.browser(1280, 900);
  const q = s => JSON.stringify(s);
  const click = sel => js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return false; e.click(); return true; })()`);
  const type = (sel, v) => js(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const text = sel => js(`(document.querySelector(${q(sel)})?.textContent || '').trim()`);
  const visible = sel => js(`(() => { const e = document.querySelector(${q(sel)}); return !!e && !!e.offsetParent; })()`);
  const loggedIn = () => js("document.querySelector('#join').hidden && !document.querySelector('#app').hidden");
  const logout = async (w = 1280) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 });
    await cdp('Page.navigate', { url: kit.BASE + '/' });
    await until(() => js('document.readyState === "complete"'), 15000, '首頁');
    await js("localStorage.clear(); true");
    await cdp('Page.navigate', { url: kit.BASE + '/' });
    await until(() => visible('#pwd-form'), 15000, '登入頁');
  };
  const pwdLogin = async (u, p) => {
    await type('#pwd-form [name=username]', u); await type('#pwd-form [name=password]', p);
    await click('#pwd-form [type=submit]');
    await until(loggedIn, 15000, `${u} 用帳密登入`);
  };

  // 1. 登入頁：預設帳號密碼；其他方式收起來
  await logout(375);
  assert.ok(!(await visible('.login-tabs')), '分頁收起來');
  assert.ok(await visible('#login-more'), '有「其他登入方式」');
  await click('#login-more');
  assert.ok(await visible('.login-tabs'), '按了才出現配對裝置、登入碼');

  // 2. 自己註冊（375）：欄位下即時說哪裡不對
  await click('#self-join');
  await until(() => visible('#join-form [name=username]'), 5000, '註冊表單有帳號欄');
  await type('#join-form [name=name]', '陳大文');
  await type('#jn-user', 'ab c');
  assert.match(await text('#jn-user-hint'), /不能有：空白/);
  await type('#jn-user', 'admin');
  assert.match(await text('#jn-user-hint'), /保留帳號/);
  await type('#jn-user', 'chen.dw');
  assert.match(await text('#jn-user-hint'), /4～30 字/, '改對了恢復說明');
  await type('#jn-pwd', 'short');
  assert.match(await text('#jn-pwd-hint'), /還差 3 碼/);
  await type('#jn-pwd', 'pass-word-1'); await type('#jn-again', 'pass-word-2');
  assert.match(await text('#jn-again-hint'), /不一樣/);
  await click('#join-submit');
  await sleep(300);
  assert.ok(!(await loggedIn()), '不一致不送出');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 不橫向捲動');
  await type('#jn-again', 'pass-word-1');
  await click('#join-submit');
  await until(loggedIn, 15000, '註冊成功直接登入');
  // 註冊 → 登出 → 用帳密登入
  await logout();
  await pwdLogin('chen.dw', 'pass-word-1');

  // 3. 帳號重複：伺服器錯誤顯示在帳號欄下
  await logout();
  await click('#self-join');
  await type('#join-form [name=name]', '王小明'); await type('#jn-user', 'chen.dw'); await type('#jn-pwd', 'pass-word-2'); await type('#jn-again', 'pass-word-2');
  await click('#join-submit');
  await until(async () => /已經有人用了/.test(await text('#jn-user-hint')), 8000, '帳號重複顯示在帳號欄下');

  // 4. 邀請連結 → 設帳密 → 登入 → 登出 → 用帳密登入
  const inv = (await kit.call(boss, '/api/invites', 'POST', { name: '張美玲', projects: [] })).body;
  await cdp('Page.navigate', { url: inv.url.replace(/^https?:\/\/[^/]+/, kit.BASE) });
  await until(() => visible('#iv-user'), 15000, '邀請頁有帳號欄');
  assert.match(await text('.inv-pwd legend'), /^設帳號密碼$/, '不再是選填');
  await click('#inv-form [type=submit]');
  await sleep(300);
  assert.match(await text('#iv-user-hint'), /請輸入帳號/, '沒填帳密不能加入');
  await type('#iv-user', 'mei.ling'); await type('#iv-pwd', 'pass-word-4'); await type('#iv-again', 'pass-word-4');
  await click('#inv-form [type=submit]');
  await until(loggedIn, 15000, '邀請加入後登入');
  await logout();
  await pwdLogin('mei.ling', 'pass-word-4');
  console.log('register-cred-ui-test：全部通過');
} catch (e) {
  console.error('register-cred-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
