// 畫面測試：「⚙️ 管理員設定」頁（開源版，照平台的管理員設定移植）
// A. 頭像選單「管理」：⚙️ 管理員設定（只有管理員、帶待處理數）、📁 專案管理（開管理員設定 › 專案）、👥 成員管理
// B. 電腦左側小目錄 7 區（待處理、群組設定、專案、邀請、帳號與救援、稽核與儲存、系統與備份）；手機一頁清單點進去
//    「待處理」件數只在大標題寫一次，卡片不再重複
// C. 原處改連結：成員管理只留成員、角色、技能；「邀請新的人」開管理員設定 › 邀請；成員詳細的帳號區變一行連結；
//    文件頁稽核只看自己的；舊網址 /members?tab=projects、invites、group、system 自動轉
// D. 待處理數：加入申請跟左側「要你處理」同一份；後端權限不變（非管理員打 API 照樣擋）
// E. 1280、375、非管理員看不到；英文介面
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 ADMIN_SHOTS=資料夾 會另外截圖。用法：node scripts/admin-settings-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('admin-settings-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('admset');
try {
  const { call } = kit;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'), wang = await join('王小明', 'UX'), chen = await join('陳大文', 'PG');
  const id = p => p.participant.participantId;
  for (const [p, pj] of [[wang, ['預設專案']], [chen, ['預設專案']]]) await call(liu.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: pj });
  assert.equal((await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(wang), leaderOf: ['預設專案'] }] })).status, 200, 'wang 當預設專案 leader');
  // 待處理三種：加入申請、要核准的技能、快到期的邀請
  assert.equal((await call(liu.token, '/api/projects/第二專案/join-settings', 'PUT', { open: true, note: '歡迎' })).status, 200);
  assert.ok((await call(chen.token, '/api/projects/第二專案/join-requests', 'POST', { note: '想幫忙' })).status < 300, 'chen 申請加入第二專案');
  const sk = await call(chen.token, '/api/projects/預設專案/skills', 'POST', { files: [{ path: 'SKILL.md', text: '---\nname: deploy-check\ndescription: 部署前檢查\n---\n照著做\n' }, { path: 'scripts/run.sh', text: 'echo hi\n' }] });
  assert.equal(sk.body.status, 'pending', '含腳本、一般成員上傳 → 等核准');
  assert.ok((await call(liu.token, '/api/invites', 'POST', { name: '王小美', projects: ['預設專案'], ttl: '1h' })).status < 300, '1 小時的邀請');
  await call(liu.token, '/api/invites', 'POST', { name: '李大華', projects: ['預設專案'], ttl: '7d' }); // 7 天的不算快到期

  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const click = sel => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.ADMIN_SHOTS) return; fs.mkdirSync(process.env.ADMIN_SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.ADMIN_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
  const avItems = async () => { // 剛登入時按鈕可能還沒接上事件：沒開就再按一次
    await until(() => js("(() => { const m = document.querySelector('#av-menu'); if (m.hidden) document.querySelector('.topbar .av-btn')?.click(); return !m.hidden && !!m.querySelector('[data-av=\"logout\"]'); })()"), 8000, '頭像選單');
    return js("[...document.querySelectorAll('#av-menu [data-av]')].map(b => b.dataset.av + '=' + b.textContent.trim()).join('|')");
  };

  // ---------- A 頭像選單（1280） ----------
  await size(1280, 900);
  await login(liu.token, '/');
  await until(() => js("!!document.querySelector('.topbar .av-btn')"), 10000, '登入');
  await until(() => js("/管理員設定2/.test(document.querySelector('#av-menu [data-av=\"admin\"]')?.textContent || '')"), 10000, '頭像選單的待處理數到 2（技能在有 leader 的預設專案，先給 leader，PLAT-381）');
  const av = await avItems();
  assert.match(av, /admin=⚙️管理員設定2/, 'A 管理員設定帶待處理 2：' + av);
  assert.match(av, /pm-projects=📁專案管理新增、改名、封存/, 'A 有專案管理：' + av);
  assert.match(av, /perm=👥成員管理成員、角色、技能/, 'A 有成員管理：' + av);
  await shot('1-電腦-頭像選單');
  await click('#av-menu [data-av="pm-projects"]');
  await until(() => js("!!document.querySelector('.adm-nav') && location.pathname === '/admin/projects'"), 8000, '專案管理開管理員設定 › 專案');
  await avItems();
  await click('#av-menu [data-av="admin"]');
  await until(() => js("!!document.querySelector('.adm-nav') && location.pathname === '/admin'"), 8000, '管理員設定');

  // ---------- B 左側 7 區 ----------
  const nav = await J("[...document.querySelectorAll('.adm-nav [data-adm]')].map(b => b.dataset.adm + ':' + b.querySelector('.adm-t b').textContent)");
  assert.deepEqual(nav, ['todo:待處理', 'group:群組設定', 'projects:專案', 'invites:邀請', 'accounts:帳號與救援', 'audit:稽核與儲存', 'system:系統與備份'], 'B 七區照順序');
  assert.match(await js("document.querySelector('#crumbs').textContent"), /管理員設定/, '麵包屑：管理員設定');
  assert.equal(await js("document.querySelector('.adm-nav [data-adm=\"todo\"] .adm-n')?.textContent"), '2', 'B 待處理 2');
  const todo = await J("[...document.querySelectorAll('.adm-todo .adm-row')].map(r => r.innerText.replace(/\\s+/g, ' '))");
  assert.equal(todo.length, 2, '待處理兩列（預設專案的技能先給 leader 王小明，PLAT-381）：' + todo.join(' / '));
  assert.equal(await js("document.querySelector('.adm-main .adm-h').textContent.trim()"), '📋 待處理 · 2', '數字在大標題');
  assert.equal(await js("document.querySelectorAll('.adm-todo .pm-card-head').length"), 0, '卡片不再寫一次「待處理」');
  assert.match(await js("document.querySelector('.adm-todo-note').textContent"), /加入申請也會出現在左側「要你處理」；技能核准和邀請到期只在這裡/, '說明哪些也在左側');
  assert.match(todo[0], /加入申請 1 人 第二專案：陳大文 去核准 ›/, '加入申請：' + todo[0]);
  assert.match(todo[1], /邀請快到期 1 個 王小美 剩 .+ 延長或重發 ›/, '只有 1 小時的邀請算快到期：' + todo[1]);
  // D 加入申請跟左側「要你處理」同一份
  assert.ok(Number(await js("document.querySelector('.inbox-badge:not([hidden])')?.textContent || 0")) >= 1, 'D 左側「要你處理」也有加入申請');
  assert.ok(!(await hscroll()), '1280 沒有橫向捲動');
  await shot('2-電腦-待處理');
  await click('[data-adm-go="join"]');
  await until(() => js("/陳大文/.test(document.querySelector('#modal-root')?.textContent || '')"), 8000, '去核准開待審申請');
  await js("document.querySelector('#modal-root [data-close]')?.click(); true"); await sleep(200);
  // 技能核准先給預設專案 leader（王小明），1 天內不在管理員待處理（PLAT-381，plat381-ui-test 驗）
  await login(liu.token, '/admin');
  await until(() => js("!!document.querySelector('[data-adm-go=\"invite\"]')"), 10000, '待處理');
  await click('[data-adm-go="invite"]');
  await until(() => js("location.pathname === '/admin/invites' && !!document.querySelector('.pm-itable')"), 8000, '延長或重發 → 邀請');
  await shot('4b-電腦-邀請');

  // 各區內容；網址跟著區塊、重新整理停在原處
  const sec = async (k, sel) => { await click(`.adm-nav [data-adm="${k}"]`); await until(() => js(`location.pathname === '/admin/${k}' && !!document.querySelector(${JSON.stringify(sel)})`), 8000, '區塊 ' + k); };
  await sec('group', '.pm-group-name input');
  await until(() => js("!!document.querySelector('.pm-join-set [data-pp=\"openjoin\"]') && !!document.querySelector('#pm-room-code')"), 8000, '群組設定有開放註冊、群組密碼');
  await shot('3-電腦-群組設定');
  await sec('projects', '.pm-ptable');
  assert.ok(await js("!!document.querySelector('[data-pm-newproj]') && !!document.querySelector('[data-pm-more]')"), '專案：新增、⋯ 都在');
  assert.ok(await js("[...document.querySelectorAll('.pm-ptable .c-pname b')].every(b => b.getBoundingClientRect().height < 24)"), '專案名稱不換行');
  await shot('4-電腦-專案');
  await sec('accounts', '.adm-acc [data-pm-cross]');
  const acc = await J("({ reset: document.querySelectorAll('.adm-acc [data-pm-reset]').length, dis: document.querySelectorAll('.adm-acc [data-pm-disable]').length, adm: document.querySelectorAll('.adm-acc [data-pm-admin]').length, rescue: document.querySelector('#adm-rescue')?.innerText || '' })");
  assert.deepEqual([acc.reset, acc.dis, acc.adm], [2, 2, 2], '帳號與救援：自己以外的人類有重設登入、停用、交接管理員');
  assert.match(acc.rescue, /APP_URL=https:\/\/你的網址 npm run admin-rescue[\s\S]*npm run admin-rescue -- --local[\s\S]*DATABASE_URL/, '救援指令：Cloudflare、本機／Docker、Postgres');
  assert.ok(await js("document.querySelector('.adm-acc').getBoundingClientRect().right <= document.querySelector('.adm-main').getBoundingClientRect().right + 1"), '1280 帳號表格沒有超出');
  await shot('5-電腦-帳號與救援');
  await sec('audit', '.adm-store');
  await until(() => js("!!document.querySelector('.adm-audit')"), 8000, '稽核');
  assert.match(await js("document.querySelector('.adm-store').innerText"), /專案文件區：(已|未)開通[\s\S]*訊息附件：(已|未)開通[\s\S]*上傳 24 小時後自動刪除/, '儲存空間狀態、附件保存時間');
  assert.match(await js("document.querySelector('.adm-ttl').innerText"), /訊息附件保存時間[\s\S]*FILE_TTL_HOURS/, '保存時間設定、說明 FILE_TTL_HOURS 只是初始值');
  await shot('6-電腦-稽核與儲存');
  await sec('system', '[data-bk="export"]');
  assert.match(await js("document.querySelector('.adm-main').innerText"), /版本[\s\S]*下載備份[\s\S]*匯入備份/, '系統與備份：版本、下載、匯入');
  await shot('7-電腦-系統與備份');
  await login(liu.token, '/admin/accounts');
  await until(() => js("!!document.querySelector('.adm-nav [data-adm=\"accounts\"].sel')"), 8000, '重新整理停在帳號與救援');
  // 跨專案角色：跟其他變更一起儲存（下面變更列）
  await click(`.adm-acc [data-pm-cross="${id(chen)}"]`);
  await until(() => js("!document.querySelector('#pm-bar').hidden"), 5000, '變更列出現');
  assert.match(await js("document.querySelector('#pm-bar').innerText"), /陳大文[\s\S]*檢查並儲存/, '下方出現「檢查並儲存」');
  await click('[data-pm-act="undo"]');
  // 停用 → 已停用的成員出現在帳號與救援
  assert.equal((await call(liu.token, `/api/participants/${id(chen)}/disable`, 'POST', {})).status < 300, true, '停用陳大文');
  await login(liu.token, '/admin/accounts');
  await until(() => js("/陳大文/.test(document.querySelector('.adm-main .pm-disabled')?.textContent || '')"), 8000, '已停用的成員在帳號與救援');

  // ---------- C 原處改連結 ----------
  await login(liu.token, '/members');
  await until(() => js("!!document.querySelector('.pm-tabs')"), 10000, '成員管理');
  assert.equal(await js("[...document.querySelectorAll('.pm-tabs [data-pm-tab]')].map(b => b.dataset.pmTab).join(',')"), 'members,roles,skills', 'C 成員管理只留成員、角色、技能');
  assert.ok(await js("!document.querySelector('[data-pm-invite]')"), 'C 成員管理裡沒有直接邀請');
  assert.ok(await js("!document.querySelector('.pm-disabled')"), 'C 已停用的成員不再放成員管理');
  await click('.pm-detail [data-adm="invites"]');
  await until(() => js("location.pathname === '/admin/invites'"), 8000, 'C「邀請新的人」開管理員設定 › 邀請');
  await login(liu.token, '/members');
  await until(() => js("!!document.querySelector('[data-pm-view=\"byMember\"]')"), 10000, '成員管理');
  await click('[data-pm-view="byMember"]');
  await until(() => js(`!!document.querySelector('[data-pm-mem="${id(wang)}"]')`), 5000, '依成員');
  await click(`[data-pm-mem="${id(wang)}"]`);
  await until(() => js("!!document.querySelector('.pm-acc-line [data-adm=\"accounts\"]')"), 5000, '帳號區一行');
  assert.ok(await js("!document.querySelector('.pm-detail [data-pm-reset], .pm-detail [data-pm-cross], .pm-detail [data-pm-disable], .pm-detail [data-pm-admin]')"), 'C 成員詳細沒有帳號動作');
  await click('.pm-acc-line [data-adm="accounts"]');
  await until(() => js("location.pathname === '/admin/accounts'"), 8000, 'C 帳號區連到帳號與救援');
  // 舊網址
  for (const t of ['invites', 'projects', 'group', 'system']) {
    await login(liu.token, `/members?tab=${t}`);
    await until(() => js(`location.pathname === '/admin/${t}' && !!document.querySelector('.adm-main')`), 10000, `C 舊網址 ?tab=${t} 轉過去`);
  }
  // 文件頁稽核只看自己的
  assert.equal((await call(liu.token, '/api/files/audit?scope=mine')).body.scope, 'mine', '管理員帶 scope=mine 只看自己的');
  assert.equal((await call(liu.token, '/api/files/audit')).body.scope, 'all', '管理員不帶還是全站（管理員設定用）');
  assert.equal((await call(wang.token, '/api/files/audit')).body.scope, 'mine', '一般人還是只有自己的');

  // ---------- 非管理員：看不到；後端照樣擋 ----------
  await login(wang.token, '/admin/projects');
  await until(() => js("!!document.querySelector('.pm-tabs')"), 10000, 'leader 打 /admin 落到成員管理');
  assert.ok(await js("!document.querySelector('.adm-nav, [data-adm]')"), 'leader 看不到管理員設定');
  const wav = await avItems();
  assert.ok(!wav.includes('admin=') && !wav.includes('pm-projects=') && /perm=👥成員管理/.test(wav), 'leader 頭像只有成員管理：' + wav);
  for (const [u, m, b] of [['/api/invites', 'GET'], ['/api/group', 'PUT', { name: 'x' }], ['/api/group/settings', 'GET'], ['/api/project-deletions', 'GET'], ['/api/participants/disabled', 'GET'], ['/api/admin/backup/status', 'GET']]) assert.equal((await call(wang.token, u, m, b)).status, 403, `非管理員打 ${m} ${u} 照樣擋`);

  // ---------- E 手機 375：一頁清單點進去 ----------
  await size(375, 812);
  await login(liu.token, '/admin');
  await until(() => js("!!document.querySelector('.adm-list')"), 10000, '手機清單');
  const list = await J("[...document.querySelectorAll('.adm-list .adm-li')].map(b => ({ t: b.querySelector('.adm-t b').textContent, sub: getComputedStyle(b.querySelector('.adm-sub')).display !== 'none', go: getComputedStyle(b.querySelector('.adm-go')).display !== 'none' }))");
  assert.equal(list.length, 7, '手機 7 項'); assert.ok(list.every(x => x.sub && x.go), '手機每項有說明和 ›');
  assert.ok(!(await js("!!document.querySelector('.adm-main')")), '手機清單頁還沒有內容');
  assert.ok(!(await hscroll()), '375 清單沒有橫向捲動');
  await shot('8-手機-清單');
  await click('.adm-list [data-adm="projects"]');
  await until(() => js("location.pathname === '/admin/projects' && !!document.querySelector('.adm-main [data-adm-back]') && !!document.querySelector('.pm-ptable')"), 8000, '手機點進專案');
  assert.ok(await js("!document.querySelector('.adm-list')"), '點進去後不顯示清單');
  assert.ok(await js("!document.querySelector('#page-work .work-head')"), '手機點進區塊後不再重複大標');
  assert.ok(!(await hscroll()), '375 專案沒有橫向捲動');
  await shot('9-手機-點進專案');
  await click('[data-adm-back]');
  await until(() => js("!!document.querySelector('.adm-list') && location.pathname === '/admin'"), 5000, '‹ 回清單');
  for (const k of ['todo', 'group', 'invites', 'accounts', 'audit', 'system']) {
    await click(`.adm-list [data-adm="${k}"]`);
    await until(() => js(`location.pathname === '/admin/${k}' && !!document.querySelector('.adm-main')`), 8000, '手機 ' + k);
    await sleep(400);
    if (k === 'accounts' || k === 'todo') await shot(`${k === 'todo' ? '10-手機-待處理' : '11-手機-帳號與救援'}`);
    assert.ok(!(await hscroll()), `375 ${k} 沒有橫向捲動`);
    assert.ok(await js("[...document.querySelectorAll('.adm-main table')].every(t => t.getBoundingClientRect().right <= innerWidth + 1)"), `375 ${k} 表格沒有超出畫面：` + await js("[...document.querySelectorAll('.adm-main table')].map(t => Math.round(t.getBoundingClientRect().right)).join()"));
    await click('[data-adm-back]'); await sleep(150);
  }

  // ---------- 英文介面 ----------
  await size(1280, 900);
  await login(liu.token, '/admin/accounts');
  await js("localStorage.setItem('aigile-lang', 'en'); location.reload(); true");
  await until(() => js("document.documentElement.lang === 'en' && !!document.querySelector('.adm-acc')"), 15000, '英文介面');
  const en = await js("document.querySelector('#page-work').innerText");
  assert.match(en, /Admin settings[\s\S]*To do[\s\S]*Group settings[\s\S]*Accounts & recovery[\s\S]*Audit & storage[\s\S]*System & backup/, '英文目錄');
  assert.match(en, /Everyone's account[\s\S]*Account actions[\s\S]*Rescue command/, '英文帳號與救援');
  assert.match(await js("document.querySelector('.adm-nav [data-adm=\"projects\"] .adm-t b').textContent"), /^Projects$/, '英文目錄寫複數 Projects');
  assert.equal(await js("document.querySelector('.adm-main .pm-disabled [data-pm-enable]')?.textContent"), 'Restore', '已停用成員的按鈕是 Restore（跟說明 After restoring 一致）');
  assert.ok(!/[㐀-鿿]/.test((await js("document.querySelector('.adm-nav').innerText")).replace(/林志明|王小明|陳大文/g, '')), '英文目錄沒有中文：' + await js("document.querySelector('.adm-nav').innerText"));
  await shot('12-電腦-英文-帳號與救援');
  await js("localStorage.removeItem('aigile-lang'); true");
  console.log('admin-settings-ui-test：全部通過');
} catch (e) {
  console.error('admin-settings-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally { await kit.stop(); }
