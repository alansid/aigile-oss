// 畫面測試（真的瀏覽器，375）：第一次設定引導與管理頁都能載入示範資料，管理頁能清掉
// 1. 新站（預設管理員改完帳密）：第一次設定引導頂端有「載入示範資料」，按了顯示已載入，示範專案建好
// 2. 成員與權限 › 系統：顯示已載入，按「清除示範資料」→ 確認 → 示範專案不見、真資料還在
// 3. 再按「載入示範資料」又能載入；375 沒有橫向捲動
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/demo-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('demo-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('demo', { env: { AIGILE_TEST_PROJECTS: '0', UPDATE_CHECK: '0' } }); // 一般模式：有預設管理員與第一次設定引導
try {
  await until(async () => (await kit.call(null, '/api/health')).status === 200, 10000, '伺服器');
  const login = await kit.call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const tok = login.body.token;
  assert.equal((await kit.call(tok, '/api/me/password', 'PUT', { username: 'owner1', currentPassword: 'admin', newPassword: 'pass-word-9', newPasswordAgain: 'pass-word-9' })).status, 200, '改帳密');
  const realPj = (await kit.call(tok, '/api/me')).body.projects[0];
  assert.equal((await kit.call(tok, '/api/cards', 'POST', { requestId: 'real1', project: realPj, title: '真的卡' })).status, 201);

  const { js, login: open } = await kit.browser(375, 800);
  await open(tok, '/');
  // 1. 第一次設定引導
  await until(() => js("!!document.querySelector('.sw [data-sw=\"demo\"]')"), 15000, '引導裡的載入示範資料');
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '375 沒有橫向捲動');
  await js("document.querySelector('.sw [data-sw=\"demo\"]').click(); true");
  await until(() => js("/已載入示範資料/.test(document.querySelector('.sw-demo')?.textContent || '')"), 15000, '引導顯示已載入');
  const st = (await kit.call(tok, '/api/admin/demo')).body;
  assert.equal(st.loaded, true);
  assert.ok((await kit.call(tok, '/api/me')).body.projects.includes(st.projectId), '示範專案建好、你在裡面');
  // 引導第 3 步：「新成員可以申請加入」預設開、可以切換
  for (let i = 0; i < 2; i++) { await js("document.querySelector('.sw [data-sw=\"skip\"]').click(); true"); await new Promise(r => setTimeout(r, 300)); }
  await until(() => js("!!document.querySelector('.sw [data-sw=\"pjjoin\"]')"), 10000, '第 3 步有開放申請的開關');
  assert.match(await js("document.querySelector('.sw-pj-join').textContent"), /新成員可以申請加入/);
  assert.equal(await js("document.querySelector('.sw [data-sw=\"pjjoin\"]').getAttribute('aria-checked')"), 'true', '預設開');
  await js("document.querySelector('.sw [data-sw=\"pjjoin\"]').click(); true");
  await until(() => js("document.querySelector('.sw [data-sw=\"pjjoin\"]')?.getAttribute('aria-checked') === 'false'"), 10000, '關掉');
  assert.equal((await kit.call(tok, '/api/projects')).body.join[realPj].open, false, '伺服器也關了');
  await js("document.querySelector('.sw [data-sw=\"pjjoin\"]').click(); true");
  await until(() => js("document.querySelector('.sw [data-sw=\"pjjoin\"]')?.getAttribute('aria-checked') === 'true'"), 10000, '再打開');
  await js("document.querySelector('.sw [data-sw=\"skipall\"]').click(); true");
  await until(() => js("!!document.querySelector('.av-btn') && !document.querySelector('.sw')"), 15000, '引導關掉、重新整理');

  // 2. 管理頁清除
  await open(tok, '/members');
  await until(() => js("!!document.querySelector('[data-pm-tab=\"system\"]')"), 15000, '系統分頁');
  await js("document.querySelector('[data-pm-tab=\"system\"]').click(); true");
  await until(() => js("!!document.querySelector('[data-demo=\"clear\"]')"), 15000, '清除按鈕');
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '系統分頁 375 沒有橫向捲動');
  await js("document.querySelector('[data-demo=\"clear\"]').click(); true");
  await until(() => js("[...document.querySelectorAll('.modal button')].some(b => b.textContent.trim() === '清除')"), 5000, '確認視窗');
  await js("[...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === '清除').click(); true");
  await until(async () => (await kit.call(tok, '/api/admin/demo')).body.loaded === false, 15000, '清除完成');
  assert.ok(!(await kit.call(tok, '/api/me')).body.projects.includes(st.projectId), '示範專案不見了');
  assert.equal((await kit.call(tok, `/api/cards?project=${realPj}`)).body.items.filter(c => c.title === '真的卡').length, 1, '真資料還在');

  // 3. 再載入一次
  await new Promise(r => setTimeout(r, 2000)); // 清除後自動重新整理
  await open(tok, '/members');
  await until(() => js("!!document.querySelector('[data-pm-tab=\"system\"]')"), 15000, '系統分頁');
  await js("document.querySelector('[data-pm-tab=\"system\"]').click(); true");
  await until(() => js("!!document.querySelector('[data-demo=\"load\"]')"), 15000, '載入按鈕');
  await js("document.querySelector('[data-demo=\"load\"]').click(); true");
  await until(async () => (await kit.call(tok, '/api/admin/demo')).body.loaded === true, 15000, '又載入了');
  console.log('demo-ui-test：全部通過');
} catch (e) {
  console.error('demo-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
