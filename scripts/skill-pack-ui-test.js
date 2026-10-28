// 畫面測試（真的瀏覽器）：上傳技能包（zip，含一張圖）→ 卡片列出技能數、會執行的腳本（檔名＋一行用途）、測試資料、略過的非文字檔
// → 上架 → 抽屜顯示技能包內容、會執行的腳本、其他檔打開才畫；我的 AI 顯示技能包與啟動參數；手機 375 不橫向捲動
// 修正前：.claude-plugin 資料夾被當成隱藏檔略過、圖片讓整包失敗，技能包傳不上去
// 用法：node scripts/skill-pack-ui-test.js（找不到 Chrome／Edge 就略過）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('skill-pack-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('t1');
// 不壓縮的 zip（內容可以是 Buffer）
function zip(entries) {
  const parts = [], central = []; let off = 0;
  for (const [name, body] of entries) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body), nm = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
    parts.push(h, nm, data);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, e]);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-tui-'));
const packZip = path.join(tmp, 'demo-pack.zip');
// 外面多包一層資料夾（像從 GitHub 下載的），裡面有 .claude-plugin、兩個技能、一個會執行的腳本、一個測試資料、一張圖
fs.writeFileSync(packZip, zip([
  ['demo-pack/.claude-plugin/plugin.json', JSON.stringify({ name: 'demo-pack', description: '示範技能包' })],
  ['demo-pack/skills/alpha/SKILL.md', '---\nname: alpha\ndescription: 第一個\n---\nalpha\n'],
  ['demo-pack/skills/beta/SKILL.md', '---\nname: beta\ndescription: 第二個\n---\n讀 skills/alpha/SKILL.md\n'],
  ['demo-pack/skills/beta/scripts/run.mjs', '#!/usr/bin/env node\n// 把清單排好印出來\nconsole.log(1)\n'],
  ['demo-pack/skills/beta/scripts/test/corpus/case.out', '測試資料\n'],
  ['demo-pack/agents/helper.md', '---\nname: helper\n---\n幫手\n'],
  ['demo-pack/docs/images/logo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])],
]));
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body; // 管理員
  const pg = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body.participantId;
  const { js, login, cdp } = await kit.browser(1280, 900);
  const txt = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const openUpload = async () => {
    await login(boss.token, '/my-ai');
    await until(() => js("!!document.querySelector('#ma-skills')"), 10000, '技能庫入口');
    await click('#ma-skills');
    await until(() => js("!!document.querySelector('[data-skup]')"), 10000, '技能庫');
    await click('[data-skup]');
    await until(() => js("!!document.querySelector('.modal.sk-up #sk-zip')"), 8000, '上傳彈窗');
  };
  const pick = async f => {
    const { root } = (await cdp('DOM.getDocument')).result;
    const { nodeId } = (await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#sk-zip' })).result;
    await cdp('DOM.setFileInputFiles', { nodeId, files: [f] });
    await until(() => js("!!document.querySelector('.sk-up-card')"), 8000, '檔案卡片');
  };

  // 1. 手機 375：卡片內容、沒有橫向捲動
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 860, deviceScaleFactor: 1, mobile: true });
  await openUpload();
  await pick(packZip);
  assert.equal(await txt('.sk-up-name'), 'demo-pack', '名稱讀自 plugin.json');
  assert.match(await txt('.sk-up-head'), /技能包/, '標技能包');
  assert.match(await txt('.sk-up-meta'), /讀自 \.claude-plugin\/plugin\.json · 文字 6 個檔/, '只算文字檔（圖片略過）');
  const tags = await txt('.sk-up-tags');
  for (const t of ['技能 2 個、agent 1 個', '會執行的腳本 1 個', '測試資料 1 個（不會執行）', '略過非文字檔 1 個']) assert.ok(tags.includes(t), `標籤有「${t}」：${tags}`);
  assert.match(await txt('.sk-runs li'), /skills\/beta\/scripts\/run\.mjs.*把清單排好印出來/s, '會執行的腳本列檔名＋一行用途');
  assert.match(await txt('.sk-skip'), /docs\/images\/logo\.jpg/, '列出略過的檔');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '375 沒有橫向捲動');
  assert.ok(await js("(() => { const m = document.querySelector('.modal.sk-up'); return m.scrollWidth <= m.clientWidth + 1; })()"), '上傳視窗沒有橫向捲動');
  // 發給：指定 AI（程式助手）→ 上架（管理員含腳本直接上架）
  await click('#sk-to [data-sk-mode="ais"]');
  await click(`#sk-to [data-sk-ai="${pg}"]`);
  assert.equal(await txt('#sk-up-note'), '含腳本，你能直接上架；每台電腦還要 AI 主人允許才裝');
  await click('[data-sksend]');
  await until(() => js("!!document.querySelector('.sk-ok')"), 10000, '上架成功');
  const lib = (await kit.call(boss.token, '/api/skills')).body.items.find(s => s.name === 'demo-pack');
  assert.deepEqual([lib.kind, lib.pack.files, lib.aiIds], ['pack', 6, [pg]], '平台收到整包（6 個文字檔）、發給指定的 AI');

  // 2. 桌機：清單標技能包；抽屜顯示內容、會執行的腳本；其他檔打開才畫
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await login(boss.token, '/my-ai');
  await until(() => js("!!document.querySelector('#ma-skills')"), 10000, '技能庫入口');
  await click('#ma-skills');
  await until(() => js(`!!document.querySelector('[data-skc="${lib.skillId}"]')`), 10000, '技能卡');
  assert.match(await txt(`[data-skc="${lib.skillId}"]`), /技能包 · 2 個技能/, '清單標技能包');
  await click(`[data-skc="${lib.skillId}"]`);
  await until(() => js("!!document.querySelector('[data-sk-lazy]')"), 8000, '抽屜');
  const drawer = await txt('.sk-drawer');
  assert.match(drawer, /技能 2 個、agent 1 個 · 文字 6 個檔 · 會執行的腳本 1 個 · 測試資料 1 個/, '抽屜摘要');
  assert.match(drawer, /把清單排好印出來/, '抽屜列會執行腳本的用途');
  assert.equal(await js("document.querySelectorAll('.sk-lazy .sk-file').length"), 0, '其他檔先不畫');
  await js("{ const d = document.querySelector('[data-sk-lazy]'); d.open = true; } true");
  await until(() => js("document.querySelectorAll('.sk-lazy .sk-file').length === 5"), 5000, '打開才畫其他 5 個檔');
  await click('[data-skx]');

  // 3. 我的 AI › 技能：標技能包、寫啟動參數
  await login(boss.token, '/my-ai');
  await until(() => js(`!!document.querySelector('[data-act="row"][data-id="${pg}"]')`), 10000, '我的 AI');
  await click(`[data-act="row"][data-id="${pg}"]`);
  await until(() => js(`!!document.querySelector('[data-act="tab"][data-tab="skills"][data-id="${pg}"]')`), 5000, '技能分頁');
  await click(`[data-act="tab"][data-tab="skills"][data-id="${pg}"]`);
  await until(() => js(`/demo-pack/.test(document.querySelector('[data-ma-skills="${pg}"]')?.textContent || '')`), 8000, '我的 AI 技能');
  const ma = await txt(`[data-ma-skills="${pg}"]`);
  assert.match(ma, /demo-pack\s*技能包/, '標技能包');
  assert.match(ma, /claude --plugin-dir "<AI 的工作資料夾>\\\.aigile\\PG_[A-Z0-9]+\\plugins"/, '寫啟動參數：' + ma);
  console.log('skill-pack-ui-test：全部通過');
} catch (e) {
  console.error('skill-pack-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
