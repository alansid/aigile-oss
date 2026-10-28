// 第一次設定引導（真的瀏覽器）：一般模式的新站，預設管理員改完帳密 → 引導四步 → 做完不再出現
// 375px：引導填滿畫面、不橫向捲動；按 × 先關，重新整理還會出現。1280：走完四步，設定真的存進去
// 用法：node scripts/setup-wizard-ui-test.js（找不到 Chrome／Edge 就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('setup-wizard-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('wizui', { env: { AIGILE_TEST_PROJECTS: '0' } }); // 一般模式：有預設管理員
try {
  await kit.call(null, '/api/health');
  const tok = (await kit.call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' })).body.token;
  assert.ok(tok, '預設管理員登入');
  assert.equal((await kit.call(tok, '/api/me/password', 'PUT', { username: 'boss.lin', currentPassword: 'admin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' })).status, 200, '改帳密');
  const { js, login, cdp } = await kit.browser(1280, 860);
  const txt = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const set = (sel, v) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  const stepOn = () => txt('.sw-steps li.on');

  // 1. 375px：出現、填滿、不橫向捲動；按 × 先關，重新整理再出現
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
  await login(tok, '/');
  await until(() => js("!!document.querySelector('#sw .sw-steps')"), 15000, '引導出現');
  assert.match(await stepOn(), /1\. 群組名稱/);
  await sleep(400);
  const fit = JSON.parse(await js("JSON.stringify((() => { const m = document.querySelector('.modal.setup').getBoundingClientRect(); return { w: Math.round(m.width), iw: innerWidth, scroll: document.documentElement.scrollWidth > innerWidth + 1 }; })())"));
  assert.ok(fit.w <= fit.iw && !fit.scroll, '375 填滿、不橫向捲動：' + JSON.stringify(fit));
  await click('.modal.setup .modal-x, #modal-root [data-close], #modal-root .modal-x');
  await sleep(300);
  await login(tok, '/');
  await until(() => js("!!document.querySelector('#sw .sw-steps')"), 15000, '按 × 只是先關：重新整理還在');

  // 2. 1280：走完四步
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await login(tok, '/');
  await until(() => js("!!document.querySelector('#sw-group')"), 15000, '第 1 步');
  await set('#sw-group', '我們的團隊'); await click('[data-sw="group"]');
  await until(() => js("!!document.querySelector('#sw-pj-name')"), 8000, '第 2 步');
  // 網址英文名：還沒設時欄位是空的（不帶專案 id）；填錯即時說哪裡不對、一鍵帶入建議值；留空依名稱自動產生
  assert.equal(await js("document.querySelector('#sw-pj-slug').value"), '', '還沒設：欄位留空，不是 prj_…');
  await set('#sw-pj-slug', 'Web App!');
  await until(async () => /不能有/.test(await txt('#sw-pj-slug-hint')), 5000, '填錯即時提示');
  await click('[data-slug-use]');
  assert.equal(await js("document.querySelector('#sw-pj-slug').value"), 'web-app', '一鍵帶入建議值');
  await set('#sw-pj-slug', '');
  await set('#sw-pj-name', '官網改版');
  await until(async () => /\/p\/project-1/.test(await txt('#sw-pj-slug-hint')), 5000, '留空：顯示會變成 /p/project-1');
  await click('[data-sw="project"]');
  await until(() => js("!!document.querySelector('#sw-inv-name')"), 8000, '第 3 步');
  assert.match(await txt('#sw'), /開放自己註冊/, '寫出目前開放註冊');
  // 開放註冊開關：關掉立刻生效，再打開
  const ojOn = () => js("document.querySelector('[data-sw=\"openjoin\"]')?.getAttribute('aria-checked')");
  assert.equal(await ojOn(), 'true');
  await click('[data-sw="openjoin"]');
  await until(async () => (await ojOn()) === 'false', 8000, '引導裡關閉開放註冊');
  assert.equal((await kit.call(null, '/api/health')).body.openJoin, false, '關閉立刻生效');
  await click('[data-sw="openjoin"]');
  await until(async () => (await ojOn()) === 'true', 8000, '引導裡重新打開');
  await set('#sw-inv-name', '王小明'); await click('[data-sw="invite"]');
  await until(() => js("!!document.querySelector('.sw-links li')"), 8000, '邀請連結');
  assert.match(await txt('.sw-links li'), /王小明.*\/invite|王小明/s, '列出邀請連結');
  await click('[data-sw="next"]');
  await until(() => js("!!document.querySelector('#sw-role')"), 8000, '第 4 步');
  assert.match(await js("document.querySelector('#sw-ai-name').value"), /的/, 'AI 名稱自動帶');
  await click('[data-sw="ai"]');
  await until(() => js("!!document.querySelector('.sw-text')"), 10000, '接入指令');
  assert.match(await js("document.querySelector('.sw-text').value"), /\/api\/setup\//, '接入指令含短版接入連結');
  // 依工具顯示：預設 Claude Code，不出現 Codex 的沙盒設定；切到 Codex 才有
  assert.equal(await js("document.querySelector('[data-sw-tool=\"claude\"]').getAttribute('aria-pressed')"), 'true', '預設 Claude Code');
  assert.ok(!/Codex|sandbox_mode/.test(await js("document.querySelector('.sw-text').value")), 'Claude Code 不顯示 Codex 段落');
  await click('[data-sw-tool="codex"]');
  assert.match(await js("document.querySelector('.sw-text').value"), /sandbox_mode = "workspace-write"/, '切到 Codex 顯示開網路的設定');
  assert.ok(await js("document.querySelector('[data-sw=\"copyai\"]').classList.contains('primary') && !document.querySelector('[data-sw=\"done\"]').classList.contains('primary')"), '複製是主按鈕、完成不是');
  // 沒複製就按完成：先問；選「回去複製」留在原處
  await click('[data-sw="done"]');
  await until(() => js("/還沒複製接入指令/.test(document.querySelector('.confirm-root')?.textContent || '')"), 5000, '沒複製就完成要提醒');
  assert.ok(await js("(() => { const c = document.querySelector('.confirm-root [data-close]:not(.modal-x)'), o = document.querySelector('.confirm-root [data-ok]'); return c.classList.contains('primary') && !o.classList.contains('primary') && document.activeElement === c; })()"), '「回去複製」是主按鈕、預設選它，「直接完成」不是');
  await click('.confirm-root [data-close]');
  await sleep(300);
  assert.ok(await js("!!document.querySelector('.sw-text')"), '回去複製：還在接入指令這步');
  await click('[data-sw="done"]');
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '再按完成');
  await click('.confirm-root [data-ok]');
  await sleep(1500);
  await until(() => js("document.readyState === 'complete' && !!document.querySelector('#app') && !document.querySelector('#app').hidden"), 15000, '回到主畫面');
  assert.ok(!(await js("!!document.querySelector('#sw')")), '做完不再出現');
  // 剛建好、還沒接入的 AI：總覽寫出來、可以直接到我的 AI（修正前總覽完全看不到它）
  await until(() => js("/還沒接入/.test(document.querySelector('.hub-newai')?.textContent || '')"), 10000, '總覽提示 AI 還沒接入');
  await until(() => js("/還沒接入/.test(document.querySelector('.sb-presence-text')?.textContent || '')"), 10000, '側欄也寫還沒接入');
  assert.ok(await js("[...document.querySelectorAll('.sb-presence-text .nw')].every(s => s.getClientRects().length === 1)"), '側欄每段字不從中間斷行：' + await js("document.querySelector('.sb-presence-text').innerText"));
  await click('[data-go-myai]');
  await until(() => js("!!document.querySelector('.ma-row')"), 10000, '到我的 AI');

  // 3. 設定真的存進去
  assert.equal((await kit.call(null, '/api/group')).body.name, '我們的團隊', '群組名稱');
  const pj = (await kit.call(tok, '/api/projects')).body.items.find(p => p.name === '官網改版');
  assert.ok(pj && pj.slug === 'project-1', '專案名稱改了、網址英文名留空自動產生：' + JSON.stringify(pj));

  // 管理頁改網址英文名（同一個欄位）：改成 test；新增專案留空
  await login(tok, '/members');
  await until(() => js("!!document.querySelector('[data-pm-tab=\"projects\"]')"), 10000, '成員與權限');
  await click('[data-pm-tab="projects"]');
  await until(() => js("!!document.querySelector('[data-pm-more]')"), 8000, '專案表格');
  await click('[data-pm-more]');
  await until(() => js("!!document.querySelector('[data-pp=\"slug\"]')"), 5000, '⋯ 選單');
  await click('[data-pp="slug"]');
  await until(() => js("!!document.querySelector('#se-slug')"), 5000, '網址英文名對話框');
  assert.equal(await js("document.querySelector('#se-slug').value"), 'project-1');
  await set('#se-slug', 'test');
  await click('button[form="se-form"]');
  await until(async () => (await kit.call(tok, '/api/projects')).body.items.some(p => p.slug === 'test'), 8000, '改成 test');
  await click('[data-pm-newproj]');
  await until(() => js("!!document.querySelector('#np-slug')"), 5000, '新增專案對話框');
  await set('#np-form [name=name]', '行銷');
  await until(async () => /\/p\/project-1/.test(await txt('#np-slug-hint')), 5000, '新增專案留空也自動產生');
  await click('button[form="np-form"]');
  await until(async () => (await kit.call(tok, '/api/projects')).body.items.some(p => p.name === '行銷' && p.slug === 'project-1'), 8000, '新增專案自動網址英文名');
  assert.ok((await kit.call(tok, '/api/invites')).body.items.some(v => v.name === '王小明'), '邀請存在');
  assert.equal((await kit.call(tok, '/api/my-ais')).body.items.length, 1, 'AI 建好了');
  assert.ok(!(await kit.call(tok, '/api/me')).body.setupWizard, 'API 也不再要求引導');
  console.log('setup-wizard-ui-test：全部通過');
} catch (e) {
  console.error('setup-wizard-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
