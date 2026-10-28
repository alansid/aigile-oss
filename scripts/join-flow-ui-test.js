// 端到端畫面測試（真的瀏覽器，375）：新註冊 → 主畫面看到可申請的專案 → 申請 → 管理員核准 → 自動載入、看得到訊息與卡片
// 1. 專案預設開放申請：沒設過的專案，自己註冊的人在主畫面就看得到，按「申請加入」送出
// 2. 送出後主畫面寫「審核中」；管理員（沒有 leader）收到通知、核准
// 3. 申請人不用手動重新整理：即時通道幾秒內提示「你已加入」、主畫面出現專案，看得到裡面的訊息與卡片；等待中寫「核准後會自動更新」
// 5. 被拒絕：即時通道幾秒內提示，主畫面的「審核中」消失
// 4. 管理頁寫「新成員可以申請加入這個專案」並可切換；示範專案不出現在申請清單
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/join-flow-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('join-flow-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('joinflow');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body; // 管理員
  assert.equal((await kit.call(boss.token, '/api/messages', 'POST', { requestId: 'm1', project: '預設專案', text: '歡迎加入，這週先看登入頁' })).status, 201);
  const card = (await kit.call(boss.token, '/api/cards', 'POST', { requestId: 'c1', project: '預設專案', title: '登入頁改版' })).body;
  assert.ok(card.cardId, JSON.stringify(card));
  assert.equal((await kit.call(boss.token, '/api/admin/demo', 'POST')).status, 200, '載入示範資料（示範專案不開放申請）');
  // 新註冊的人：沒有專案
  const lin = (await kit.call(null, '/api/join', 'POST', { name: '林新人', role: 'UX' })).body;
  await kit.call(boss.token, `/api/participants/${lin.participant.participantId}/projects`, 'PUT', { projects: [] }).catch(() => {});
  const me0 = (await kit.call(lin.token, '/api/me')).body;
  assert.ok(!me0.projects.includes('預設專案'), '一開始不在預設專案：' + JSON.stringify(me0.projects));

  const { js, login } = await kit.browser(375, 800);
  await login(lin.token, '/');
  // 1. 主畫面直接列出可申請的專案
  await until(() => js("!!document.querySelector('.hub-joinable [data-join-open=\"預設專案\"]')"), 15000, '主畫面的可申請專案');
  assert.match(await js("document.querySelector('.work-title h2').textContent"), /，林新人$/, '問候用全名，不會變「新人」');
  const names = await js("[...document.querySelectorAll('.hub-join-row b')].map(b => b.textContent)");
  assert.ok(!names.some(n => n.startsWith('示範')), '示範專案不在申請清單：' + names);
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '375 沒有橫向捲動');
  await js("document.querySelector('.hub-joinable [data-join-open=\"預設專案\"]').click(); true");
  await until(() => js("!!document.querySelector('[data-jl-form=\"預設專案\"]')"), 10000, '直接打開這個專案的申請表單');
  await js("document.querySelector('#jl-note').value = '想幫忙做手機畫面'; document.querySelector('[data-jl-form=\"預設專案\"] button[type=submit]').click(); true");
  await until(() => js("[...document.querySelectorAll('.pill-tag')].some(x => x.textContent === '審核中')"), 10000, '送出後寫審核中');
  await js("document.querySelector('#modal-root [data-close], #modal-root .modal-close')?.click(); true");
  await until(() => js("/審核中/.test(document.querySelector('.hub-joinable')?.textContent || '')"), 10000, '主畫面也寫審核中');
  assert.ok(await js("/核准後會自動更新/.test(document.querySelector('.hub-joinable').textContent)"), '等待中說明核准後會自動更新');
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '審核中 375 沒有橫向捲動');
  await new Promise(r => setTimeout(r, 2000)); // 等即時通道連上
  // 2. 管理員收到、核准
  const reqs = (await kit.call(boss.token, '/api/join-requests')).body.items;
  const rq = reqs.find(x => x.participantId === lin.participant.participantId);
  assert.ok(rq, '管理員看得到申請');
  assert.ok((await kit.call(boss.token, '/api/me/notices')).body.items.some(n => n.kind === 'join_request'), '管理員收到通知');
  assert.equal((await kit.call(boss.token, `/api/join-requests/${rq.id}/approve`, 'POST', { role: '', readOnly: false })).status, 200, '核准');
  // 3. 即時通道：幾秒內提示並出現專案（不靠一分鐘的輪詢）
  const t0 = Date.now();
  await until(() => js("!!document.querySelector('.hub-card[data-proj=\"預設專案\"]')"), 8000, '核准後幾秒內主畫面出現專案');
  assert.ok(/你已加入「預設專案」/.test(await js("document.querySelector('#toast').textContent")), '提示你已加入：' + await js("document.querySelector('#toast').textContent"));
  console.log(`join-flow-ui-test：核准後 ${Date.now() - t0} ms 出現專案`);
  await js("document.querySelector('.hub-card[data-proj=\"預設專案\"]').click(); true");
  await until(() => js("/歡迎加入，這週先看登入頁/.test(document.querySelector('#page-messages, #messages, main')?.textContent || document.body.textContent)"), 15000, '看得到專案訊息');
  const cards = (await kit.call(lin.token, '/api/cards?project=預設專案')).body.items;
  assert.ok(cards.some(c => c.cardId === card.cardId), '看得到專案的卡片');
  // 5. 被拒絕：另開一個專案讓林新人申請，管理員拒絕
  const np = await kit.call(boss.token, '/api/projects', 'POST', { name: '活動頁' }), pj2 = np.body.id;
  assert.ok(pj2, '建第二個專案：' + JSON.stringify(np.body).slice(0, 200));
  const ap2 = await kit.call(lin.token, `/api/projects/${encodeURIComponent(pj2)}/join-requests`, 'POST', { note: '' });
  assert.ok(ap2.status < 300, '申請第二專案：' + JSON.stringify(ap2.body) + ' pj2=' + pj2);
  await js("location.href = '/'; true");
  await until(() => js("!!document.querySelector('.hub-card[data-proj=\"預設專案\"]')"), 15000, '重新整理後的主畫面');
  await new Promise(r => setTimeout(r, 2000)); // 等即時通道連上
  const rq2 = (await kit.call(boss.token, '/api/join-requests')).body.items.find(x => x.project === pj2);
  assert.equal((await kit.call(boss.token, `/api/join-requests/${rq2.id}/reject`, 'POST', { reason: '人手已滿' })).status, 200, '拒絕');
  await until(() => js("/沒有核准你的申請/.test(document.querySelector('#toast').textContent)"), 8000, '拒絕後幾秒內提示');
  // 4. 管理頁的文字與切換
  await login(boss.token, '/members');
  await until(() => js("[...document.querySelectorAll('[data-pm-tab]')].length > 0"), 15000, '成員與權限');
  await until(() => js("/新成員可以申請加入這個專案/.test(document.querySelector('#page-work').textContent)"), 15000, '管理頁寫新成員可以申請加入這個專案');
  assert.equal(await js("document.querySelector('[data-pj-join]')?.getAttribute('aria-checked')"), 'true', '預設是開的');
  console.log('join-flow-ui-test：全部通過');
} catch (e) {
  console.error('join-flow-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
