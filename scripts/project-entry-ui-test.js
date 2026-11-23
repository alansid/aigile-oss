// 專案設定入口好找：從專案頁就能改名、管成員、設程式庫
// - 專案卡多一個 ⚙「專案設定」：管理員有改名、程式庫與分支、成員與本專案角色（封存只在管理員設定 › 專案）；該專案 leader 跟管理員一樣（PLAT-381）；原本只有成員與本專案角色；一般成員沒有
// - ⇅ 切換清單最下面「＋ 新增專案」「管理專案…」（只有管理員）
// - 頭像選單：「⚙️ 管理員設定」「📁 專案管理」（只有管理員；專案管理＝管理員設定 › 專案）、「👥 成員管理」；兩頁頂端互相連過去，麵包屑跟著換名字
// - 手機：總覽與選單有「＋ 新增專案」（只有管理員）
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。用法：node scripts/project-entry-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('project-entry-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('projentry');
try {
  const join = async (name, role) => (await kit.call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'), wang = await join('陳小美', 'UX'), chen = await join('王大同', 'PG');
  const id = p => p.participant.participantId;
  for (const [p, pj] of [[wang, ['預設專案', '第二專案']], [chen, ['預設專案']]]) await kit.call(liu.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: pj });
  assert.equal((await kit.call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(wang), leaderOf: ['預設專案'] }] })).status, 200, 'wang 當預設專案 leader');
  const np = (await kit.call(liu.token, '/api/projects', 'POST', { name: '要封存的', code: 'ARC' })).body;
  const arc = np.items.find(p => p.name === '要封存的');

  const { js, login, cdp } = await kit.browser(1280, 900);
  const click = sel => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.textContent || ''`);
  const crumbs = () => text('#crumbs');
  const menuItems = () => js("[...document.querySelectorAll('#pset-menu [data-pset-act]')].map(b => b.dataset.psetAct).join(',')");
  const openGear = async () => {
    await until(() => js("!!document.querySelector('.proj-switch [data-pset]')"), 10000, '專案卡齒輪');
    await click('.proj-switch [data-pset]');
    await until(() => js("!document.getElementById('pset-menu')?.hidden"), 5000, '專案設定選單');
  };
  const avItems = async () => {
    await click('.topbar .av-btn');
    await until(() => js("!!document.querySelector('#av-menu [data-av=\"perm\"]') || !!document.querySelector('#av-menu [data-av=\"logout\"]')"), 5000, '頭像選單');
    return js("[...document.querySelectorAll('#av-menu [data-av]')].map(b => b.dataset.av + '=' + b.textContent.trim()).join('|')");
  };

  // 1. 管理員：專案卡 ⚙ 四項
  await login(liu.token, '/p/main/messages');
  await openGear();
  assert.equal(await menuItems(), 'rename,repo,members,kbai,review', '管理員五項（封存只在專案管理頁；知識庫整理 AI、審查）');
  assert.match(await text('#pset-menu .pset-head'), /預設專案 · 專案設定/);
  // 成員與本專案角色 → 成員管理、選好預設專案
  await click('#pset-menu [data-pset-act="members"]');
  await until(() => js("!!document.querySelector('.pm-tabs')"), 8000, '成員管理頁');
  assert.match(await crumbs(), /成員管理/, '麵包屑寫成員管理：' + await crumbs());
  assert.equal(await js("[...document.querySelectorAll('.pm-tabs [data-pm-tab]')].map(b => b.dataset.pmTab).join(',')"), 'members,roles,skills', '成員管理只留成員、角色、技能');
  assert.equal(await js("document.querySelector('[data-pm-proj][aria-current=\"true\"], .pm-plist [data-pm-proj].sel, [data-pm-proj].on')?.dataset.pmProj || document.querySelector('.pm-detail h3, .pm-dhead b')?.textContent || ''").then(v => /預設專案/.test(v)), true, '選好預設專案');
  // 頂端連到管理員設定：沒有分頁、有左側目錄
  await click('.work-title [data-adm=""]');
  await until(() => js("!!document.querySelector('.adm-split .adm-nav')"), 8000, '管理員設定頁');
  assert.match(await crumbs(), /管理員設定/, '麵包屑寫管理員設定');
  assert.ok(!(await js("!!document.querySelector('.pm-tabs')")), '管理員設定沒有分頁');
  await click('.adm-nav [data-adm="projects"]');
  await until(() => js("!!document.querySelector('.adm-main .pm-ptable')"), 8000, '管理員設定 › 專案');
  // 程式庫與分支 → 程式庫視窗
  await login(liu.token, '/p/main/messages');
  await openGear();
  await click('#pset-menu [data-pset-act="repo"]');
  await until(() => js("/程式庫/.test(document.querySelector('#modal-root')?.textContent || '')"), 8000, '程式庫視窗');
  await js("document.querySelector('#modal-root [data-close]')?.click(); true"); await sleep(200);
  // Esc 關選單
  await openGear();
  await js("document.querySelector('#pset-menu button').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  assert.ok(await js("document.getElementById('pset-menu').hidden"), 'Esc 關掉選單');

  // 2. ⇅ 清單最下面
  await click('.proj-switch .ps-btn');
  await until(() => js("!document.querySelector('.proj-switch .ps-list').hidden"), 5000, '切換清單');
  assert.equal(await js("[...document.querySelectorAll('.proj-switch:not(.sheet-proj) .ps-list [data-ps-act]')].map(b => b.textContent.trim()).join('|')"), '＋ 新增專案|管理專案…');
  await click('.proj-switch [data-ps-act="manage"]');
  await until(() => js("!!document.querySelector('.pm-ptable')"), 8000, '管理專案… 開專案管理');
  await login(liu.token, '/p/main/messages');
  await until(() => js("!!document.querySelector('.proj-switch [data-ps-act=\"newproj\"]')"), 8000, '管理員選項畫好'); // 登入後要等成員資料載入，管理員選項才會畫出來（平台 plat359 同修法）
  await click('.proj-switch .ps-btn'); await sleep(100);
  await click('.proj-switch [data-ps-act="newproj"]');
  await until(() => js("!!document.querySelector('#np-form')"), 5000, '新增專案視窗');
  await js("document.querySelector('#modal-root [data-close]')?.click(); true"); await sleep(200);

  // 3. 頭像選單：管理員設定、專案管理、成員管理
  let av = await avItems();
  assert.match(av, /admin=⚙️管理員設定專案、邀請、帳號/, '管理員設定：' + av);
  assert.match(av, /pm-projects=📁專案管理新增、改名、封存/, '專案管理：' + av);
  assert.match(av, /perm=👥成員管理成員、角色、技能/, '成員管理：' + av);
  assert.ok(!av.includes('成員與權限'), '沒有「成員與權限」');
  await click('#av-menu [data-av="pm-projects"]');
  await until(() => js("!!document.querySelector('.adm-main .pm-ptable') && location.pathname === '/admin/projects'"), 8000, '頭像 › 專案管理＝管理員設定 › 專案');
  await click('.topbar .av-btn'); await sleep(150);
  await click('#av-menu [data-av="perm"]');
  await until(() => js("!!document.querySelector('.pm-tabs')"), 8000, '頭像 › 成員管理');
  assert.match(await crumbs(), /成員管理/);

  // 5. 封存不在齒輪選單；只在管理員設定 › 專案的「⋯」
  await login(liu.token, '/p/' + (arc.slug || arc.id) + '/messages');
  await openGear();
  assert.ok(!(await menuItems()).includes('archive'), '齒輪選單沒有封存');
  await js("document.body.click(); true");
  await login(liu.token, '/members?tab=projects'); // 舊網址自動轉到管理員設定 › 專案
  await until(() => js(`!!document.querySelector('[data-pm-more="${arc.id}"]')`), 8000, '專案管理的 ⋯');
  await click(`[data-pm-more="${arc.id}"]`);
  await until(() => js("!!document.querySelector('.pm-more-menu [data-pp=\"archive\"]')"), 5000, '⋯ 裡有封存');

  // 6. 手機 375：總覽與選單的新增專案
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await login(liu.token, '/');
  await until(() => js("document.querySelector('.project-page [data-hub-newproj]')?.offsetParent != null"), 8000, '手機總覽看得到「＋ 新增專案」'); // 等排版完成再看（原本只等元素出現，偶發失敗；平台 plat359 同修法）
  assert.ok(!(await js("document.getElementById('m-newproj').hidden")), '手機選單有「＋ 新增專案」');
  await click('#m-newproj');
  await until(() => js("!!document.querySelector('#np-form')"), 5000, '手機選單 › 新增專案');
  await js("document.querySelector('#modal-root [data-close]')?.click(); true"); await sleep(200);
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '375 沒有橫向捲動');
  await cdp('Emulation.clearDeviceMetricsOverride');

  // 7. leader：預設專案有 ⚙（只有成員與本專案角色）、第二專案沒有；清單沒有新增；頭像只有成員管理；管理頁沒有切換鈕
  await login(wang.token, '/p/main/messages');
  await openGear();
  assert.equal(await menuItems(), 'rename,repo,members,kbai,review', 'leader 跟管理員一樣：改名、程式庫、成員與本專案角色（PLAT-381）');
  await click('#pset-menu [data-pset-act="members"]');
  await until(() => js("!!document.querySelector('.pm-tabs')"), 8000, 'leader 成員管理');
  assert.ok(!(await js("!!document.querySelector('.work-title [data-adm]')")), 'leader 沒有管理員設定連結');
  assert.match(await text('.work-title'), /成員管理/);
  av = await avItems();
  assert.ok(!av.includes('pm-projects') && !av.includes('admin=') && /perm=👥成員管理/.test(av), 'leader 頭像選單只有成員管理：' + av);
  await login(wang.token, '/p/second/messages');
  await until(() => js("!!document.querySelector('.proj-switch .ph-card')"), 8000, '第二專案');
  assert.ok(!(await js("!!document.querySelector('.proj-switch [data-pset]')")), '不是 leader 的專案沒有齒輪');
  await click('.proj-switch .ps-btn'); await sleep(100);
  assert.ok(!(await js("!!document.querySelector('.proj-switch [data-ps-act]')")), 'leader 的清單沒有新增專案');
  // 一般成員：沒有齒輪、手機選單沒有新增專案
  await login(chen.token, '/p/main/messages');
  await until(() => js("!!document.querySelector('.proj-switch .ph-card')"), 8000, '一般成員');
  assert.ok(!(await js("!!document.querySelector('.proj-switch [data-pset]')")), '一般成員沒有齒輪');
  assert.ok(await js("document.getElementById('m-newproj').hidden"), '一般成員手機選單沒有新增專案');
  // 8. 英文介面：齒輪選單、頭像選單、管理頁切換鈕
  await login(liu.token, '/p/main/messages');
  await js("localStorage.setItem('aigile-lang', 'en'); window.__staleReload = 1; location.reload(); true");
  await until(() => js('!window.__staleReload'), 20000, '重新整理後換成新頁面');
  await until(() => js("document.documentElement.lang === 'en' && !!document.querySelector('.proj-switch [data-pset]')"), 15000, '英文介面');
  await openGear();
  const enMenu = await text('#pset-menu');
  assert.match(enMenu, /Project settings[\s\S]*Rename[\s\S]*Repository and branch[\s\S]*Members and roles in this project/, '英文齒輪選單：' + enMenu);
  await js("document.body.click(); true");
  av = await avItems();
  assert.match(av, /admin=⚙️Admin settingsprojects, invites, accounts/, '英文頭像選單：' + av);
  assert.match(av, /pm-projects=📁Project managementadd, rename, archive/, '英文頭像選單：' + av);
  assert.match(av, /perm=👥Member managementmembers, roles, skills/, '英文頭像選單：' + av);
  await click('#av-menu [data-av="pm-projects"]');
  await until(() => js("!!document.querySelector('.adm-main .pm-ptable')"), 8000, '英文管理員設定 › 專案');
  assert.match(await text('.adm-nav'), /To do[\s\S]*Group settings[\s\S]*Accounts & recovery[\s\S]*Audit & storage[\s\S]*System & backup/, '英文左側目錄：' + await text('.adm-nav'));
  assert.match(await crumbs(), /Admin settings/, '英文麵包屑：' + await crumbs());
  console.log('project-entry-ui-test：全部通過');
} catch (e) {
  console.error('project-entry-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
