// 畫面測試（真的瀏覽器，375px）：收件匣「等你驗收」能直接打開 AI 的回報
// 1. AI 還沒交回報：那列灰色寫「AI 還沒交回報」，沒有可以點的「看回報」
// 2. 交了 [完成]：那列有「看回報」，點了跳到那則訊息
// 3. 卡片詳情「相關訊息」旁有「看回報」
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/report-open-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('report-open-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('t1');
let n = 0;
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const a = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'UX', role: 'UX', name: 'UX一號', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const ux = { id: a.participantId, tok: kit.aiToken(a.participantId) };
  const card = (await kit.call(ux.tok, '/api/cards', 'POST', { title: 'UX 草案', type: '工作', project: '預設專案', ownerId: ux.id, requestId: 'r' + ++n })).body;
  assert.equal((await kit.call(ux.tok, `/api/cards/${card.cardId}`, 'PATCH', { status: '待確認', waitForId: boss.participant.participantId, version: card.version })).status, 200);

  const { js, login } = await kit.browser(375, 800);
  const row = `document.querySelector('[data-ver-row="${card.cardId}"]')`;
  await login(boss.token, '/p/main/inbox');
  await until(() => js(`!!${row}`), 15000, '等你驗收那列');
  // 1. 還沒交回報
  assert.equal(await js(`${row}.querySelector('.ver-noreport')?.textContent`), 'AI 還沒交回報');
  assert.equal(await js(`!!${row}.querySelector('[data-ver-report]')`), false, '沒有可以點的看回報');
  // 2. 交了 [完成]
  const done = (await kit.call(ux.tok, '/api/messages', 'POST', { project: '預設專案', requestId: 'r' + ++n, text: '[完成] 草案用文字交棒\n\n主流程：登入→收件匣→卡片', cardId: card.cardId, recipientIds: [boss.participant.participantId], replyFrom: [] })).body;
  assert.ok(done.messageId, JSON.stringify(done));
  await kit.call(ux.tok, `/api/cards/${card.cardId}`, 'PATCH', { next: '請驗收', version: (await kit.call(ux.tok, `/api/cards/${card.cardId}`)).body.version }); // 卡有更新，網頁的增量同步才會重抓
  await js('location.reload(); true');
  await until(() => js(`!!${row}?.querySelector('[data-ver-report]')`), 15000, '出現看回報');
  assert.equal(await js(`${row}.querySelector('[data-ver-report]').dataset.verReport`), done.messageId);
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '375 沒有橫向捲動');
  await js(`${row}.querySelector('[data-ver-report]').click(); true`);
  await until(() => js(`!!document.getElementById('msg-${done.messageId}')`), 15000, '跳到回報訊息');
  // 3. 卡片詳情
  await js(`history.pushState(null, '', '/p/main/inbox'); dispatchEvent(new PopStateEvent('popstate')); true`);
  await until(() => js(`!!${row}`), 15000, '回到收件匣');
  await js(`${row}.querySelector('[data-card]').click(); true`);
  await until(() => js("!!document.querySelector('#card-drawer [data-ver-report]')"), 15000, '詳情的看回報');
  assert.equal(await js("document.querySelector('#card-drawer [data-ver-report]').textContent"), '看回報');
  console.log('report-open-ui-test：全部通過');
} catch (e) {
  console.error('report-open-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
