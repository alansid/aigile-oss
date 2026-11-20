// 網頁：成員與權限 › 專案，已封存的列有「永久刪除…」（只有管理員）
// 確認框列出數量與會一起刪的 AI（只屬於這個專案的）、要輸入專案名稱才能按；刪完表格沒有它、下面列出「已永久刪除的專案」
// 手機 375 不橫向捲動。本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。用法：node scripts/project-delete-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('project-delete-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('projdel');
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const wang = (await kit.call(null, '/api/join', 'POST', { name: '陳小美', role: 'UX' })).body;
  const np = (await kit.call(liu.token, '/api/projects', 'POST', { name: '舊專案', code: 'OLD' })).body;
  const pid = np.items.find(p => p.name === '舊專案').id;
  await kit.call(liu.token, `/api/participants/${wang.participant.participantId}/projects`, 'PUT', { projects: ['預設專案', pid] });
  const ai = (await kit.call(liu.token, '/api/my-ais', 'POST', { projects: [pid], roleKey: 'PG', role: 'PG', name: '舊專案的AI', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  for (let i = 0; i < 3; i++) await kit.call(liu.token, '/api/messages', 'POST', { project: pid, text: '舊專案訊息 ' + i, requestId: 'm' + i });
  assert.equal((await kit.call(liu.token, `/api/projects/${encodeURIComponent(pid)}/archive`, 'POST')).status, 200, '封存');

  const { js, login, cdp } = await kit.browser(1280, 900);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  const openProjects = async () => {
    await login(liu.token, '/members');
    await until(() => js("!!document.querySelector('[data-pm-tab=\"projects\"]')"), 10000, '成員與權限');
    await js("document.querySelector('[data-pm-tab=\"projects\"]').click(); true");
    await until(() => js("!!document.querySelector('.pm-ptable')"), 8000, '專案表格');
    await sleep(300);
  };
  const row = `.pm-prow[data-pj="${pid}"]`;
  await openProjects();
  assert.ok(await js(`!!document.querySelector('${row} [data-pp="purge"]')`), '已封存的列有「永久刪除…」');
  assert.ok(!(await js("[...document.querySelectorAll('.pm-prow:not(.archived) [data-pp=\"purge\"]')].length")), '沒封存的沒有');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '375 沒有橫向捲動');
  // 確認框：數量、只屬於這個專案的 AI 會一起刪、救不回來、要輸入名稱
  await js(`document.querySelector('${row} [data-pp="purge"]').click(); true`);
  await until(() => js("!!document.querySelector('.confirm-root [data-expect]')"), 8000, '確認框');
  const msg = await js("document.querySelector('.confirm-root').textContent");
  for (const k of ['永久刪除「舊專案」？', '救不回來', '訊息 3 則', '卡片 0 張', '只屬於這個專案的 AI 會一起刪除：舊專案的AI', '帳號會留著', '跨專案頻道的訊息不動', '請輸入「舊專案」確認']) assert.ok(msg.includes(k), '確認框寫：' + k + '｜' + msg);
  assert.ok(await js("document.querySelector('.confirm-root [data-ok]').disabled"), '還沒輸入名稱不能按');
  assert.ok(await js("document.querySelector('.confirm-root [data-ok]').classList.contains('danger')"), '紅色按鈕');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '375 確認框沒有橫向捲動');
  await js("(() => { const i = document.querySelector('.confirm-root [data-expect]'); i.value = '舊專'; i.dispatchEvent(new Event('input')); return true; })()");
  assert.ok(await js("document.querySelector('.confirm-root [data-ok]').disabled"), '名稱不對不能按');
  await js("(() => { const i = document.querySelector('.confirm-root [data-expect]'); i.value = '舊專案'; i.dispatchEvent(new Event('input')); return true; })()");
  assert.ok(!(await js("document.querySelector('.confirm-root [data-ok]').disabled")), '名稱對了可以按');
  await js("document.querySelector('.confirm-root [data-ok]').click(); true");
  // 3. 刪完：表格沒有它；下面列出刪除紀錄
  await until(() => js(`!document.querySelector('${row}')`), 8000, '表格拿掉');
  await until(() => js("!!document.querySelector('.pm-dels')"), 8000, '刪除紀錄');
  await js("document.querySelector('.pm-dels').open = true; true");
  const dels = await js("document.querySelector('.pm-dels').textContent");
  assert.match(dels, /已永久刪除的專案 · 1[\s\S]*舊專案[\s\S]*OLD[\s\S]*林志明[\s\S]*訊息 3 則/, '刪除紀錄：' + dels);
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), '375 刪除紀錄沒有橫向捲動');
  assert.equal((await kit.call(wang.token, '/api/me')).status, 200, '成員照常');
  assert.ok(!(await kit.call(liu.token, '/api/my-ais')).body.items.some(a => a.participantId === ai.participantId), '只屬於舊專案的 AI 一起刪了');
  // 英文介面：刪除紀錄翻成英文
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await openProjects();
  await until(() => js("!!document.querySelector('.pm-dels')"), 8000, '英文刪除紀錄');
  await js("document.querySelector('.pm-dels').open = true; true");
  const enDels = await js("document.querySelector('.pm-dels').textContent");
  assert.match(enDels, /Permanently deleted projects · 1[\s\S]*3 messages, 0 cards, 0 documents/, '英文刪除紀錄：' + enDels);
  console.log('project-delete-ui-test：全部通過');
} catch (e) {
  console.error('project-delete-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
