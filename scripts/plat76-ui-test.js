// PLAT-76 驗收測試（開源版，真的瀏覽器）：
// 1. 卡片改成「受阻」時，自動展開編輯表單並聚焦「受阻原因」欄位
// 2. 「我的專案」與專案內「要你處理」列出等你決定的決策卡，數字與清單跟左側欄同一套算法（含「要求補充」等別人時不計）
// 用法：node scripts/plat76-ui-test.js（找不到 Chrome／Edge 就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('plat76-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('plat76');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body, L = boss.participant.participantId;
  const ai = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案', '第二專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = kit.aiToken(ai.participantId);

  const workCard = (await kit.call(tok, '/api/cards', 'POST', { requestId: 'w1', project: '預設專案', title: '受阻聚焦測試卡', ownerId: ai.participantId, status: '進行中' })).body;
  const decMain = (await kit.call(tok, '/api/cards', 'POST', { requestId: 'd1', project: '預設專案', type: '決策', title: '主專案決策：要上線嗎？', question: '主專案這版要現在上線嗎？', deciderId: L })).body;
  await kit.call(tok, '/api/cards', 'POST', { requestId: 'd2', project: '第二專案', type: '決策', title: '第二專案決策：要切換嗎？', question: '第二專案要切換設定嗎？', deciderId: L });
  const decNeed = (await kit.call(tok, '/api/cards', 'POST', { requestId: 'd3', project: '預設專案', type: '決策', title: '等 AI 補充的決策卡', question: '等 AI 補充細節', deciderId: L })).body;
  assert.equal((await kit.call(boss.token, `/api/cards/${decNeed.cardId}/decide`, 'POST', { result: '要求補充', note: '請補影響範圍', version: decNeed.version })).status, 200);

  const { js, login, cdp } = await kit.browser(1280, 900);

  await login(boss.token, '/');
  await until(() => js("document.querySelector('.hub-side [data-hub-todo-open] .hs-n')?.textContent === '2'"), 15000, '總覽側欄要你處理 = 2');
  await sleep(300);
  await until(() => js("!!document.querySelector('[data-hub-choice=tab][data-value=needs]')"), 15000, '總覽分頁');
  await js("document.querySelector('[data-hub-choice=tab][data-value=needs]').click(); true");
  const hub = JSON.parse(await js(`JSON.stringify((() => {
    const n = s => document.querySelector(s)?.querySelector('.hs-n')?.textContent || null;
    return {
      todo: n('.hub-side [data-hub-todo-open]'),
      main: n('.hub-side [data-proj="預設專案"]'),
      sec: n('.hub-side [data-proj="第二專案"]'),
      head: document.querySelector('[data-hub-choice=tab][data-value=needs]')?.textContent.trim().split(' ').pop(),
      rows: [...document.querySelectorAll('.hub-needs .ht-row')].map(r => ({ proj: r.dataset.hubProj, tag: r.querySelector('.ht-tag')?.textContent })),
    };
  })())`));
  assert.equal(hub.todo, '2', '總覽側欄要你處理 2 件');
  assert.equal(hub.main, '1', '預設專案側欄 1 件');
  assert.equal(hub.sec, '1', '第二專案側欄 1 件');
  assert.equal(hub.head, '2', '總覽右側標題 2 件');
  assert.equal(hub.rows.length, 2, '總覽右側列出 2 張決策卡');
  assert.ok(hub.rows.every(r => r.tag === '決策'), '兩項都是決策卡');

  await login(boss.token, '/p/main/inbox');
  await until(() => js(`!!document.querySelector('[data-dcard="${decMain.cardId}"]')`), 15000, '預設專案要你處理列出決策卡');
  await sleep(300);
  const inbox = JSON.parse(await js(`JSON.stringify({
    titleCount: document.querySelector('.work-title .muted')?.textContent?.trim(),
    dcards: [...document.querySelectorAll('.wdecisions .dcard')].map(e => e.dataset.dcard),
  })`));
  assert.equal(inbox.titleCount, '1 件', '專案要你處理標題顯示 1 件');
  assert.deepEqual(inbox.dcards, [decMain.cardId], '只列出等決策者決定的決策卡');

  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  await login(boss.token, '/p/main/work');
  await until(() => js(`!!document.querySelector('[data-card="${workCard.cardId}"]')`), 15000, '工作頁卡片載入');
  await js(`document.querySelector('[data-card="${workCard.cardId}"]').click(); true`);
  await until(() => js("!!document.querySelector('#d-status')"), 10000, '打開卡片抽屜');
  await js("const s = document.querySelector('#d-status'); s.value = '受阻'; s.dispatchEvent(new Event('change', { bubbles: true })); true");
  await until(() => js("!!document.querySelector('#card-edit [name=blocker]') && document.activeElement === document.querySelector('#card-edit [name=blocker]')"), 10000, '改受阻後展開並聚焦受阻原因');
  const labelText = await js("document.querySelector('#card-edit [name=blocker]')?.closest('label')?.childNodes[0]?.textContent?.trim()");
  assert.equal(labelText, '受阻原因', '欄位名稱為「受阻原因」');

  await js("const i = document.querySelector('#card-edit [name=blocker]'); i.value = '等外部金流開通'; document.querySelector('#card-edit').requestSubmit(); true");
  await until(() => js("!document.querySelector('#card-edit') && document.querySelector('#card-drawer')?.textContent.includes('等外部金流開通')"), 10000, '儲存受阻原因');

  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await login(boss.token, '/p/main/inbox');
  await until(() => js(`!!document.querySelector('[data-dcard="${decMain.cardId}"]')`), 15000, '手機版要你處理');
  assert.equal(await js('document.documentElement.scrollWidth > innerWidth + 1'), false, '手機版無橫向捲動');

  console.log('plat76-ui-test：全部通過');
} catch (e) {
  console.error('plat76-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
