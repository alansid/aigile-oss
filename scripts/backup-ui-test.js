// 畫面測試（真的瀏覽器，手機寬 375）：管理頁「系統」下載備份、在空站匯入
// 1. 管理員才有「系統」分頁；有資料的站不給匯入
// 2. 按「下載備份」：分批拿完、下載一個 JSON 檔，訊息顯示數量
// 3. 新站（空站）選檔 → 預覽數量 → 確認 → 匯入完成，重新整理後你是備份裡的管理員，看得到原本的卡片
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/backup-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('backup-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const A = await startKit('bka');
let B = null;
try {
  const boss = (await A.call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body;
  const chen = (await A.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const card = (await A.call(boss.token, '/api/cards', 'POST', { requestId: 'c1', project: '預設專案', title: '搬家測試卡' })).body;
  assert.ok(card.cardId, JSON.stringify(card));
  for (let i = 0; i < 30; i++) await A.call(boss.token, '/api/messages', 'POST', { requestId: 'm' + i, project: '預設專案', text: '訊息 ' + i });

  // 1. 非管理員不能用（一般成員進不了成員與權限頁；API 也擋）
  assert.equal((await A.call(chen.token, '/api/admin/backup/status')).status, 403, '非管理員不能用');
  // 2. 管理員下載備份
  const ba = await A.browser(375, 800);
  await ba.login(boss.token, '/members');
  await until(() => ba.js("!!document.querySelector('[data-pm-tab=\"system\"]')"), 15000, '系統分頁');
  await ba.js("document.querySelector('[data-pm-tab=\"system\"]').click(); true");
  await until(() => ba.js("!!document.querySelector('[data-bk=\"export\"]') && /這個站已經有資料，不能匯入/.test(document.querySelector('#page-work').textContent)"), 15000, '有資料的站不給匯入');
  assert.equal(await ba.js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '375 沒有橫向捲動');
  await ba.js("window.__bk = null; const o = URL.createObjectURL.bind(URL); URL.createObjectURL = b => { window.__bk = b; return o(b); }; document.querySelector('[data-bk=\"export\"]').click(); true");
  await until(() => ba.js("/備份完成/.test(document.querySelector('#bk-msg')?.textContent || '')"), 20000, '備份完成');
  assert.equal(await ba.js("document.querySelector('[data-bk=\"export\"]').closest('.pm-card').contains(document.querySelector('#bk-msg'))"), true, '備份完成的提示在下載按鈕那張卡裡');
  const json = await ba.js('window.__bk.text()');
  const bk = JSON.parse(json);
  assert.equal(bk.format, 'aigile-backup');
  assert.ok(bk.tables.messages.length >= 30 && bk.tables.cards.length >= 1, '有訊息與卡片');
  assert.ok(!json.includes(boss.token) && !json.includes(chen.token), '不含登入碼');

  // 3. 新站匯入
  B = await startKit('bkb');
  const me = (await B.call(null, '/api/join', 'POST', { name: '新站管理員', role: 'PO' })).body;
  const bb = await B.browser(375, 800);
  await bb.login(me.token, '/members');
  await until(() => bb.js("!!document.querySelector('[data-pm-tab=\"system\"]')"), 15000, '新站的系統分頁');
  await bb.js("document.querySelector('[data-pm-tab=\"system\"]').click(); true");
  await until(() => bb.js("!!document.querySelector('[data-bk-file]')"), 15000, '空站可以匯入');
  await bb.js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(json)}], 'aigile-backup.json', { type: 'application/json' })); const i = document.querySelector('[data-bk-file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await until(() => bb.js("/成員 2 位（人類 2、AI 0）/.test(document.body.textContent) && /王小明/.test(document.querySelector('.modal')?.textContent || '')"), 15000, '預覽數量與管理員');
  const pv = await bb.js("document.querySelector('.modal').textContent");
  assert.ok(pv.includes('你會變成備份裡的群組管理員（名字：王小明）'), '管理員的說法不繞口令：' + pv);
  const local = await bb.js(`(() => { const d = new Date(${JSON.stringify(bk.exportedAt)}), p = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); })()`);
  assert.ok(pv.includes(local + ' 匯出'), `匯出時間用本地時間 ${local}：` + pv);
  await bb.js("[...document.querySelectorAll('.modal button')].find(b => b.textContent.trim() === '匯入').click(); true");
  await until(() => bb.js("/匯入完成/.test(document.querySelector('#bk-msg')?.textContent || '')"), 30000, '匯入完成');
  assert.equal(await bb.js("!!document.querySelector('#bk-msg').closest('.pm-card')?.querySelector('[data-bk-file]')"), true, '匯入的提示在匯入那張卡裡');
  await new Promise(r => setTimeout(r, 2500)); // 自動重新整理
  await until(() => bb.js("!!document.querySelector('.av-btn')"), 15000, '重新整理後');
  const meNow = (await B.call(me.token, '/api/me')).body;
  assert.equal(meNow.name, '王小明', '你變成備份裡的管理員');
  assert.equal((await B.call(me.token, `/api/cards/${card.cardId}`)).body.title, '搬家測試卡', '卡片搬過來了');
  // 4. 匯入後陳大文的登入不在備份裡：成員頁標「要重設登入才進得來」，旁邊直接按重設登入
  await bb.login(me.token, '/members');
  // 陳大文自己註冊、不在任何專案：在「依成員」清單標出來，點進去有重設登入
  await until(() => bb.js("!!document.querySelector('[data-pm-view=\"byMember\"]')"), 15000, '依成員');
  await bb.js("document.querySelector('[data-pm-view=\"byMember\"]').click(); true");
  await until(() => bb.js("[...document.querySelectorAll('.pm-li')].some(r => /陳大文/.test(r.textContent) && /要重設登入/.test(r.textContent))"), 15000, '依成員清單標要重設登入');
  await bb.js("[...document.querySelectorAll('.pm-li')].find(r => /陳大文/.test(r.textContent)).click(); true");
  await until(() => bb.js("!!document.querySelector('[data-pm-reset]')"), 10000, '點進去有重設登入');
  assert.equal(await bb.js('document.documentElement.scrollWidth <= innerWidth + 1'), true, '標示後 375 沒有橫向捲動');
  console.log('backup-ui-test：全部通過');
} catch (e) {
  console.error('backup-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await A.stop();
  if (B) await B.stop();
}
