// PLAT-381：專案 leader 管自己的專案，日常待處理先給 leader（UX #6431，昱志兩題都選 A）
// A. 後端：改名、封存、還原放給「管理員或這個專案的 leader」；新增、永久刪除、邀請仍限管理員；不是 leader 的打 API 被擋
// B. 頭像選單：leader 有「📁 專案管理 · 你負責的 N 個專案」；管理員照舊（管理員設定、專案管理捷徑）；一般成員沒有「管理」區
// C. leader 的專案管理頁（/projects）：只列自己當 leader 的專案，沒有新增；⋯ 有改名、程式庫、成員、封存，永久刪除灰掉
// D. 專案旁 ⚙：leader 跟管理員一樣有改名、程式庫與分支、成員與本專案角色；封存不放 ⚙（昱志 11/21 選 A），只在專案管理頁
// E. 要你處理：leader 最上面「👑 你負責的專案」放加入申請、技能核准；管理員 1 天內看不到，超過 1 天才出現並註明「leader 還沒處理」
// F. 1280、375 不橫向捲動
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 PLAT381_SHOTS=資料夾 會另外截圖。用法：node scripts/plat381-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('plat381-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('o381');
try {
  const { call } = kit;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('劉昱志', 'PO'), wang = await join('王小明', 'UX'), chen = await join('陳大文', 'PG'), lee = await join('李小華', 'QA');
  const id = p => p.participant.participantId;
  for (const p of [wang, chen]) await call(liu.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: ['預設專案'] });
  const np = await call(liu.token, '/api/projects', 'POST', { name: '測試專案' });
  assert.equal(np.status, 201, JSON.stringify(np.body));
  const TP = np.body.id;
  await call(liu.token, `/api/participants/${id(wang)}/projects`, 'PUT', { projects: ['預設專案', TP] });
  assert.equal((await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(wang), leaderOf: ['預設專案', TP] }] })).status, 200, 'wang 當預設專案、測試專案 leader');

  // ---------- A 後端權限 ----------
  assert.equal((await call(wang.token, '/api/projects/預設專案', 'PATCH', { name: '預設專案二' })).status, 200, 'leader 能改自己專案的名稱');
  assert.equal((await call(wang.token, '/api/projects/預設專案', 'PATCH', { name: '預設專案' })).status, 200, '改回來');
  for (const [who, tok] of [['一般成員', chen.token], ['別的專案的 leader', wang.token]]) {
    const pj = who === '一般成員' ? '預設專案' : '第二專案';
    assert.equal((await call(tok, `/api/projects/${encodeURIComponent(pj)}`, 'PATCH', { name: 'x' })).status, 403, `${who}不能改名`);
    assert.equal((await call(tok, `/api/projects/${encodeURIComponent(pj)}/archive`, 'POST')).status, 403, `${who}不能封存`);
    assert.equal((await call(tok, `/api/projects/${encodeURIComponent(pj)}/unarchive`, 'POST')).status, 403, `${who}不能還原`);
  }
  assert.equal((await call(wang.token, '/api/projects', 'POST', { name: '偷建' })).status, 403, 'leader 不能新增專案');
  assert.equal((await call(wang.token, '/api/invites', 'POST', { name: '某人', projects: ['預設專案'], ttl: '1h' })).status, 403, 'leader 不能發邀請');
  assert.equal((await call(wang.token, `/api/projects/${encodeURIComponent(TP)}/archive`, 'POST')).status, 200, 'leader 能封存自己的專案');
  const pv = (await call(wang.token, '/api/projects')).body;
  assert.ok(pv.items.find(p => p.id === TP)?.archived, '已封存：' + JSON.stringify(pv.items.map(p => [p.id, p.name, p.archived])));
  assert.deepEqual(pv.archivedLeaders?.[TP], [id(wang)], '封存的專案也帶 leader（前端才能讓 leader 還原）');
  assert.equal((await call(chen.token, `/api/projects/${encodeURIComponent(TP)}/unarchive`, 'POST')).status, 403, '不是 leader 不能還原');
  assert.equal((await call(wang.token, `/api/projects/${encodeURIComponent(TP)}/delete-preview`)).status, 403, 'leader 不能永久刪除');
  assert.equal((await call(wang.token, `/api/projects/${encodeURIComponent(TP)}/unarchive`, 'POST')).status, 200, 'leader 能還原自己的專案');

  // 待處理：預設專案（有 leader）、第二專案（沒有 leader）各一個加入申請；預設專案一個含腳本的技能
  for (const pj of ['預設專案', '第二專案']) assert.equal((await call(liu.token, `/api/projects/${encodeURIComponent(pj)}/join-settings`, 'PUT', { open: true, note: '歡迎' })).status, 200);
  assert.ok((await call(lee.token, '/api/projects/預設專案/join-requests', 'POST', { note: '想幫忙測試搜尋功能' })).status < 300, 'lee 申請預設專案');
  assert.ok((await call(lee.token, '/api/projects/第二專案/join-requests', 'POST', { note: '想看看' })).status < 300, 'lee 申請第二專案');
  const sk = await call(chen.token, '/api/projects/預設專案/skills', 'POST', { files: [{ path: 'SKILL.md', text: '---\nname: deploy-check\ndescription: 部署前檢查\n---\n照著做\n' }, { path: 'scripts/run.sh', text: 'echo hi\n' }] });
  assert.equal(sk.body.status, 'pending', '含腳本、一般成員上傳 → 等核准');
  const wj = (await call(wang.token, '/api/join-requests')).body.items;
  assert.deepEqual(wj.map(j => j.project), ['預設專案'], 'leader 只看到自己專案的申請');

  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const txt = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const click = sel => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.PLAT381_SHOTS) return; await sleep(250); fs.mkdirSync(process.env.PLAT381_SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.PLAT381_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
  const avItems = async () => {
    await until(() => js("(() => { const m = document.querySelector('#av-menu'); if (m.hidden) document.querySelector('.topbar .av-btn')?.click(); return !m.hidden && !!m.querySelector('[data-av=\"logout\"]'); })()"), 8000, '頭像選單');
    return js("[...document.querySelectorAll('#av-menu [data-av]')].map(b => b.dataset.av + '=' + b.textContent.trim()).join('|')");
  };
  const avClose = () => js("(() => { const m = document.querySelector('#av-menu'); if (!m.hidden) document.querySelector('.topbar .av-btn')?.click(); return true; })()");

  for (const w of [1280, 375]) {
    const L = w + ' ', tag = w === 1280 ? '電腦' : '手機';
    await size(w, w === 1280 ? 900 : 760);
    // ---------- B leader 的頭像選單 ----------
    await login(wang.token, '/');
    await until(() => js("!!document.querySelector('.topbar .av-btn')"), 10000, L + '登入');
    let av = '';
    await until(async () => { await avClose(); av = await avItems(); return av.includes('lead-projects='); }, 10000, L + '頭像選單等 leader 資料載入'); // 全套時偶爾在資料到之前就打開選單
    assert.match(av, /lead-projects=📁專案管理你負責的 2 個專案/, L + 'leader 有專案管理：' + av);
    assert.ok(!av.includes('admin=') && !av.includes('pm-projects='), L + 'leader 沒有管理員設定：' + av);
    assert.ok(av.indexOf('lead-projects=') < av.indexOf('perm='), L + '專案管理在成員管理上面');
    await shot(`PLAT-381-1-${tag}-leader-頭像選單`);
    // ---------- C leader 的專案管理頁 ----------
    await click('#av-menu [data-av="lead-projects"]');
    await until(() => js("location.pathname === '/projects' && !!document.querySelector('.pm-ptable')"), 8000, L + '專案管理頁');
    assert.match(await txt('.work-title'), /📁 專案管理 你是 leader 的專案 · 新增、永久刪除專案請找管理員 劉昱志/, L + '標題與副標');
    assert.deepEqual(await J("[...document.querySelectorAll('.pm-prow .c-pname b')].map(b => b.textContent)"), ['預設專案', '測試專案'], L + '只列自己當 leader 的專案');
    assert.equal(await js("!!document.querySelector('[data-pm-newproj], .adm-nav')"), false, L + '沒有新增專案、沒有管理員設定左欄');
    assert.match(await js("document.querySelector('#crumbs')?.textContent || ''"), /專案管理/, L + '麵包屑');
    await click('[data-pm-more="預設專案"]');
    await until(() => js("!!document.querySelector('.pm-more-menu')"), 5000, L + '⋯ 選單');
    const mi = await J("[...document.querySelectorAll('.pm-more-menu [role=menuitem]')].map(b => b.innerText.replace(/\\s+/g, ' ').trim())");
    assert.deepEqual(mi.map(x => x.replace(/^\S+\s*/, '').split(' ')[0]), ['改名', '程式庫與分支', '成員與本專案角色', '異動紀錄', '封存專案', '永久刪除'], L + '⋯ 選單：' + mi.join(' / '));
    assert.match(mi[5], /只有管理員/, L + '永久刪除寫只有管理員');
    assert.equal(await js("document.querySelector('.pm-more-menu [data-pp=\"archive\"]').classList.contains('danger')"), false, L + '封存可還原，用一般色（UX #6479）');
    assert.equal(await js("document.querySelector('.pm-more-menu [data-pp=\"noop\"]').getAttribute('aria-disabled')"), 'true', L + '永久刪除灰掉');
    assert.ok(!(await hscroll()), L + '專案管理頁不橫向捲動');
    await shot(`PLAT-381-2-${tag}-leader-專案管理頁`);
    await js("document.body.click(); true");
    // ---------- D 專案旁 ⚙ ----------
    await login(wang.token, '/p/main/messages');
    await until(() => js("!!document.querySelector('[data-pset=\"預設專案\"]')"), 10000, L + '專案 ⚙');
    await js("(() => { const b = document.querySelector('[data-pset=\"預設專案\"]'); b.scrollIntoView(); b.click(); return true; })()");
    await until(() => js("!document.querySelector('#pset-menu')?.hidden"), 5000, L + '⚙ 選單');
    const ps = await J("[...document.querySelectorAll('#pset-menu [data-pset-act]')].map(b => b.dataset.psetAct + '=' + b.innerText.replace(/\\s+/g, ' ').trim())");
    assert.deepEqual(ps.map(x => x.split('=')[0]), ['rename', 'repo', 'members', 'kbai'], L + 'leader 的 ⚙（沒有封存）：' + ps.join(' / '));
    await shot(`PLAT-381-3-${tag}-leader-專案齒輪`);
    await js("document.body.click(); true");
    // ---------- E leader 的要你處理 ----------
    await login(wang.token, '/p/main/inbox');
    await until(() => js("document.querySelectorAll('.wlead .lead-row').length === 2"), 10000, L + '👑 你負責的專案（申請＋技能）');
    const lead = await txt('.wlead');
    assert.match(lead, /👑 你負責的專案\s*2/, L + '標題與件數：' + lead);
    assert.match(lead, /你是「預設專案」的 leader，這些由你處理；超過 1 天沒處理，會提醒管理員。/, L + '說明');
    assert.match(lead, /加入申請：李小華\s*想加入「預設專案」.*想幫忙測試搜尋功能/, L + '加入申請');
    assert.match(lead, /技能待核准：deploy-check\s*預設專案 · 含腳本 1 個 · 陳大文上傳/, L + '技能待核准');
    assert.equal(await js("document.querySelector('.wlead').previousElementSibling === null || !document.querySelector('.wlead').previousElementSibling.matches('.wsugg')"), true, L + '放在最上面');
    assert.ok(Number(await js("document.querySelector('.inbox-badge:not([hidden])')?.textContent || 0")) >= 2, L + '左側紅點算進去');
    assert.equal(await js("[...document.querySelectorAll('.sec-note')].some(n => n.textContent.includes('申請加入'))"), false, L + '同一筆申請不再出現在「給你知道的」（UX #6479）');
    assert.equal(await js("!!document.querySelector('.inbox-block-title')"), false, L + '「給你知道的」不再重複兩次');
    assert.ok(!(await hscroll()), L + '要你處理不橫向捲動');
    await shot(`PLAT-381-4-${tag}-leader-要你處理`);
    // ---------- 管理員：1 天內看不到預設專案的；沒有 leader 的第二專案直接給管理員；超過 1 天才出現 ----------
    await login(liu.token, '/');
    await until(() => js("!!document.querySelector('.topbar .av-btn')"), 10000, L + '管理員登入');
    const lav = await avItems();
    assert.match(lav, /pm-projects=📁專案管理新增、改名、封存/, L + '管理員照舊有專案管理捷徑：' + lav);
    assert.ok(!lav.includes('lead-projects='), L + '管理員不用 leader 版');
    await shot(`PLAT-381-5-${tag}-管理員-頭像選單`);
    await avClose();
    await login(liu.token, '/p/main/messages');
    await until(() => js("!!document.querySelector('[data-pset=\"預設專案\"]')"), 10000, L + '管理員的專案 ⚙');
    await js("(() => { const b = document.querySelector('[data-pset=\"預設專案\"]'); b.scrollIntoView(); b.click(); return true; })()");
    await until(() => js("!document.querySelector('#pset-menu')?.hidden"), 5000, L + '管理員 ⚙ 選單');
    assert.equal(await js("[...document.querySelectorAll('#pset-menu [data-pset-act]')].map(b => b.dataset.psetAct).join(',')"), 'rename,repo,members,kbai', L + '管理員的 ⚙ 跟 leader 一樣、沒有封存');
    await shot(`PLAT-381-5b-${tag}-管理員-專案齒輪`);
    await js("document.body.click(); true");
    await login(liu.token, '/p/main/inbox');
    await until(() => js("document.querySelector('.work-title') && !document.querySelector('.wlead')"), 10000, L + '管理員的預設專案要你處理沒有 leader 那區');
    await login(liu.token, '/p/second/inbox');
    await until(() => js("!!document.querySelector('.wlead')"), 10000, L + '沒有 leader 的專案直接給管理員');
    assert.match(await txt('.wlead'), /🛡 專案待處理\s*1.*加入申請：李小華\s*想加入「第二專案」/, L + '管理員看到第二專案的申請');
    // 時間往後 25 小時（只改這個頁面的 Date.now，再切到「要你處理」重畫）：預設專案的申請、技能出現在管理員那邊，註明 leader 還沒處理
    await login(liu.token, '/p/main/messages');
    await until(() => js("!!document.querySelector('[data-nav=\"inbox\"]')"), 10000, L + '管理員進預設專案');
    await sleep(500);
    await js("(() => { const n = Date.now.bind(Date); Date.now = () => n() + 25 * 3600 * 1000; document.querySelector('[data-nav=\"inbox\"]').click(); return true; })()");
    await until(() => js("!!document.querySelector('.wlead')"), 10000, L + '超過 1 天出現在管理員的要你處理');
    const late = await txt('.wlead');
    assert.match(late, /🛡 專案待處理\s*2.*加入申請：李小華.*leader 王小明 還沒處理.*技能待核准：deploy-check.*leader 王小明 還沒處理/, L + '註明 leader 還沒處理：' + late);
    await shot(`PLAT-381-6-${tag}-管理員-超過1天`);
    // ---------- 一般成員 ----------
    await login(chen.token, '/p/main/messages');
    await until(() => js("!!document.querySelector('.topbar .av-btn')"), 10000, L + '一般成員');
    const cav = await avItems();
    assert.ok(!/lead-projects=|admin=|pm-projects=|perm=/.test(cav), L + '一般成員沒有管理區：' + cav);
    assert.equal(await js("!!document.querySelector('[data-pset]')"), false, L + '一般成員沒有專案 ⚙');
    await shot(`PLAT-381-7-${tag}-一般成員-頭像選單`);
    await avClose();
    assert.equal((await call(chen.token, '/api/projects/預設專案', 'PATCH', { name: 'x' })).status, 403);
  }

  // ---------- 英文介面（開源版）：專案管理頁、⋯ 選單、「👑 你負責的專案」都是英文，沒有中文殘留（人名、專案名除外）----------
  await size(1280, 900);
  await login(wang.token, '/');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  const zhLeft = t => (t.replace(/預設專案|第二專案|測試專案|劉昱志|王小明|陳大文|李小華|想幫忙測試搜尋功能/g, '').match(/[一-鿿]+/g) || []);
  await login(wang.token, '/projects');
  await until(() => js("document.documentElement.lang === 'en' && !!document.querySelector('.pm-ptable')"), 10000, '英文專案管理頁');
  const enP = await txt('#page-work');
  assert.match(enP, /Projects you lead · ask the admin 劉昱志 to add or permanently delete projects/, '英文副標：' + enP.slice(0, 200));
  assert.match(enP, /Projects you lead · 2/, '英文卡片標題（跟要你處理同一個說法，UX #6595）');
  await click('[data-pm-more="預設專案"]');
  await until(() => js("!!document.querySelector('.pm-more-menu')"), 5000, '英文 ⋯ 選單');
  const enM = await txt('.pm-more-menu');
  assert.match(enM, /Rename[\s\S]*Repository and branch[\s\S]*Members and project roles[\s\S]*Change log[\s\S]*Archive project[\s\S]*Can be restored[\s\S]*Delete permanently[\s\S]*Admins only/, '英文 ⋯：' + enM);
  assert.deepEqual(zhLeft(enP + ' ' + enM), [], '專案管理頁沒有中文殘留');
  await shot('PLAT-381-8-電腦-英文-leader-專案管理頁');
  await js("document.body.click(); true");
  await login(wang.token, '/p/main/inbox');
  await until(() => js("document.querySelectorAll('.wlead .lead-row').length === 2"), 10000, '英文要你處理');
  const enL = await txt('.wlead');
  assert.match(enL, /👑 Projects you lead\s*2[\s\S]*You're the project lead of "Default project"[\s\S]*Join request: 李小華\s*wants to join "Default project" · Just now[\s\S]*Reject\s*Approve[\s\S]*Skill awaiting approval: deploy-check\s*Default project · 1 script · uploaded by 陳大文 · Just now\s*View\s*Approve/, '英文「你負責的專案」：' + enL);
  assert.deepEqual(zhLeft(enL), [], '「你負責的專案」沒有中文殘留：' + enL);
  await shot('PLAT-381-9-電腦-英文-leader-要你處理');
  await login(wang.token, '/');
  await js("localStorage.setItem('aigile-lang', 'zh'); true");

  // 核准技能、拒絕申請（leader 在要你處理直接做）
  await size(1280, 900);
  await login(wang.token, '/p/main/inbox');
  await until(() => js("!!document.querySelector('[data-lead-skok]')"), 10000, '技能核准鈕');
  await click('[data-lead-skok]');
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '確認視窗');
  await click('.confirm-root [data-ok]');
  await until(async () => (await call(wang.token, `/api/skills/${sk.body.skillId}`)).body.status === 'published', 8000, 'leader 核准上架');
  await until(() => js("!document.querySelector('[data-lead-skok]')"), 8000, '核准後從要你處理拿掉');
  await click('[data-lead-jno]');
  await until(() => js("!!document.querySelector('#jr-reason')"), 5000, '拒絕原因');
  await js("(() => { const t = document.querySelector('#jr-reason'); t.value = '名額滿了'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-jx=\"1\"]').click(); return true; })()");
  await until(async () => !(await call(wang.token, '/api/join-requests')).body.items.length, 8000, 'leader 拒絕申請');
  await until(() => js("!document.querySelector('.wlead')"), 8000, '處理完那區收起');
  console.log('plat381-ui-test：全部通過');
} catch (e) {
  console.error('plat381-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
