// 畫面測試（真的瀏覽器，PLAT-365）：技能庫的「範本技能」區 → 套用（改內容）→ 上架 → 卡片標「📚 範本」
// → 範本有新版時卡片標「範本有新版」、抽屜有「看範本新版」，打開會附目前的 SKILL.md 對照、發給誰沿用原本的
// 一般成員看不到範本區（不能套用）；手機 375 不橫向捲動；英文介面給英文範本
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

  // 1. 一般成員：看不到範本區
  await openLib(wang);
  await until(() => js("!!document.querySelector('.sk-view .sk-rule')"), 5000, '技能庫畫完');
  assert.equal(await js("!!document.querySelector('.sk-tpl-sec')"), false, '一般成員看不到範本區');

  // 2. 管理員：範本區 6 個，按套用 → 編輯框是範本全文
  await openLib(boss);
  await until(() => js("document.querySelectorAll('.sk-tpl').length === 6"), 8000, '範本區 6 個');
  assert.match(await txt('.sk-tpl-sec .sk-tpl-h'), /範本技能/);
  await shot('PLAT-365-1-範本區-1280.png', '.sk-tpl-sec');
  await click('[data-sktpl="commit-convention"]');
  await until(() => js("!!document.querySelector('#sk-ap-text')"), 8000, '套用彈窗');
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

  // 3. 回到技能庫：卡片標「📚 範本」，範本區標「已套用」
  await click('[data-sk-fin]');
  await until(() => js("[...document.querySelectorAll('.sk-card')].some(c => c.textContent.includes('📚 範本'))"), 8000, '卡片標範本');
  await until(() => js("[...document.querySelectorAll('.sk-tpl')].some(c => c.textContent.includes('：已套用'))"), 8000, '範本區標已套用');
  await shot('PLAT-365-3-卡片範本標籤-1280.png', '.sk-card');

  // 4. 範本有新版（模擬專案套用的是舊版 @0，並指定給 PG）：卡片標、抽屜有按鈕、打開附目前內容、發給誰沿用
  const old = full.files[0].text.replace('commit-convention@1', 'commit-convention@0');
  const up = await kit.call(boss.token, '/api/projects/預設專案/skills', 'POST', { files: [{ path: 'SKILL.md', text: old }, { path: 'templates.md', text: '範例' }], roles: ['PG'] });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  await openLib(boss);
  await until(() => js("[...document.querySelectorAll('.sk-card')].some(c => c.textContent.includes('範本有新版'))"), 8000, '卡片標範本有新版');
  await shot('PLAT-365-4a-卡片範本有新版-1280.png', '.sk-card');
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
  await shot('PLAT-365-4c-更新時對照目前版本-1280.png');
  await click('[data-sksend]');
  await until(() => js("!!document.querySelector('.sk-ok')"), 8000, '更新成功');
  const v3 = (await kit.call(boss.token, '/api/skills')).body.items.find(x => x.name === 'commit-convention');
  assert.equal(v3.version, 3); assert.equal(v3.template.outdated, false, '更新後不再標新版');
  assert.deepEqual((await kit.call(boss.token, `/api/skills/${v3.skillId}`)).body.files.map(f => f.path).sort(), ['SKILL.md', 'templates.md'], '其他檔照留');

  // 5. 手機 375：範本區與套用彈窗不橫向捲動
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 760, deviceScaleFactor: 1, mobile: true });
  await openLib(boss);
  await until(() => js("document.querySelectorAll('.sk-tpl').length === 6"), 8000, '手機範本區');
  assert.equal(await js('innerWidth'), 375);
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '手機範本區不橫向捲動');
  await shot('PLAT-365-1-範本區-375.png', '.sk-tpl-sec');
  await click('[data-sktpl="testing-rules"]');
  await until(() => js("!!document.querySelector('#sk-ap-text')"), 8000, '手機套用彈窗');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '手機套用彈窗不橫向捲動');
  assert.ok(await js("document.querySelector('#sk-ap-text').getBoundingClientRect().right <= innerWidth"), '編輯框在畫面內');
  await shot('PLAT-365-2-套用編輯-375.png');
  await cdp('Emulation.clearDeviceMetricsOverride');

  // 6. 英文介面：範本區英文、編輯框是英文範本
  await openLib(boss, 'en');
  await until(() => js("document.documentElement.lang === 'en' && document.querySelectorAll('.sk-tpl').length === 6"), 8000, '英文範本區');
  assert.match(await txt('.sk-tpl-sec .sk-tpl-h'), /Template skills/);
  assert.match(await txt('.sk-tpl-sec'), /Default project: applied/, '已套用的標籤也是英文');
  assert.ok(!/已套用|範本有新版/.test(await txt('.sk-tpl-sec')), '範本區沒有中文殘留');
  await shot('PLAT-365-5-範本區-英文-1280.png', '.sk-tpl-sec');
  await click('[data-sktpl="security-checklist"]');
  await until(() => js("!!document.querySelector('#sk-ap-text')"), 8000, '英文套用彈窗');
  assert.match(await js("document.querySelector('#sk-ap-text').value"), /# Security basics/, '英文介面給英文範本');
  await shot('PLAT-365-5b-套用編輯-英文-1280.png');
  await noHScroll(1280);
  console.log('skill-template-ui-test：全部通過');
} catch (e) {
  console.error('skill-template-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
