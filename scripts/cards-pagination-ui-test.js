// PLAT-427 畫面測試：看板「上限內、左邊欄位優先」與 AIGILE_BOARD_LIMIT 設定
// 1. 預設上限 200：250 張卡（230 張較新的已完成＋20 張較舊的待處理），20 張待處理全數出現、已完成只載入 180 張；我負責的卡也看得到最舊那張。
// 2. AIGILE_BOARD_LIMIT=20：25 張待處理＋5 張已完成，看板只放 20 張待處理、0 張已完成，並於上方顯示「還有 5 張沒顯示」。
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。用法：node scripts/cards-pagination-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('cards-pagination-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }

// ---------- 1. 230 張已完成 + 20 張待處理（最舊的在最後）----------
{
  const kit = await startKit('p427-oss');
  try {
    const { call, sql } = kit;
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
    const uid = liu.participant.participantId;
    assert.equal((await call(liu.token, '/api/me')).body.boardLimit, 200, '預設 boardLimit 為 200');
    const oldest = (await call(liu.token, '/api/cards', 'POST', {
      project: '預設專案', title: '最舊待處理卡', status: '待處理', ownerId: uid, requestId: 'p427-oldest',
    })).body;
    assert.ok(oldest.cardId, '建立最舊卡片失敗');
    const oldAt = '2026-11-01T00:00:00.000Z', midAt = '2026-11-10T00:00:00.000Z', doneAt = '2026-11-20T00:00:00.000Z';
    sql('UPDATE cards SET created_at = ?, updated_at = ? WHERE seq = 1', oldAt, oldAt);
    sql(`WITH RECURSIVE cnt(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM cnt WHERE n < 20)
      INSERT INTO cards (uid, type, title, owner_id, status, created_by, project, proj_no, version, created_at, updated_at)
      SELECT 'u427_o_' || n, '工作', '較舊待處理 #' || n, ?, '待處理', ?, '預設專案', n, 1, ?, ? FROM cnt`,
      uid, uid, midAt, midAt);
    sql(`WITH RECURSIVE cnt(n) AS (SELECT 21 UNION ALL SELECT n + 1 FROM cnt WHERE n < 250)
      INSERT INTO cards (uid, type, title, owner_id, status, created_by, project, proj_no, version, created_at, updated_at, done_by, done_at)
      SELECT 'u427_d_' || n, '工作', '最近已完成 #' || n, NULL, '已完成', ?, '預設專案', n, 1, ?, ?, ?, ? FROM cnt`,
      uid, doneAt, doneAt, uid, doneAt);

    const { js, login } = await kit.browser(1280, 900);
    await login(liu.token, '/p/main/work');
    await until(() => js("!!document.querySelector('[data-view=\"B\"]')"), 15000, '工作頁');
    await js("document.querySelector('[data-view=\"B\"]').click(); true");
    await until(() => js(`!!document.querySelector('.bcol[data-col="待處理"] [data-card="${oldest.cardId}"]')`), 15000, '工作看板顯示第 250 舊的待處理卡');
    assert.equal(await js("document.querySelectorAll('.bcol[data-col=\"待處理\"] [data-card]').length"), 20, '20 張待處理全數出現');
    assert.equal(await js("document.querySelectorAll('.bcol[data-col=\"已完成\"] [data-card]').length"), 180, '已完成只出現 180 張（總上限 200）');
    assert.equal(await js("document.querySelector('.board-cap')"), null, '未結案未超過上限時不顯示「還有 N 張沒顯示」');

    // 總覽與「我負責的卡」也包含最舊那張待處理卡
    await login(liu.token, '/');
    await until(() => js("!!document.querySelector('[data-hub-choice=\"tab\"][data-value=\"mine\"]')"), 15000, '總覽頁');
    await js("document.querySelector('[data-hub-choice=\"tab\"][data-value=\"mine\"]').click(); true");
    await until(() => js(`!!document.querySelector('[data-project-card="${oldest.cardId}"]')`), 8000, '我負責的卡顯示最舊的待處理卡');
  } finally {
    await kit.stop();
  }
}

// ---------- 2. AIGILE_BOARD_LIMIT=20：未結案超過上限時顯示「還有 N 張沒顯示」----------
process.env.AIGILE_BOARD_LIMIT = '20';
{
  const kit = await startKit('p427-oss-cap');
  try {
    const { call, sql } = kit;
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
    const uid = liu.participant.participantId;
    assert.equal((await call(liu.token, '/api/me')).body.boardLimit, 20, '讀到 AIGILE_BOARD_LIMIT=20');
    const first = (await call(liu.token, '/api/cards', 'POST', {
      project: '預設專案', title: '被擠出的待處理卡', status: '待處理', ownerId: uid, requestId: 'p427-cap-1',
    })).body;
    const oldAt = '2026-11-01T00:00:00.000Z', newAt = '2026-11-15T00:00:00.000Z', doneAt = '2026-11-20T00:00:00.000Z';
    sql('UPDATE cards SET created_at = ?, updated_at = ? WHERE seq = 1', oldAt, oldAt);
    sql(`WITH RECURSIVE cnt(n) AS (SELECT 2 UNION ALL SELECT n + 1 FROM cnt WHERE n < 25)
      INSERT INTO cards (uid, type, title, owner_id, status, created_by, project, proj_no, version, created_at, updated_at)
      SELECT 'u427c_o_' || n, '工作', '待處理 #' || n, NULL, '待處理', ?, '預設專案', n, 1, ?, ? FROM cnt`,
      uid, newAt, newAt);
    sql(`WITH RECURSIVE cnt(n) AS (SELECT 26 UNION ALL SELECT n + 1 FROM cnt WHERE n < 30)
      INSERT INTO cards (uid, type, title, owner_id, status, created_by, project, proj_no, version, created_at, updated_at, done_by, done_at)
      SELECT 'u427c_d_' || n, '工作', '已完成 #' || n, NULL, '已完成', ?, '預設專案', n, 1, ?, ?, ?, ? FROM cnt`,
      uid, doneAt, doneAt, uid, doneAt);

    const { js, goto, login } = await kit.browser(1280, 900);
    await login(liu.token, '/p/main/work');
    await until(() => js("!!document.querySelector('[data-view=\"B\"]')"), 15000, '工作頁');
    await js("document.querySelector('[data-view=\"B\"]').click(); true");
    await until(() => js("!!document.querySelector('.board-cap')?.getClientRects().length"), 15000, '看板上方顯示上限提示');
    assert.equal(await js("document.querySelector('.board-cap').textContent.trim()"), '⚠ 卡片太多，看板只放 20 張。還有 5 張未結案的卡沒顯示，可以用搜尋或篩選找。', '中文上限提示文字正確');
    assert.equal(await js("document.querySelector('.work-title .small').textContent.trim()"), '顯示 20／共 25 張未完成', '中文標題顯示實際總數');
    assert.equal(await js("document.querySelector('.bcol[data-col=\"已完成\"] .bempty')?.textContent.trim()"), '因為上限沒有載入已完成的卡', '中文已完成欄說明因上限未載入');
    assert.equal(await js("document.querySelector('.bcol[data-col=\"已完成\"] .wcount')?.textContent.trim()"), '—', '中文未載入已完成時欄數字顯示 —');
    assert.equal(await js("document.querySelectorAll('.bcol[data-col=\"待處理\"] [data-card]').length"), 20, '只載入上限內的 20 張待處理');
    assert.equal(await js("document.querySelectorAll('.bcol[data-col=\"已完成\"] [data-card]').length"), 0, '沒有剩餘名額時不載入已完成');
    assert.equal(await js(`document.querySelector('[data-card="${first.cardId}"]')`), null, '最舊的第 25 張待處理卡未在上限內');

    await js("localStorage.setItem('aigile-lang', 'en'); true");
    await goto('/p/main/work', '英文看板');
    await until(() => js("document.documentElement.lang === 'en' && !!document.querySelector('[data-view=\"B\"]')"), 15000, '英文工作頁');
    await js("document.querySelector('[data-view=\"B\"]').click(); true");
    await until(() => js("!!document.querySelector('.board-cap')?.getClientRects().length"), 15000, 'EN board-cap');
    assert.equal(await js("document.querySelector('.board-cap').textContent.trim()"), "⚠ Too many cards; the board shows 20. 5 more open cards aren't shown. Use search or filters to find them.");
    assert.equal(await js("document.querySelector('.work-title .small').textContent.trim()"), 'Showing 20 of 25 open cards');
    assert.equal(await js("document.querySelector('.bcol[data-col=\"已完成\"] .bempty')?.textContent.trim()"), 'Done cards not loaded (board limit)');
    assert.equal(await js("document.querySelector('.bcol[data-col=\"已完成\"] .wcount')?.textContent.trim()"), '—');
  } finally {
    delete process.env.AIGILE_BOARD_LIMIT;
    await kit.stop();
  }
}

// ---------- 3. since 增量同步：超過 200 張變動＋至少 1 張過時卡不漏 ----------
process.env.CARD_STALE_HOURS = '0';
{
  const kit = await startKit('p427-oss-since');
  try {
    const { call, sql } = kit;
    const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
    const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '示範PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    const uid = liu.participant.participantId;
    const st = (await call(liu.token, '/api/cards', 'POST', { project: '預設專案', title: '過時測試卡', status: '進行中', ownerId: uid, requestId: 'p427-st' })).body;
    const trig = (await call(liu.token, '/api/cards', 'POST', { project: '預設專案', title: '觸發同步卡', status: '待處理', ownerId: uid, requestId: 'p427-tr' })).body;
    const oldAt = '2026-11-01T00:00:00.000Z', baseAt = '2026-11-10T00:00:00.000Z', newAt = '2026-11-20T00:00:00.000Z';
    sql('UPDATE cards SET created_at = ?, updated_at = ? WHERE seq = ?', oldAt, oldAt, Number(st.legacyId.slice(2)) - 100);
    sql('UPDATE cards SET created_at = ?, updated_at = ? WHERE seq = ?', baseAt, baseAt, Number(trig.legacyId.slice(2)) - 100);
    await call(ai.token, '/api/messages', 'POST', { project: '預設專案', cardId: st.cardId, text: `[進度] ${st.cardId} 有新動態`, requestId: 'p427-stm' });

    const { js, login } = await kit.browser(1280, 900);
    await login(liu.token, '/p/main/work');
    await until(() => js("!!document.querySelector('[data-view=\"B\"]')"), 15000, '工作頁');
    await js("document.querySelector('[data-view=\"B\"]').click(); true");
    await until(() => js(`!!document.querySelector('[data-card="${trig.cardId}"]')`), 15000, '看板載入觸發卡');

    // 先打開編輯表單（畫面上握著舊 version=1），再從伺服器更新 version 並塞進 205 張新變動卡
    await js(`document.querySelector('[data-card="${trig.cardId}"]').click(); true`);
    await until(() => js("!!document.querySelector('#card-drawer [data-act=\"edit\"]')"), 8000, '編輯鈕');
    await js("document.querySelector('#card-drawer [data-act=\"edit\"]').click(); true");
    await until(() => js("!!document.querySelector('#card-edit [name=\"next\"]')"), 5000, '編輯表單');

    await call(liu.token, `/api/cards/${trig.cardId}`, 'PATCH', { next: 'server-bump', version: trig.version });
    sql(`WITH RECURSIVE cnt(n) AS (SELECT 3 UNION ALL SELECT n + 1 FROM cnt WHERE n < 207)
      INSERT INTO cards (uid, type, title, owner_id, status, created_by, project, proj_no, version, created_at, updated_at)
      SELECT 'u427s_' || n, '工作', '同步變動卡 #' || n, NULL, '進行中', ?, '預設專案', n, 1, ?, ? FROM cnt`,
      uid, newAt, newAt);

    // 送出舊 version 觸發 409 CONFLICT → 呼叫 syncCards() 分頁讀完所有變動＋過時卡
    await js("document.querySelector('#card-edit [name=\"next\"]').value = 'client-stale'; document.querySelector('#card-edit button[type=\"submit\"]').click(); true");
    await until(() => js("document.querySelectorAll('.bcol[data-col=\"進行中\"] [data-card]').length === 206"), 15000, 'since 超過 200 張變動＋過時卡全部同步到（共 206 張進行中）');
    assert.equal(await js("document.querySelectorAll('.bcol[data-col=\"進行中\"] [data-card]').length"), 206, '過時卡存在時第 201 筆之後不漏接');
  } finally {
    delete process.env.CARD_STALE_HOURS;
    await kit.stop();
  }
}

console.log('cards-pagination-ui-test：全部通過（左欄優先、20 待處理＋180 已完成、AIGILE_BOARD_LIMIT 上限與「還有 N 張沒顯示」、since 超過 200 張＋過時卡同步不漏）');
