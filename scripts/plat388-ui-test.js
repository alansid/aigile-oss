// PLAT-388 畫面測試（真的瀏覽器）：「要你處理」的私訊關得掉
// 11/21 回報：要你處理 › 🔒 私訊 有 3 則 watcher 發的「叫醒跑過 10 分鐘已停掉」，按「打開私訊」沒反應、也沒有「已讀」
// 1. 同一隻 AI 連發的私訊合併成一列：寫幾則、最後一則、最後時間；總覽的「要你處理」也合併
// 2. 每列有「已讀」，不打開也能清；同一隻 AI 的幾則一次清，數字跟著減
// 3. 「打開私訊」打開那隻 AI 的對話，列馬上消失、不用重新整理
// 4. 在總覽（不在專案裡）按「打開私訊」：自動切到它所在、有開私訊的專案並打開對話，不會沒反應
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/plat388-ui-test.js
import './test-home.mjs'; // PLAT-323：不寫到真的家目錄
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('plat388-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('p388');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const mk = async name => { const a = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, tok: kit.aiToken(a.participantId) }; };
  const pg1 = await mk('PG一號'), pg2 = await mk('PG二號');
  assert.equal((await kit.call(boss.token, '/api/projects/%E9%A0%90%E8%A8%AD%E5%B0%88%E6%A1%88/dm', 'PUT', { on: true })).status, 200, '開私訊');
  // watcher 連發三則叫醒逾時（AI 自己發的私訊）＋另一隻 AI 一則
  for (const t of ['15:46', '20:41', '21:04']) assert.equal((await kit.call(pg1.tok, '/api/dm', 'POST', { text: `[通知] 這一輪叫醒跑超過 10 分鐘，watcher 已停掉它（${t} 開始）。常發生的話請看 AI 是不是卡住或對話太長。`, requestId: 'watcher-' + t })).status, 201);
  assert.equal((await kit.call(pg2.tok, '/api/dm', 'POST', { text: '做好了，請看 PLAT-1', requestId: 'r2' })).status, 201);
  const pending = async () => (await kit.call(boss.token, '/api/notifications?status=pending')).body.items.filter(n => n.dm).length;
  assert.equal(await pending(), 4, '主人有 4 則私訊通知');

  const { js, login } = await kit.browser(1280, 900);
  const rows = "[...document.querySelectorAll('#page-work .dm-note')]";
  const rowText = `${rows}.map(r => r.textContent.replace(/\\s+/g, ' ').trim())`;
  // 1. 總覽：合併成兩項
  await login(boss.token, '/');
  await until(() => js("[...document.querySelectorAll('.hub-todo .ht-row')].filter(r => r.textContent.includes('回你了')).length === 2"), 15000, '總覽兩項私訊');
  const hub = await js("[...document.querySelectorAll('.hub-todo .ht-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim()).filter(t => t.includes('回你了'))");
  assert.ok(hub.some(t => t.includes('PG一號 回你了（3 則）')), '總覽合併：' + JSON.stringify(hub));
  assert.ok(hub.some(t => t.includes('PG二號 回你了') && !t.includes('則）')), JSON.stringify(hub));

  // 4. 總覽（不在專案裡）按「打開私訊」：原本 dmEntry() 為否，按了沒反應
  await js(`(() => { const b = document.createElement('button'); b.id = 't388'; b.dataset.dmOpen = ${JSON.stringify(pg1.id)}; b.dataset.dmPj = '預設專案'; document.body.append(b); b.click(); return true; })()`);
  await until(() => js("!!document.querySelector('#dm-panel:not([hidden]) #dm-input')"), 10000, '總覽按打開私訊 → 開到對話');
  assert.ok(await js("location.pathname.startsWith('/p/')"), '切進專案：' + await js('location.pathname'));
  await until(() => js("(document.querySelector('#dm-panel').textContent || '').includes('21:04 開始')"), 10000, '對話裡看得到私訊（輸入框先畫好，私訊內容稍後才載入）');
  await until(async () => (await pending()) === 1, 10000, '打開對話後 PG一號 的 3 則標為已讀');
  await js("document.querySelector('#dm-panel [data-dm-close]')?.click() ?? document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); document.getElementById('t388')?.remove(); true");

  // 再發三則，測收件匣
  for (const t of ['22:01', '22:30', '23:05']) assert.equal((await kit.call(pg1.tok, '/api/dm', 'POST', { text: `[通知] 這一輪叫醒跑超過 10 分鐘，watcher 已停掉它（${t} 開始）。常發生的話請看 AI 是不是卡住或對話太長。`, requestId: 'watcher2-' + t })).status, 201);
  await login(boss.token, '/p/main/inbox');
  await until(() => js(`${rows}.length === 2`), 15000, '收件匣私訊兩列');
  const inbox = await js(rowText);
  const one = inbox.find(t => t.includes('PG一號'));
  assert.ok(one && one.includes('3 則') && one.includes('23:05 開始') && one.includes('最後一則') && one.includes('全部已讀（3）'), '合併成一列：' + JSON.stringify(inbox));
  assert.ok(inbox.some(t => t.includes('PG二號') && /已讀$/.test(t)), '單則也有已讀：' + JSON.stringify(inbox));
  assert.equal(await js("document.querySelector('#page-work .dm-note')?.closest('section')?.querySelector('.wcount')?.textContent"), '2', '區塊數字＝列數');

  // 2. 已讀：不打開也能清，數字跟著減
  await js(`${rows}.find(r => r.textContent.includes('PG二號')).querySelector('[data-dm-read]').click(); true`);
  await until(() => js(`${rows}.length === 1`), 5000, '按已讀列馬上消失');
  await until(async () => (await pending()) === 3, 10000, '伺服器也標為已讀');

  // 3. 打開私訊：列馬上消失（不用重新整理）
  await js(`${rows}[0].querySelector('[data-dm-open]').click(); true`);
  await until(() => js("!!document.querySelector('#dm-panel:not([hidden]) #dm-input')"), 10000, '打開對話');
  await until(() => js(`${rows}.length === 0`), 10000, '打開對話後列馬上消失');
  assert.equal(await pending(), 0, '全部清掉');
  console.log('plat388-ui-test：全部通過');
} catch (e) {
  console.error('plat388-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
