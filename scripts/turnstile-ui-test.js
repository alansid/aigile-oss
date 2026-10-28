// 登入頁的自己註冊與 Turnstile 人機驗證（真的瀏覽器，不連 Cloudflare）
// Turnstile 腳本由瀏覽器攔截換成假的；伺服器的驗證網址指到本機假驗證器
// 1. 開放註冊時登入頁有「自己註冊」；註冊要先過驗證  2. 登入失敗 3 次後才出現驗證，過了才能登入  3. 375 不橫向捲動
// 用法：node scripts/turnstile-ui-test.js（找不到 Chrome／Edge 就略過）
import http from 'node:http';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('turnstile-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const SECRET = 'ui-secret-5530';
const fake = http.createServer((req, res) => {
  let s = ''; req.on('data', d => s += d).on('end', () => {
    const f = new URLSearchParams(s);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: f.get('secret') === SECRET && /^ok-/.test(f.get('response') || '') }));
  });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
// 假的 Turnstile：render 出一顆「我不是機器人」按鈕，按了才給 token
const FAKE_JS = `window.turnstile = {
  render(el, o) { const b = document.createElement('button'); b.type = 'button'; b.className = 'fake-ts'; b.textContent = '我不是機器人'; b.style.width = '100%';
    b.onclick = () => o.callback('ok-' + Math.random().toString(36).slice(2)); el.append(b); window.__tsSize = o.size; return 'w' + el.closest('.ts-box').id; },
  reset(id) { window.__tsResets = (window.__tsResets || 0) + 1; }
};`;
const kit = await startKit('tsui', { env: { TURNSTILE_SITE_KEY: 'site-key-ui', TURNSTILE_SECRET: SECRET, TURNSTILE_VERIFY_URL: `http://127.0.0.1:${fake.address().port}/siteverify` } });
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO', turnstileToken: 'ok-boss' })).body;
  assert.ok(boss.token, '管理員');
  await kit.call(boss.token, '/api/me/password', 'PUT', { username: 'boss.lin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' });

  const { js, cdp, on } = await kit.browser(1280, 860);
  let external = 0;
  on(async m => {
    if (m.method !== 'Fetch.requestPaused') return;
    external++;
    await cdp('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }], body: Buffer.from(FAKE_JS).toString('base64') });
  });
  await cdp('Fetch.enable', { patterns: [{ urlPattern: '*challenges.cloudflare.com*' }] });
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const set = (sel, v) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; return true; })()`);
  const visible = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !!e.offsetParent; })()`);
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
  const home = async (w = 1280) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 860, deviceScaleFactor: 1, mobile: w < 600 });
    await cdp('Page.navigate', { url: kit.BASE + '/' });
    await until(() => js('document.readyState === "complete"'), 15000, '首頁');
    await js("localStorage.removeItem('aigile-switch-token'); true");
    await cdp('Page.navigate', { url: kit.BASE + '/' });
    await until(() => visible('#login-main'), 15000, '登入頁');
  };

  // 1. 自己註冊：登入頁有入口；一開始不載入驗證腳本
  await home(375);
  assert.ok(await visible('#self-join'), '開放註冊時有「自己註冊」');
  assert.ok(!(await visible('#login-ts')), '登入還沒失敗：不顯示驗證');
  assert.equal(external, 0, '還沒要驗證就不載入 Turnstile');
  await click('#self-join');
  await until(() => visible('#join-form'), 5000, '註冊表單');
  assert.equal(await text('#join-title'), '註冊');
  assert.match(await text('#join-desc'), /申請加入專案/);
  await until(() => js("!!document.querySelector('#join-ts .fake-ts')"), 8000, '驗證框出現');
  assert.equal(await js('window.__tsSize'), 'flexible', '驗證框跟著寬度');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 不橫向捲動');
  await set('#join-form [name=name]', '陳大文'); await set('#join-form [name=role]', 'QA');
  await set('#join-form [name=username]', 'chen.dw'); await set('#join-form [name=password]', 'pass-word-1'); await set('#join-form [name=passwordAgain]', 'pass-word-1');
  await click('#join-submit');
  await until(async () => /人機驗證/.test(await text('#join-error')), 8000, '沒驗證被擋');
  await click('#join-ts .fake-ts');
  await click('#join-submit');
  await until(() => js("document.querySelector('#join').hidden && !document.querySelector('#app').hidden"), 15000, '註冊完成並登入');
  const meTok = await js("localStorage.getItem('aigile-switch-token')");
  const meBody = (await kit.call(meTok, '/api/me')).body;
  assert.equal(meBody.name || meBody.participant?.name, '陳大文', '註冊成功，登入的是新成員：' + JSON.stringify(meBody).slice(0, 200));
  assert.equal(external, 1, '驗證腳本只載入一次');

  // 「回登入」
  await home(1280);
  await click('#self-join'); await until(() => visible('#join-back'), 5000, '回登入按鈕');
  await click('#join-back'); await until(() => visible('#pwd-form'), 5000, '回到登入');

  // 2. 登入失敗 3 次後才要驗證
  for (let i = 1; i <= 3; i++) {
    await set('#pwd-form [name=username]', 'boss.lin'); await set('#pwd-form [name=password]', 'wrong-' + i);
    await js("document.querySelector('#pwd-error').textContent = ''; true");
    await click('#pwd-form [type=submit]');
    await until(async () => !!(await text('#pwd-error')), 8000, `第 ${i} 次失敗`);
    await sleep(200);
    assert.equal(await visible('#login-ts'), i >= 3, `第 ${i} 次失敗${i >= 3 ? '後出現驗證' : '還不用驗證'}`);
  }
  await until(() => js("!!document.querySelector('#login-ts .fake-ts')"), 8000, '登入驗證框');
  await set('#pwd-form [name=password]', 'longpassword1');
  await js("document.querySelector('#pwd-error').textContent = ''; true");
  await click('#pwd-form [type=submit]');
  await until(async () => /人機驗證/.test(await text('#pwd-error')), 8000, '沒驗證：密碼對也擋');
  await click('#login-ts .fake-ts');
  await set('#pwd-form [name=password]', 'longpassword1');
  await click('#pwd-form [type=submit]');
  await until(() => js("document.querySelector('#join').hidden && !document.querySelector('#app').hidden"), 15000, '驗證後登入成功');
  console.log('turnstile-ui-test：全部通過');
} catch (e) {
  console.error('turnstile-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  fake.close();
  await kit.stop();
}
