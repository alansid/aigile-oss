// 畫面測試（真的瀏覽器，PLAT-365）：「＋ 新增技能」視窗／空專案卡的範本 → 套用（改內容）→ 上架 → 卡片標「📚 來自範本 v1」
// → 範本有新版時卡片標「範本有新版」、抽屜有「看範本新版」，打開會附目前的 SKILL.md 對照、發給誰沿用原本的
// 範本 6 個起有搜尋、分類、推薦；一般成員不能套用；手機 375 不橫向捲動；英文介面給英文範本
// 用法：node scripts/skill-template-ui-test.js（找不到 Chrome／Edge 就略過）
// 截圖：設 SKILL_TPL_SHOT=<資料夾> 就把各步驟存成 PNG（給 UX 驗收，全是假資料）
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('skill-template-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('tplui');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 管理員
  const wang = (await kit.call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' })).body; // 一般成員
  await kit.call(boss.token, `/api/participants/${wang.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  const { js, login, cdp } = await kit.browser(1280, 900);
  const txt = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const openLib = async (who, lang = 'zh') => {
    await login(who.token, '/');
    await js(`localStorage.setItem('aigile-lang', '${lang}'); true`);
    await login(who.token, '/my-ai');
    await until(() => js("!!document.querySelector('#ma-skills')"), 10000, '技能庫入口');
    await click('#ma-skills');
    await until(() => js("!!document.querySelector('.sk-view .sk-grid')"), 10000, '技能庫');
  };
  const noHScroll = async w => assert.ok(await js('document.documentElement.scrollWidth') <= w + 1, `${w} 寬不橫向捲動`);
  const SHOT = process.env.SKILL_TPL_SHOT;
  const shot = async (name, sel = null, block = 'start') => {
    if (!SHOT) return;
    if (sel) await js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: '${block}' }), true`);
    await new Promise(r => setTimeout(r, 300));
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOT, { recursive: true });
    fs.writeFileSync(path.join(SHOT, name), Buffer.from(r.result.data, 'base64'));
  };

  // 1. 一般成員：右上是「＋ 新增技能」；空專案卡沒有範本（不能套用）；新增視窗只能上傳自己的
  await openLib(wang);
  await until(() => js("!!document.querySelector('.sk-view .sk-rule')"), 5000, '技能庫畫完');
  assert.equal(await txt('.sk-bar [data-sknew]'), '＋ 新增技能');
  assert.equal(await js("!!document.querySelector('.sk-view [data-sktpl]')"), false, '一般成員的空專案卡沒有範本');
  await click('.sk-bar [data-sknew]');
  await until(() => js("!!document.querySelector('.sk-new-up')"), 8000, '新增視窗');
  assert.match(await txt('#sk-new-list'), /只有預設專案的 leader 或管理員能套用範本/);
  assert.equal(await js("!!document.querySelector('#sk-new-list [data-sktpl]')"), false);
  await click('[data-sknew-up]');
  await until(() => js("!!document.querySelector('#sk-pj')"), 8000, '選檔案接上傳視窗');

  // 2. 管理員：底部範本區拿掉；預設專案空卡列推薦 3 個範本＋看全部＋上傳自己的
  await openLib(boss);
  await until(() => js("!!document.querySelector('[data-sktpl-pj=\"預設專案\"]')"), 8000, '預設專案空卡有範本');
  assert.equal(await js("!!document.querySelector('.sk-tpl-sec')"), false, '底部範本區拿掉');
  const emptyCard = "[...document.querySelectorAll('.sk-empty')].find(c => c.querySelector('[data-sktpl-pj=\"預設專案\"]'))";
  assert.match(await js(`${emptyCard}.textContent`), /從範本開始，一鍵複製到預設專案，之後可以改：/);
  assert.deepEqual(await js(`[...${emptyCard}.querySelectorAll('[data-sktpl]')].map(b => b.dataset.sktpl)`), ['commit-convention', 'testing-rules', 'handover-format'], '依 PG 推薦 3 個');
  assert.match(await js(`${emptyCard}.textContent`), /看全部範本 ›[\s\S]*或 上傳自己的 SKILL\.md ›/);
  assert.equal(await js("document.querySelectorAll('.sk-empty').length"), 1, '「全部」只出一張空專案卡（UX #6576）');
  assert.match(await js(`${emptyCard}.textContent`), /還有 1 個專案沒有技能：第二專案/, '其他沒技能的專案只列名字');
  await shot('PLAT-365-B1-空專案卡-1280.png', '.sk-empty');
  await openLib(boss, 'en'); // 英文：其他沒技能的專案那行也是英文
  await until(() => js("document.documentElement.lang === 'en' && !!document.querySelector('.sk-empty-more')"), 8000, '英文空專案卡');
  assert.match(await js("document.querySelector('.sk-empty-more').textContent"), /^1 more project without skills: Second project$/, '英文：' + await js("document.querySelector('.sk-empty-more').textContent"));
  await openLib(boss);
  // 「＋ 新增技能」：範本 6 個 → 有搜尋、分類，預設推薦 3 個、其餘收起
  await js(`document.querySelector('.sk-bar [data-sknew]').dataset.sknew = '預設專案'; true`);
  await click('.sk-bar [data-sknew]');
  await until(() => js("document.querySelectorAll('.sk-new-row').length === 3"), 8000, '推薦 3 個');
  assert.match(await txt('.sk-new-rech'), /⭐ 推薦給「預設專案」.*依專案裡 AI 的角色挑/);
  assert.equal(await txt('#sk-new-list [data-sknew-all]'), '看全部 6 個範本 ▾');
  assert.ok(await js("!!document.querySelector('#sk-new-q') && document.querySelectorAll('[data-sknew-cat]').length >= 4"), '有搜尋與分類');
  assert.match(await txt('.sk-new-up'), /上傳自己的 SKILL\.md/);
  await click('[data-sknew-peek="commit-convention"]');
  assert.match(await txt('.sk-new-pre'), /name: commit-convention/, '預覽展開全文');
  await click('[data-sknew-peek="commit-convention"]');
  await shot('PLAT-365-B2-新增視窗-推薦-1280.png');
  // 搜尋：列表變精簡、點一列在右邊看全文
  await js("(() => { const q = document.querySelector('#sk-new-q'); q.focus(); q.value = '測試'; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await until(() => js("document.querySelectorAll('.sk-new-item').length >= 1"), 5000, '搜尋結果');
  assert.match(await txt('.sk-new-rech'), /找到 \d+ 個/);
  assert.equal(await js("document.activeElement.id"), 'sk-new-q', '打字時焦點留在搜尋框');
  assert.match(await txt('.sk-new-pv'), /testing-rules · v1 · 內建範本/);
  assert.match(await txt('.sk-new-pv [data-sktpl]'), /^套用到預設專案$/);
  await shot('PLAT-365-B3-搜尋與預覽-1280.png');
  // 分類：安全只有 1 個；點列換預覽
  await js("(() => { const q = document.querySelector('#sk-new-q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await click('[data-sknew-cat="security"]');
  await until(() => js("document.querySelectorAll('.sk-new-item').length === 1"), 5000, '安全分類');
  assert.match(await txt('.sk-new-pv'), /security-checklist/);
  await click('[data-sknew-cat=""]');
  await until(() => js("document.querySelectorAll('.sk-new-item').length === 6"), 5000, '全部 6 個');
  await click('[data-sknew-sel="report-and-ask"]');
  assert.match(await txt('.sk-new-pv'), /report-and-ask/, '點一列換右邊預覽');
  // 按列上的「套用」→ 接套用視窗，專案已選好
  await click('.sk-new-item [data-sktpl="commit-convention"]');
  await until(() => js("!!document.querySelector('#sk-ap-text')"), 8000, '套用彈窗');
  assert.equal(await js("document.querySelector('#sk-ap-pj').value"), '預設專案');
  assert.match(await txt('.sk-up-sec .field-hint'), /最上面幾行請保留，平台靠它知道這個技能來自哪個範本，有新版時才提醒得到你/);
  const text = await js("document.querySelector('#sk-ap-text').value");
  assert.match(text, /^---\nname: commit-convention\n/, '編輯框是範本 SKILL.md');
  assert.match(text, /aigile-template: commit-convention@1/);
  assert.equal(await js("document.querySelector('[data-sksend]').disabled"), false, '可以直接上架');
  // 先改內容：把 50 字改成 40 字
  await js("(() => { const t = document.querySelector('#sk-ap-text'); t.value = t.value.replace('第一行 50 字內', '第一行 40 字內'); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await shot('PLAT-365-2-套用編輯-1280.png');
  // name 改壞 → 不能送
  await js("(() => { const t = document.querySelector('#sk-ap-text'); t.dataset.keep = t.value; t.value = t.value.replace('name: commit-convention', 'name: Bad Name'); t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  assert.equal(await js("document.querySelector('[data-sksend]').disabled"), true, 'name 不合法不能送');
  assert.match(await txt('#sk-up-note'), /要有 name/);
  await js("(() => { const t = document.querySelector('#sk-ap-text'); t.value = t.dataset.keep; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await click('[data-sksend]');
  await until(() => js("!!document.querySelector('.sk-ok')"), 8000, '上架成功');
  const list = (await kit.call(boss.token, '/api/skills')).body.items;
  const sk = list.find(x => x.name === 'commit-convention');
  assert.equal(sk.status, 'published'); assert.equal(sk.template?.name, 'commit-convention');
  const full = (await kit.call(boss.token, `/api/skills/${sk.skillId}`)).body;
  assert.match(full.files[0].text, /第一行 40 字內/, '上架的是改過的內容');

  // 3. 回到技能庫：卡片標「📚 來自範本 v1」；新增視窗標「預設專案已套用 v1」、按鈕「再套一次」；「只看還沒套用的」藏起來
  await click('[data-sk-fin]');
  await until(() => js("[...document.querySelectorAll('.sk-card')].some(c => c.textContent.includes('📚 來自範本 v1'))"), 8000, '卡片標範本 v1');
  await shot('PLAT-365-3-卡片範本標籤-1280.png', '.sk-card');
  await js(`document.querySelector('.sk-bar [data-sknew]').dataset.sknew = '預設專案'; true`);
  await click('.sk-bar [data-sknew]');
  await until(() => js("!!document.querySelector('.sk-new-row [data-sktpl=\"commit-convention\"]')"), 8000, '新增視窗');
  assert.equal(await js("document.querySelector('#sk-new-pj').value"), '預設專案');
  assert.equal(await txt('.sk-new-row [data-sktpl="commit-convention"]'), '再套一次');
  assert.match(await js("document.querySelector('.sk-new-row [data-sktpl=\"commit-convention\"]').closest('.sk-new-row').textContent"), /預設專案已套用 v1/);
  await shot('PLAT-365-B4-已套用再套一次-1280.png');
  await click('#sk-new-list [data-sknew-all]');
  await until(() => js("document.querySelectorAll('.sk-new-item').length === 6"), 5000, '看全部');
  await click('#sk-new-unused');
  await until(() => js("document.querySelectorAll('.sk-new-item').length === 5"), 5000, '只看還沒套用的');
  assert.equal(await js("!!document.querySelector('[data-sknew-sel=\"commit-convention\"]')"), false);
  await click('[data-skcancel]');

  // 4. 範本有新版（模擬專案套用的是舊版 @0，並指定給 PG）：卡片標、抽屜有按鈕、打開附目前內容、發給誰沿用
  const old = full.files[0].text.replace('commit-convention@1', 'commit-convention@0');
  const up = await kit.call(boss.token, '/api/projects/預設專案/skills', 'POST', { files: [{ path: 'SKILL.md', text: old }, { path: 'templates.md', text: '範例' }], roles: ['PG'] });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  await openLib(boss);
  await until(() => js("[...document.querySelectorAll('.sk-card')].some(c => c.textContent.includes('範本有新版'))"), 8000, '卡片標範本有新版');
  await shot('PLAT-365-4a-卡片範本有新版-1280.png', '.sk-card');
  // 新增視窗的範本列：標「範本有新版」、按鈕變「更新」
  await js(`document.querySelector('.sk-bar [data-sknew]').dataset.sknew = '預設專案'; true`);
  await click('.sk-bar [data-sknew]');
  await until(() => js("!!document.querySelector('.sk-new-row [data-sktpl=\"commit-convention\"]')"), 8000, '新增視窗');
  assert.equal(await txt('.sk-new-row [data-sktpl="commit-convention"]'), '更新');
  assert.match(await js("document.querySelector('.sk-new-row [data-sktpl=\"commit-convention\"]').closest('.sk-new-row').textContent"), /預設專案已套用 v0[\s\S]*範本有新版/);
  assert.equal(await txt('.sk-new-row [data-sktpl="testing-rules"]'), '套用', '沒套用過的照舊是「套用」');
  await click('[data-skcancel]');
  await until(() => js("!!document.querySelector('.sk-view .sk-card')"), 8000, '回技能庫');
  await js(`document.querySelector('[data-skc="${up.body.skillId}"]').click(), true`);
  await until(() => js("!!document.querySelector('[data-sktplup]')"), 8000, '抽屜有看範本新版');
  assert.match(await txt('.sk-drawer'), /來自範本第 0 版，範本已經有第 1 版：commit-convention/);
  await shot('PLAT-365-4b-抽屜看範本新版-1280.png', '[data-sktplup]', 'end');
  await click('[data-sktplup]');
  await until(() => js("!!document.querySelector('#sk-ap-cur .sk-alert')"), 8000, '附目前版本對照');
  assert.match(await txt('#sk-ap-cur .sk-alert'), /已經有「commit-convention」第 2 版.*上架後會成為第 3 版.*其他 1 個檔照留/);
  assert.match(await js("document.querySelector('#sk-ap-text').value"), /commit-convention@1/, '編輯框是範本新版');
  assert.equal(await js("document.querySelector('#sk-to [data-sk-mode=\"roles\"]').getAttribute('aria-checked')"), 'true', '發給誰沿用原本的（指定角色）');
  assert.equal(await js("document.querySelector('#sk-to [data-skrole=\"PG\"]').getAttribute('aria-pressed')"), 'true');
  assert.match(await txt('#sk-up-note'), /會成為「commit-convention」第 3 版/);
  // 「看目前的」預設收起、有展開箭頭；編輯框上有標題講清楚框裡是範本新內容（UX 4c）
  assert.equal(await js("document.querySelector('#sk-ap-cur .sk-ap-old').open"), false, '目前版本預設收起');
  assert.equal(await js("getComputedStyle(document.querySelector('#sk-ap-cur .sk-ap-old summary'), '::before').content"), '"▸"');
  assert.equal(await txt('#sk-ap-cur .sk-ap-new'), '新內容（範本第 1 版，可先改）');
  await shot('PLAT-365-4c-更新時對照目前版本-1280.png');
  await click('[data-sksend]');
  await until(() => js("!!document.querySelector('.sk-ok')"), 8000, '更新成功');
  const v3 = (await kit.call(boss.token, '/api/skills')).body.items.find(x => x.name === 'commit-convention');
  assert.equal(v3.version, 3); assert.equal(v3.template.outdated, false, '更新後不再標新版');
  assert.deepEqual((await kit.call(boss.token, `/api/skills/${v3.skillId}`)).body.files.map(f => f.path).sort(), ['SKILL.md', 'templates.md'], '其他檔照留');

  // 5. 手機 375：新增視窗、看全部與套用彈窗不橫向捲動
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 760, deviceScaleFactor: 1, mobile: true });
  await openLib(boss);
  assert.equal(await js('innerWidth'), 375);
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '手機技能庫不橫向捲動');
  await shot('PLAT-365-B1-空專案卡-375.png', '.sk-empty');
  await js(`document.querySelector('.sk-bar [data-sknew]').dataset.sknew = '預設專案'; true`);
  await click('.sk-bar [data-sknew]');
  await until(() => js("document.querySelectorAll('.sk-new-row').length === 3"), 8000, '手機新增視窗');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '手機新增視窗不橫向捲動');
  assert.ok(await js("[...document.querySelectorAll('.sk-new-row .btn')].every(b => b.getBoundingClientRect().right <= innerWidth)"), '按鈕在畫面內');
  await shot('PLAT-365-B2-新增視窗-375.png');
  await click('#sk-new-list [data-sknew-all]');
  await until(() => js("!!document.querySelector('.sk-new-pv')"), 5000, '手機看全部');
  assert.ok(await js("document.querySelector('.sk-new-pv').getBoundingClientRect().right <= innerWidth"), '預覽在畫面內');
  assert.match(await txt('.sk-new-rech'), /點一列在下方看全文/, '手機預覽在下方');
  await shot('PLAT-365-B3-看全部-375.png');
  await click('.sk-new-item [data-sktpl="testing-rules"]');
  await until(() => js("!!document.querySelector('#sk-ap-text')"), 8000, '手機套用彈窗');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '手機套用彈窗不橫向捲動');
  assert.ok(await js("document.querySelector('#sk-ap-text').getBoundingClientRect().right <= innerWidth"), '編輯框在畫面內');
  await shot('PLAT-365-2-套用編輯-375.png');
  await cdp('Emulation.clearDeviceMetricsOverride');

  // 6. 英文介面：按鈕、卡片標籤、新增視窗都是英文；編輯框是英文範本
  await openLib(boss, 'en');
  await until(() => js("document.documentElement.lang === 'en' && !!document.querySelector('.sk-view .sk-card')"), 8000, '英文技能庫');
  assert.equal(await txt('.sk-bar [data-sknew]'), '+ Add skill');
  assert.match(await js("[...document.querySelectorAll('.sk-card')].map(c => c.textContent).join(' ')"), /📚 From template v1/);
  // 英文狀態標籤（Published）較長：卡名換行、不被截成「commit-convent…」
  assert.ok(await js("[...document.querySelectorAll('.sk-card .sk-nm')].every(e => e.scrollWidth <= e.clientWidth + 1)"), '英文卡名完整顯示');
  await shot('PLAT-365-6-卡片-英文-1280.png', '.sk-card');
  await js(`document.querySelector('.sk-bar [data-sknew]').dataset.sknew = '預設專案'; true`);
  await click('.sk-bar [data-sknew]');
  await until(() => js("document.querySelectorAll('.sk-new-row').length === 3"), 8000, '英文新增視窗');
  const enText = await js("document.querySelector('.modal').innerText");
  assert.match(enText, /Add skill[\s\S]*Recommended for[\s\S]*See all 6 templates[\s\S]*Upload your own SKILL\.md/);
  const left = enText.replace(/預設專案|程式開發/g, '').match(/[一-鿿]+/g);
  assert.ok(!left, '新增視窗沒有中文殘留：' + (left || []).join(' '));
  await shot('PLAT-365-B2-新增視窗-英文-1280.png');
  await click('[data-sknew-cat="security"]');
  await until(() => js("document.querySelectorAll('.sk-new-item').length === 1"), 5000, '英文安全分類');
  assert.match(await txt('.sk-new-pv'), /# Security basics/);
  await shot('PLAT-365-B3-搜尋與預覽-英文-1280.png');
  await click('.sk-new-pv [data-sktpl]');
  await until(() => js("!!document.querySelector('#sk-ap-text')"), 8000, '英文套用彈窗');
  assert.match(await js("document.querySelector('#sk-ap-text').value"), /# Security basics/, '英文介面給英文範本');
  assert.match(await txt('.sk-up-sec .field-hint'), /Keep the first few lines/);
  await shot('PLAT-365-5b-套用編輯-英文-1280.png');
  console.log('skill-template-ui-test：全部通過');
} catch (e) {
  console.error('skill-template-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
