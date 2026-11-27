// AI 成員「⋯」選單排版：分三組、單色線條圖示、左緣對齊，項目與出現條件不變
// 1. 本機 AI（已登記啟動器、技能 2 等你允許）：常用 3 項｜進階（灰色標題、不能點）4 項｜停用、刪除；沒有 <details>
// 2. 其他工具＋Token 過期：沒有換電腦、從這台電腦移除、只複製 Token；進階是重發 Token、手動接入（手動接入不分工具都有）
// 3. 雲端 AI：編輯、每輪上限｜停用、刪除；已停用：編輯｜重新啟用、刪除（沒有進階）
// 4. 每項都有 16px 線條圖示、文字左緣對齊、沒有 emoji；只有刪除是紅色（圖示跟著紅），其他圖示灰色
// 5. 行為照舊：「手動接入」開接入分頁、「技能」開技能分頁
// 6. 375：選單寬 260、右緣對齊「⋯」、不橫向捲動
// 7. 英文 1280、375：選單沒有漏翻
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。雲端、啟動器、過期這幾種狀態在瀏覽器端改 /api/my-ais 的回應（只測畫面）。
// 用法：node scripts/ai-menu-ui-test.js（AI_MENU_SHOTS=資料夾 會存截圖）
import './test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('ai-menu-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('aimenu');
const shotDir = process.env.AI_MENU_SHOTS;
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mk = async name => { const r = await kit.call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.participantId; };
  const A = await mk('小幫手-前端'), B = await mk('小幫手-其他'), C = await mk('小幫手-雲端'), D = await mk('小幫手-舊');
  assert.equal((await kit.call(liu.token, `/api/my-ais/${D}/disable`, 'POST')).status, 200);
  const fake = {
    [A]: { isOnline: true, skillsWaiting: 2 },
    [B]: { expiresAt: '2020-01-01T00:00:00.000Z' },
    [C]: { cloud: { kindLabel: 'Claude', model: 'claude-sonnet-5-5', maxTools: 20, runs: [] } },
  };
  const { js, cdp, login, goto } = await kit.browser(1280, 900);
  await cdp('Page.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    localStorage.setItem('aigile-ai-tools', ${JSON.stringify(JSON.stringify({ [A]: 'claude', [B]: 'other', [D]: 'claude' }))});
    const fake = ${JSON.stringify(fake)}, f = window.fetch;
    window.fetch = async (u, o) => { const r = await f(u, o);
      const my = /\\/api\\/my-ais(\\?|$)/.test(String(u)), dev = /\\/api\\/launcher$/.test(String(u));
      if ((!my && !dev) || (o && o.method && o.method !== 'GET')) return r;
      const d = await r.json();
      if (my) (d.items || []).forEach(x => Object.assign(x, fake[x.participantId] || {}));
      else d.ais = { ...d.ais, ${A}: { registered: true, launcherName: '辦公室電腦', folder: 'D:/work', tool: 'claude' } }; // 已登記啟動器
      return new Response(JSON.stringify(d), { status: r.status, headers: { 'content-type': 'application/json' } }); };
  })();` });
  const shot = async name => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); await sleep(250); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const P = id => `#ai-list [data-ma="${id}"]`;
  const M = '#ai-list .ma-menu';
  const openMenu = async id => {
    if (await js(`!!document.querySelector('${M}')`)) { await js(`document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); true`); await until(() => js(`!document.querySelector('${M}')`), 3000, '先關掉別的選單'); }
    await js(`document.querySelector('${P(id)} [data-act="menu"]').click(); true`);
    await until(() => js(`!!document.querySelector('${P(id)} .ma-menu')`), 5000, '「⋯」選單');
  };
  // 選單結構：| 是分隔線、# 是分組標題、其他是項目文字（+ 右邊的黃色小標）
  const layout = () => js(`[...document.querySelector('${M}').children].map(e => e.tagName === 'HR' ? '|' : e.classList.contains('ma-grp') ? '#' + e.textContent : e.querySelector('.ma-mi-l').textContent + (e.querySelector('.ma-mi-tag') ? '+' + e.querySelector('.ma-mi-tag').textContent : ''))`);
  const look = () => js(`(() => { const m = document.querySelector('${M}'), bs = [...m.querySelectorAll('button')];
    const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
    const probe = document.createElement('span'); probe.style.color = muted; document.body.append(probe); const mutedRgb = getComputedStyle(probe).color; probe.remove();
    return { details: !!m.querySelector('details,summary'), emoji: /\\p{Extended_Pictographic}/u.test(m.innerText),
      icons: bs.map(b => { const s = b.querySelector('svg.ma-ico'); return s ? Math.round(s.getBoundingClientRect().width) + 'x' + Math.round(s.getBoundingClientRect().height) : 'none'; }),
      lefts: [...new Set(bs.map(b => Math.round(b.querySelector('.ma-mi-l').getBoundingClientRect().left)))].length,
      red: bs.filter(b => getComputedStyle(b).color !== getComputedStyle(m.querySelector('[data-act="edit"]')).color).map(b => b.dataset.act),
      redIcon: bs.filter(b => b.dataset.act === 'delete').every(b => getComputedStyle(b.querySelector('svg')).color === getComputedStyle(b).color),
      grayIcons: bs.filter(b => b.dataset.act !== 'delete').every(b => getComputedStyle(b.querySelector('svg')).color === mutedRgb),
      grp: [...m.querySelectorAll('.ma-grp')].map(g => [g.tagName, g.getAttribute('role'), g.tabIndex, getComputedStyle(g).color === mutedRgb, parseFloat(getComputedStyle(g).fontSize)]) }; })()`);

  await login(liu.token, '/my-ai');
  await until(() => js(`!!document.querySelector('${P(A)} .ma-right .btn') && !!document.querySelector('${P(D)}')`), 15000, '我的 AI');

  // 1. 本機 AI
  await openMenu(A);
  assert.deepEqual(await layout(), ['編輯名稱、角色、專案', '技能+2 等你允許', '換電腦或資料夾…', '|', '#進階', '重發 Token', '只複製 Token', '手動接入', '從這台電腦移除', '|', '停用', '刪除這隻 AI'], '本機 AI 三組');
  const la = await look();
  assert.equal(la.details, false, '沒有 <details>');
  assert.equal(la.emoji, false, '沒有 emoji');
  assert.deepEqual([...new Set(la.icons)], ['16x16'], '每項都有 16px 圖示：' + la.icons);
  assert.equal(la.lefts, 1, '文字左緣全部對齊');
  assert.deepEqual(la.red, ['delete'], '只有刪除是紅色');
  assert.ok(la.redIcon && la.grayIcons, '刪除的圖示跟著紅、其他圖示灰色');
  assert.deepEqual(la.grp, [['DIV', null, -1, true, 11.5]], '「進階」是灰色小字標題、不是按鈕、不能聚焦');
  assert.equal(await js(`document.activeElement.dataset.act`), 'edit', '打開選單游標在第一項');
  await shot('1-本機AI-1280');

  // 2. 其他工具＋Token 過期
  await openMenu(B);
  assert.deepEqual(await layout(), ['編輯名稱、角色、專案', '技能', '|', '#進階', '重發 Token', '手動接入', '|', '停用', '刪除這隻 AI'], '其他工具、過期：沒有換電腦、移除、只複製 Token，有手動接入');
  await shot('2-其他工具過期-1280');
  await js(`document.querySelector('${M} [data-tab="conn"]').click(); true`);
  await until(() => js(`document.querySelector('${P(B)} .ma-tabs [data-tab="conn"]')?.getAttribute('aria-selected') === 'true'`), 5000, '其他工具：手動接入開接入分頁');
  await js(`document.querySelector('${P(B)} .ma-row').click(); true`); // 收起來

  // 3. 雲端、已停用
  await openMenu(C);
  assert.deepEqual(await layout(), ['編輯名稱、角色、專案', '每輪上限', '|', '停用', '刪除這隻 AI'], '雲端 AI');
  assert.deepEqual([...new Set((await look()).icons)], ['16x16']);
  await shot('3-雲端AI-1280');
  await openMenu(D);
  assert.deepEqual(await layout(), ['編輯名稱、角色、專案', '|', '重新啟用', '刪除這隻 AI'], '已停用');
  assert.deepEqual((await look()).red, ['delete']);
  assert.equal(await js(`(() => { let o = 1; for (let e = document.querySelector('${M}'); e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; })()`), 1, '已停用：選單不跟著那列變淡');
  assert.equal(await js(`Number(getComputedStyle(document.querySelector('${P(D)} .ma-main')).opacity)`), 0.7, '已停用：那列本身維持淡色');
  await shot('4-已停用-1280');

  // 5. 行為照舊
  await openMenu(A);
  await js(`document.querySelector('${M} [data-tab="conn"]').click(); true`);
  await until(() => js(`document.querySelector('${P(A)} .ma-tabs [data-tab="conn"]')?.getAttribute('aria-selected') === 'true'`), 5000, '手動接入開接入分頁');
  assert.equal(await js(`!!document.querySelector('${M}')`), false, '點了選單就關');
  await openMenu(A);
  await js(`document.querySelector('${M} [data-tab="skills"]').click(); true`);
  await until(() => js(`document.querySelector('${P(A)} .ma-tabs [data-tab="skills"]')?.getAttribute('aria-selected') === 'true'`), 5000, '技能開技能分頁');
  await js(`document.querySelector('${P(A)} .ma-row').click(); true`); // 收起來

  // 6. 375
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await openMenu(A);
  const geo = await js(`(() => { const m = document.querySelector('${M}').getBoundingClientRect(), b = document.querySelector('${P(A)} .ma-more').getBoundingClientRect(); return [Math.round(m.width), Math.round(m.right - b.right), m.left >= 0, m.bottom <= innerHeight]; })()`);
  assert.deepEqual(geo, [260, 0, true, true], '375：寬 260、右緣對齊「⋯」、在畫面內：' + geo);
  assert.equal((await look()).lefts, 1, '375 文字左緣對齊');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 不橫向捲動');
  await shot('5-本機AI-375');

  // 7. 英文
  const EN = ['Edit name, role, projects', 'Skills+2 waiting', 'Change computer or folder…', '|', '#Advanced', 'Reissue token', 'Copy token only', 'Manual setup', 'Remove from this computer', '|', 'Disable', 'Delete this AI'];
  const cjk = () => js(`(document.querySelector('${M}').innerText.match(/[\u3400-\u9fff]+/g) || [])`);
  await cdp('Emulation.clearDeviceMetricsOverride', {});
  await goto('/', '首頁');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await login(liu.token, '/my-ai');
  await until(() => js(`!!document.querySelector('${P(A)} .ma-right .btn') && !!document.querySelector('${P(D)}')`), 15000, '英文我的 AI');
  await openMenu(A);
  await until(async () => JSON.stringify(await layout()) === JSON.stringify(EN), 3000, '英文本機 AI 選單：' + JSON.stringify(await layout()));
  assert.deepEqual(await cjk(), [], '英文選單沒有漏翻');
  assert.equal((await look()).lefts, 1, '英文文字左緣對齊');
  await shot('en-1-本機AI-1280');
  await openMenu(C);
  assert.deepEqual(await layout(), ['Edit name, role, projects', 'Per-turn limit', '|', 'Disable', 'Delete this AI'], '英文雲端 AI');
  await openMenu(D);
  assert.deepEqual(await layout(), ['Edit name, role, projects', '|', 'Re-enable', 'Delete this AI'], '英文已停用');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await sleep(400);
  await openMenu(A);
  assert.deepEqual(await layout(), EN, '英文 375');
  assert.deepEqual(await cjk(), [], '英文 375 沒有漏翻');
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '英文 375 不橫向捲動');
  await shot('en-2-本機AI-375');
  await cdp('Emulation.clearDeviceMetricsOverride', {});
  await js("localStorage.removeItem('aigile-lang'); true");
  console.log('ai-menu-ui-test：全部通過（英文 1280／375、本機／其他工具過期／雲端／已停用四種選單分組、16px 線條圖示、左緣對齊、只有刪除紅色、進階標題不能點、手動接入與技能照舊、375 寬 260 對齊「⋯」）');
} finally {
  await kit.stop();
}
