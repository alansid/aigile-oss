// 新站第一次流程端到端（真的瀏覽器，正式啟動：不開測試模式、全新資料夾，有預設管理員）
// A. admin/admin 登入 → 改帳密（亂填看到錯誤）→ 引導四步全部照預設 → 主畫面；預填值都合法
// B. 引導每步亂填：看到看得懂的錯誤、打的字留著、改正後能繼續；自己註冊第二個人（帳密）
// C. 設了群組密碼（ROOM_CODE）時註冊：錯的被擋、對的能進
// 用法：node scripts/first-run-e2e-ui-test.js（找不到 Chrome／Edge 就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('first-run-e2e-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const PROD = { AIGILE_TEST_PROJECTS: '' }; // 照正式啟動（不是測試模式）
const kits = [];
async function site(name, env = {}) {
  const kit = await startKit(name, { env: { ...PROD, ...env } });
  kits.push(kit);
  const { js, cdp } = await kit.browser(1280, 900);
  const q = s => JSON.stringify(s);
  const h = {
    kit, js, cdp,
    click: sel => js(`(() => { const e = document.querySelector(${q(sel)}); if (!e) return false; e.click(); return true; })()`),
    type: (sel, v) => js(`(() => { const e = document.querySelector(${q(sel)}); e.value = ${q(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`),
    val: sel => js(`document.querySelector(${q(sel)})?.value ?? null`),
    text: sel => js(`(document.querySelector(${q(sel)})?.textContent || '').trim()`),
    visible: sel => js(`(() => { const e = document.querySelector(${q(sel)}); return !!e && !!e.offsetParent && !e.hidden; })()`),
    loggedIn: () => js("document.querySelector('#join').hidden && !document.querySelector('#app').hidden"),
    swErr: () => js("(() => { const e = document.querySelector('#sw .sw-err'); return [e && !e.hidden ? e.textContent.trim() : '', ...[...document.querySelectorAll('#sw .field-msg')].map(x => x.textContent.trim())].filter(Boolean).join(' '); })()"),
    fieldErr: sel => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); const p = i && document.getElementById(i.getAttribute('aria-describedby') || ''); return i?.getAttribute('aria-invalid') === 'true' && p?.classList.contains('field-msg') ? p.textContent.trim() : ''; })()`),
    async fresh() {
      await cdp('Page.navigate', { url: kit.BASE + '/' });
      await until(() => js('document.readyState === "complete"'), 15000, '首頁');
      await js('localStorage.clear(); true');
      await cdp('Page.navigate', { url: kit.BASE + '/' });
      await until(() => h.visible('#pwd-form'), 15000, '登入頁');
    },
  };
  return h;
}
const mcFill = (h, { username, password, again }) => h.js(`(() => { const f = document.querySelector('#mc-form'); const set = (n, v) => { const i = f.querySelector('[name=' + n + ']'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); }; set('current', 'admin'); set('username', ${JSON.stringify(username)}); set('password', ${JSON.stringify(password)}); set('passwordAgain', ${JSON.stringify(again)}); f.querySelector('[type=submit]').click(); return true; })()`);
const mcErr = h => h.js("[...document.querySelectorAll('#must-change .error, #mc-form .error, #mc-form .cred-err')].map(e => e.textContent.trim()).filter(Boolean).join(' ')");

try {
  // ---------- A. 全部照預設 ----------
  {
    const h = await site('e2ea');
    await h.fresh();
    assert.ok(await h.visible('#self-join'), '新站預設開放自己註冊');
    await h.type('#pwd-form [name=username]', 'admin'); await h.type('#pwd-form [name=password]', 'admin');
    await h.click('#pwd-form [type=submit]');
    await until(() => h.visible('#mc-form'), 15000, '先改帳密');
    // 改帳密亂填
    for (const [bad, re] of [[{ username: 'admin', password: 'longpassword1', again: 'longpassword1' }, /admin/], [{ username: 'boss.lin', password: 'short', again: 'short' }, /8/], [{ username: 'boss.lin', password: 'longpassword1', again: 'longpassword2' }, /不一樣/]]) {
      await mcFill(h, bad);
      await until(async () => re.test(await mcErr(h)), 8000, '改帳密錯誤：' + re);
    }
    await mcFill(h, { username: 'boss.lin', password: 'longpassword1', again: 'longpassword1' });
    await until(async () => /boss.lin/.test(await h.text('#mc-form')), 8000, '改好帳密先看到確認（新帳號）');
    await h.click('#mc-go');
    await until(() => h.js("!!document.querySelector('#sw .sw-steps')"), 20000, '改完帳密出現引導');
    // 預填值都合法
    const g = await h.val('#sw-group');
    assert.ok(g && g.length <= 30, '群組名稱預填合法：' + g);
    await h.click('[data-sw="group"]');
    await until(() => h.js("!!document.querySelector('#sw-pj-name')"), 8000, '第 2 步');
    const pn = await h.val('#sw-pj-name');
    assert.ok(pn && pn.length <= 20 && !/[,\n]/.test(pn), '專案名稱預填合法：' + pn);
    assert.equal(await h.val('#sw-pj-slug'), '', '網址英文名預填留空（不是專案 id）');
    await h.click('[data-sw="project"]');
    await until(() => h.js("!!document.querySelector('[data-sw=\"next\"]')"), 8000, '照預設過第 2 步：' + await h.swErr());
    await h.click('[data-sw="next"]');
    await until(() => h.js("!!document.querySelector('#sw-ai-name')"), 8000, '第 4 步');
    const an = await h.val('#sw-ai-name');
    assert.ok(an && an.length <= 40 && !/[\s@]/.test(an), 'AI 名稱預填合法：' + an);
    await h.click('[data-sw="ai"]');
    await until(() => h.js("!!document.querySelector('.sw-text')"), 10000, '照預設建好 AI：' + await h.swErr());
    await h.click('[data-sw="done"]');
    await until(() => h.js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '沒複製就完成要先問'); await h.click('.confirm-root [data-ok]');
    await sleep(1500);
    await until(h.loggedIn, 15000, '主畫面');
    assert.ok(!(await h.js("!!document.querySelector('#sw')")), '做完不再出現引導');
    const tok = await h.js("localStorage.getItem('aigile-switch-token')");
    const pj = (await h.kit.call(tok, '/api/projects')).body.items[0];
    assert.match(pj.slug, /^[a-z0-9][a-z0-9-]{1,39}$/, '專案有合法網址英文名：' + pj.slug);
    assert.equal((await h.kit.call(tok, '/api/my-ais')).body.items.length, 1, 'AI 建好');
  }

  // ---------- B. 每步亂填、改正後繼續；自己註冊第二人 ----------
  {
    const h = await site('e2eb');
    const boss = (await h.kit.call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' })).body.token;
    await h.kit.call(boss, '/api/me/password', 'PUT', { username: 'boss.lin', currentPassword: 'admin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' });
    await h.fresh();
    await h.js(`localStorage.setItem('aigile-switch-token', ${JSON.stringify(boss)}); true`);
    await h.cdp('Page.navigate', { url: h.kit.BASE + '/' });
    await until(() => h.js("!!document.querySelector('#sw-group')"), 20000, '引導');
    // 第 1 步：空白
    await h.type('#sw-group', '   ');
    await h.click('[data-sw="group"]');
    assert.match(await h.swErr(), /請輸入群組名稱/);
    assert.match(await h.fieldErr('#sw-group'), /請輸入群組名稱/, '錯誤在欄位下、紅框');
    await h.type('#sw-group', '我們的團隊');
    await h.click('[data-sw="group"]');
    await until(() => h.js("!!document.querySelector('#sw-pj-name')"), 8000, '改正後到第 2 步');
    // 第 2 步：空白、逗號、網址英文名亂打 → 一鍵帶入建議
    await h.type('#sw-pj-name', '');
    await h.click('[data-sw="project"]');
    assert.match(await h.swErr(), /請輸入專案名稱/);
    await h.type('#sw-pj-name', 'Web,App');
    await h.click('[data-sw="project"]');
    assert.match(await h.swErr(), /逗號/);
    assert.equal(await h.val('#sw-pj-name'), 'Web,App', '打的字留著');
    await h.type('#sw-pj-name', 'Web App');
    await h.type('#sw-pj-slug', 'Bad Slug!');
    await h.click('[data-sw="project"]');
    assert.match(await h.text('#sw-pj-slug-hint'), /不能有/);
    await h.click('[data-slug-use]');
    assert.equal(await h.val('#sw-pj-slug'), 'bad-slug');
    await h.click('[data-sw="project"]');
    await until(() => h.js("!!document.querySelector('#sw-inv-name')"), 8000, '改正後到第 3 步：' + await h.swErr());
    // 第 3 步：空白、有空白的名字
    await h.click('[data-sw="invite"]');
    assert.match(await h.swErr(), /先輸入成員名字/);
    await h.type('#sw-inv-name', '王 小明');
    await h.click('[data-sw="invite"]');
    assert.match(await h.swErr(), /空白/);
    await h.type('#sw-inv-name', '王小明');
    await h.click('[data-sw="invite"]');
    await until(() => h.js("!!document.querySelector('.sw-links li')"), 8000, '邀請連結');
    assert.equal(await h.swErr(), '', '改正後錯誤消失');
    await h.click('[data-sw="next"]');
    await until(() => h.js("!!document.querySelector('#sw-ai-name')"), 8000, '第 4 步');
    // 第 4 步：空白、撞名（伺服器擋）→ 打的字留著 → 改名後建好
    await h.type('#sw-ai-name', '');
    await h.click('[data-sw="ai"]');
    assert.match(await h.swErr(), /請輸入 AI 名稱/);
    await h.type('#sw-ai-name', '管理員'); // 預設管理員的名字，一定撞名
    await h.click('[data-sw="ai"]');
    await until(async () => /已被使用/.test(await h.swErr()), 8000, '撞名看到錯誤');
    assert.match(await h.fieldErr('#sw-ai-name'), /已被使用/, '伺服器擋的也在欄位下');
    assert.equal(await h.val('#sw-ai-name'), '管理員', '撞名後打的字留著（不會被預填蓋掉）');
    await h.type('#sw-ai-name', '團隊的程式開發助手');
    await h.click('[data-sw="ai"]');
    await until(() => h.js("!!document.querySelector('.sw-text')"), 10000, '改名後建好');
    await h.click('[data-sw="done"]');
    await until(() => h.js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '沒複製就完成要先問'); await h.click('.confirm-root [data-ok]');
    await sleep(1500);
    await until(h.loggedIn, 15000, '主畫面');
    const projs = (await h.kit.call(boss, '/api/projects')).body.items;
    assert.ok(projs.some(p => p.name === 'Web App' && p.slug === 'bad-slug'), '設定存進去：' + JSON.stringify(projs.map(p => [p.name, p.slug])));
    assert.equal((await h.kit.call(null, '/api/group')).body.name, '我們的團隊');
    // 自己註冊第二人
    await h.fresh();
    await h.click('#self-join');
    await until(() => h.visible('#jn-user'), 5000, '註冊表單');
    await h.type('#join-form [name=name]', '陳大文'); await h.type('#join-form [name=role]', 'QA');
    await h.type('#jn-user', 'chen.dw'); await h.type('#jn-pwd', 'pass-word-1'); await h.type('#jn-again', 'pass-word-1');
    await h.click('#join-submit');
    await until(h.loggedIn, 15000, '第二人註冊後登入');
    await h.fresh();
    await h.type('#pwd-form [name=username]', 'chen.dw'); await h.type('#pwd-form [name=password]', 'pass-word-1');
    await h.click('#pwd-form [type=submit]');
    await until(h.loggedIn, 15000, '第二人用帳密登入');
  }

  // ---------- C. 群組密碼（ROOM_CODE） ----------
  {
    const h = await site('e2ec', { ROOM_CODE: 'garden-77' });
    await h.fresh();
    await h.click('#self-join');
    await until(() => h.visible('#room-code-field'), 5000, '註冊表單有群組密碼欄');
    await h.type('#join-form [name=name]', '張美玲'); await h.type('#jn-user', 'mei.ling'); await h.type('#jn-pwd', 'pass-word-4'); await h.type('#jn-again', 'pass-word-4');
    await h.click('#join-submit'); // 沒填群組密碼：送出前就擋，不說「錯誤」
    await until(async () => (await h.text('#join-error')) === '請輸入群組密碼', 5000, '沒填群組密碼先擋');
    await h.type('#join-form [name=roomCode]', 'wrong-code');
    await h.click('#join-submit');
    await until(async () => /群組密碼錯誤/.test(await h.text('#join-error')), 8000, '群組密碼錯被擋');
    assert.equal(await h.val('#jn-user'), 'mei.ling', '打的字留著');
    await h.type('#join-form [name=roomCode]', 'garden-77');
    await h.click('#join-submit');
    await until(h.loggedIn, 15000, '群組密碼對就能註冊');
  }
  console.log('first-run-e2e-ui-test：全部通過');
} catch (e) {
  console.error('first-run-e2e-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  for (const k of kits) await k.stop().catch(() => {});
}
