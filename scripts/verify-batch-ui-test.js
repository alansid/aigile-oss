// 畫面測試：驗收可以勾選、全選，一次通過
// A. 「要你處理」的「等你驗收」：每列勾選框；上方全選、已選 N 張、驗收通過（N）（沒勾不能按）；按下先確認，通過後那幾張變已完成、其他照舊
// B. 工作頁「已完成」列表：每列直接有「驗收通過」；勾選、全選、驗收通過（N）；自己完成的卡不能勾、沒按鈕，寫「你完成的，要別人驗」
// C. 看板「待驗證」：每張有「通過」小按鈕，按了只驗這張、不打開卡片；自己完成的沒有
// D. 遷移（補到的列 updated_at、version 跟著更新，舊游標的增量同步拿得到；重跑不再改）— 010：人自己完成、還沒驗收的舊卡補成已驗收；AI 完成的、決策卡不動
// E. 1280、375 不橫向捲動
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 VERIFY_BATCH_SHOTS=資料夾 會另外截圖。用法：node scripts/verify-batch-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

// ---------- D 遷移 010（不用瀏覽器） ----------
{
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  const now = '2026-11-01T00:00:00.000Z';
  const person = db.prepare('INSERT INTO participants (id, kind, name, code, token, created_at, updated_at) VALUES (?,?,?,?,?,?,?)');
  person.run('p_h', 'human', '劉昱志', 'H001', 'tok_h', now, now);
  person.run('p_a', 'ai', '示範PG', 'A001', 'tok_a', now, now);
  const card = db.prepare("INSERT INTO cards (seq, uid, project, type, title, status, created_by, created_at, updated_at, done_by, done_at, verified_by, verified_at) VALUES (?, 'u' || ?, '預設專案', ?, ?, ?, 'p_h', ?, ?, ?, ?, ?, ?)");
  card.run(1, 1, '工作', '人完成的舊卡', '已完成', now, now, 'p_h', now, null, null);
  card.run(2, 2, '工作', 'AI 完成的卡', '已完成', now, now, 'p_a', now, null, null);
  card.run(3, 3, '決策', '人完成的決策卡', '已完成', now, now, 'p_h', now, null, null);
  card.run(4, 4, '工作', '人完成、已驗收', '已完成', now, now, 'p_h', now, 'p_a', '2026-11-02T00:00:00.000Z');
  card.run(5, 5, '工作', '人完成後又打開', '進行中', now, now, 'p_h', now, null, null);
  const migSql = fs.readFileSync(new URL('../migrations/010_verify_human_done.sql', import.meta.url), 'utf8');
  db.exec(migSql);
  const got = db.prepare('SELECT seq, verified_by, verified_at FROM cards ORDER BY seq').all().map(r => `${r.seq}:${r.verified_by}:${r.verified_at}`);
  assert.deepEqual(got, [`1:p_h:${now}`, '2:null:null', '3:null:null', '4:p_a:2026-11-02T00:00:00.000Z', '5:null:null'], 'D 遷移 010 只補人完成、還沒驗收的已完成卡（AI 完成、決策卡、已驗收、沒完成的不動）：' + got);
  // 增量同步：已開著的畫面、AI 用 updated_at > 游標 拿更新；補驗收的那張要拿得到，其他不動
  const since = db.prepare('SELECT seq, version FROM cards WHERE updated_at > ? ORDER BY seq').all(now).map(r => `${r.seq}:${r.version}`);
  assert.deepEqual(since, ['1:2'], 'D 補驗收的那張 updated_at、version 都更新，舊游標的增量同步拿得到；其他列不動：' + since);
  db.exec(migSql);
  assert.deepEqual(db.prepare('SELECT seq, version FROM cards WHERE updated_at > ? ORDER BY seq').all(now).map(r => `${r.seq}:${r.version}`), ['1:2'], 'D 重跑不會再改（version 還是 2）');
  db.close();
}

if (!findBrowser()) { console.log('verify-batch-ui-test：D 遷移通過；畫面部分略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('vb');
try {
  const { call } = kit;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('劉昱志', 'PO'), hua = await join('小華', 'PG');
  const L = liu.participant.participantId, H = hua.participant.participantId;
  await call(liu.token, `/api/participants/${H}/projects`, 'PUT', { projects: ['預設專案'] });
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '示範PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  let rq = 0;
  const mk = async (tok, title, owner) => (await call(tok, '/api/cards', 'POST', { project: '預設專案', title, ownerId: owner, status: '進行中', requestId: 'c' + (++rq) })).body;
  const patch = async (tok, c, body) => { const r = await call(tok, `/api/cards/${c.cardId}`, 'PATCH', { ...body, version: (await call(tok, `/api/cards/${c.cardId}`)).body.version }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
  const get = async c => (await call(liu.token, `/api/cards/${c.cardId}`)).body;
  // 等你驗收：AI 交給劉昱志
  const toVerify = async title => { const c = await mk(ai.token, title, ai.participantId); return patch(ai.token, c, { status: '待確認', waitForId: L }); };
  // 已完成・待驗收：AI 完成的；人完成的舊卡（模擬「人類完成即驗收」之前的資料）
  const aiDone = async title => { const c = await mk(ai.token, title, ai.participantId); return patch(ai.token, c, { status: '已完成' }); };
  const oldHumanDone = async (tok, who, title) => { const c = await mk(tok, title, who); await patch(tok, c, { status: '已完成' }); kit.sql('UPDATE cards SET verified_by = NULL, verified_at = NULL WHERE seq = ?', Number(c.cardId.split('-')[1])); return c; };

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.VERIFY_BATCH_SHOTS) return; fs.mkdirSync(process.env.VERIFY_BATCH_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.VERIFY_BATCH_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64')); };
  const text = sel => until(() => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.getClientRects().length) return null; return [(e.innerText || '').replace(/\\s+/g, ' ').trim()]; })()`), 8000, '畫出來 ' + sel).then(v => v[0]);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const confirmOk = async expect => {
    await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '確認框');
    const t = await js("document.querySelector('.confirm-root').innerText.replace(/\\s+/g, ' ')");
    assert.match(t, expect, '確認框文字：' + t);
    await js("document.querySelector('.confirm-root [data-ok]').click(); true");
  };
  const sizes = [[1280, 900, '1280'], [375, 812, '375']];

  // ---------- A 要你處理 › 等你驗收 ----------
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    const v = [await toVerify(`${tag} 報價單匯出加上幣別欄`), await toVerify(`${tag} 匯出檔名加日期`), await toVerify(`${tag} 匯出加總列`)];
    await login(liu.token, '/p/main/inbox');
    await until(() => js("!!document.querySelector('.ver-batch')?.getClientRects().length"), 15000, 'A 等你驗收');
    assert.equal(await text('.ver-batch'), '全選 已選 0 張 驗收通過（0）', `A ${tag} 批次列`);
    assert.equal(await js("document.querySelector('[data-ver-batch]').disabled"), true, `A ${tag} 沒勾不能按`);
    assert.ok(await js("getComputedStyle(document.querySelector('[data-ver-batch]')).backgroundColor !== 'rgba(0, 0, 0, 0)' && document.querySelector('[data-ver-batch]').classList.contains('primary')"), `A ${tag} 驗收通過（N）是藍色實心`);
    assert.ok(await js("(() => { const bar = document.querySelector('.ver-batch'), go = bar.querySelector('[data-ver-batch]'), all = bar.querySelector('[data-ver-all]'); return go.getBoundingClientRect().left > all.getBoundingClientRect().right; })()"), `A ${tag} 全選在左、驗收通過在右`);
    for (const c of v.slice(0, 2)) await click(`[data-ver-check="${c.cardId}"]`);
    await until(async () => (await text('.ver-batch')) === '全選 已選 2 張 驗收通過（2）', 5000, 'A 勾兩張');
    assert.ok(await js("(() => { const b = getComputedStyle(document.querySelector('[data-ver-batch]')); return b.color !== b.backgroundColor && b.color === 'rgb(255, 255, 255)'; })()"), `A ${tag} 驗收通過（N）白字看得見`);
    assert.ok(await js("(() => { const bar = document.querySelector('.ver-batch').getBoundingClientRect(), go = document.querySelector('[data-ver-batch]').getBoundingClientRect(); return bar.right - go.right < 24; })()"), `A ${tag} 驗收通過（N）靠右`);
    if (w < 700) assert.ok(await js(`(() => { const r = document.querySelector('[data-ver-row="${v[0].cardId}"]'), c = r.querySelector('.sugg-check').getBoundingClientRect(), m = r.querySelector('.sugg-main').getBoundingClientRect(); return Math.abs(c.top - m.top) < 24; })()`), `A ${tag} 手機勾選框跟標題同一行`);
    assert.ok(!(await hscroll()), `E ${tag} 等你驗收不橫向捲動`);
    await js("document.querySelector('.ver-batch').scrollIntoView({ block: 'start' }); true");
    await shot(`01-${tag}-等你驗收-勾兩張`);
    await click('[data-ver-batch]');
    await confirmOk(/^把 2 張標為驗收通過？ .*跟一張一張按「驗收通過」一樣。要退回的請取消勾選/);
    await until(async () => (await get(v[0])).status === '已完成' && (await get(v[1])).status === '已完成', 10000, 'A 兩張驗收通過');
    assert.deepEqual([!!(await get(v[0])).verified, !!(await get(v[1])).verified, (await get(v[2])).status], [true, true, '待確認'], `A ${tag} 勾的兩張驗收通過、沒勾的照舊`);
    // 全選
    await until(() => js(`!document.querySelector('[data-ver-row="${v[0].cardId}"]')`), 8000, 'A 通過的那幾列不見了');
    await click('[data-ver-all]');
    await until(async () => /已選 [1-9]\d* 張/.test(await text('.ver-batch')), 5000, 'A 全選');
    assert.ok(await js("[...document.querySelectorAll('[data-ver-check]')].every(x => x.checked)"), `A ${tag} 全選全部勾起來`);
    await click('[data-ver-all]'); // 取消全選，留給下一個寬度
  }

  // ---------- B 工作頁「已完成」列表 ＋ C 看板「待驗證」 ----------
  const openList = async () => {
    await login(liu.token, '/p/main/work');
    await until(() => js("!!document.querySelector('[data-view]')"), 15000, '工作頁');
    await click('[data-view="A"]');
    await until(() => js("!!document.querySelector('[data-filter=\"已完成\"]')"), 5000, '篩選');
    await click('[data-filter="已完成"]');
    await until(() => js("!!document.querySelector('.crows-done')"), 5000, '已完成列表');
  };
  const lineOf = c => `[...document.querySelectorAll('.crow-line')].find(l => l.querySelector('[data-card="${c.cardId}"]'))`;
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    const a1 = await aiDone(`${tag} AI 做完：報表改版`), a2 = await aiDone(`${tag} AI 做完：匯出欄位`);
    const byHua = await oldHumanDone(hua.token, H, `${tag} 小華完成的舊卡`);
    const mine = await oldHumanDone(liu.token, L, `${tag} 我自己完成的舊卡`);
    await openList();
    assert.match(await text('.done-batch'), /^全選 已選 0 張 驗收通過（0）$/, `B ${tag} 批次列`);
    for (const c of [a1, a2, byHua]) {
      assert.ok(await js(`!!${lineOf(c)}.querySelector('[data-done-check="${c.cardId}"]')`), `B ${tag} 別人完成的可以勾：${c.title}`);
      assert.equal(await js(`${lineOf(c)}.querySelector('[data-done-ok]').textContent`), '驗收通過', `B ${tag} 每列直接有驗收通過：${c.title}`);
    }
    assert.ok(await js(`!${lineOf(mine)}.querySelector('[data-done-check], [data-done-ok]')`), `B ${tag} 自己完成的不能勾、沒按鈕`);
    assert.match(await js(`${lineOf(mine)}.innerText`), /你完成的，要別人驗/, `B ${tag} 自己完成的寫原因`);
    assert.ok(!(await hscroll()), `E ${tag} 已完成列表不橫向捲動`);
    assert.equal(await js("[...document.querySelectorAll('.crow-line')].filter(l => /已驗收/.test(l.innerText) && (l.querySelector('.crow.me') || /等你/.test(l.querySelector('.crow-wait')?.textContent || ''))).length"), 0, `B ${tag} 已驗收的列不顯示「等你」、不標橘（UX）`);
    await js(`${lineOf(a1)}.scrollIntoView({ block: 'center' }); true`);
    await shot(`02-${tag}-已完成列表`);
    // 單張：直接按這列的「驗收通過」（不打開卡片）
    await js(`${lineOf(byHua)}.querySelector('[data-done-ok]').click(); true`);
    await until(async () => !!(await get(byHua)).verified, 8000, 'B 單張驗收通過');
    assert.equal(await js("!!document.querySelector('#card-drawer .drawer')?.getClientRects().length"), false, `B ${tag} 按驗收通過不會打開卡片`);
    assert.equal((await get(byHua)).verified.by.name, '劉昱志', `B ${tag} 驗收人是我`);
    // 全選＋驗收通過（N）
    await until(() => js(`!${lineOf(byHua)}.querySelector('[data-done-ok]')`), 5000, 'B 驗過的那列沒有按鈕了');
    await click('[data-done-all]');
    const n = await until(async () => { const m = /已選 (\d+) 張/.exec(await text('.done-batch')); return m && Number(m[1]) > 0 ? Number(m[1]) : null; }, 5000, 'B 全選');
    assert.ok(await js("[...document.querySelectorAll('[data-done-check]')].every(x => x.checked)"), `B ${tag} 全選全部勾起來`);
    await click('[data-done-batch]');
    await confirmOk(new RegExp(`^把 ${n} 張標為驗收通過？`));
    await until(async () => !!(await get(a1)).verified && !!(await get(a2)).verified, 10000, 'B 批次驗收通過');
    assert.equal((await get(mine)).verified, null, `B ${tag} 自己完成的照舊沒驗收`);
    assert.equal((await call(liu.token, `/api/cards/${mine.cardId}/verify`, 'POST')).body.error?.code, 'SELF_VERIFY', `B ${tag} 伺服器照舊擋自己驗自己`);

    // C 看板
    const b1 = await aiDone(`${tag} AI 做完：看板上驗`);
    await openList(); // 重新載入，看得到剛做完的卡
    await click('[data-view="B"]');
    if (w < 700) { await until(() => js("!!document.querySelector('[data-mcol=\"已完成\"]')"), 5000, '手機欄位切換'); await click('[data-mcol="已完成"]'); }
    await until(() => js(`!!document.querySelector('.ctile[data-card="${b1.cardId}"] [data-done-ok]')`), 8000, 'C 待驗證有通過');
    assert.equal(await js(`document.querySelector('.ctile[data-card="${b1.cardId}"] [data-done-ok]').textContent`), '通過', `C ${tag} 小按鈕寫「通過」`);
    assert.ok(await js(`!document.querySelector('.ctile[data-card="${mine.cardId}"] [data-done-ok]')`) && /你完成的，要別人驗/.test(await js(`document.querySelector('.ctile[data-card="${mine.cardId}"]').innerText`)), `C ${tag} 自己完成的沒有通過、寫原因`);
    assert.ok(!(await hscroll()), `E ${tag} 看板不橫向捲動`);
    await js(`document.querySelector('.ctile[data-card="${b1.cardId}"]').scrollIntoView({ block: 'center' }); true`);
    await shot(`03-${tag}-看板待驗證`);
    assert.ok(await js(`(() => { const b = document.querySelector('.ctile[data-card="${b1.cardId}"] [data-done-ok]').getBoundingClientRect(); return b.width > 0 && b.left >= 0 && b.right <= innerWidth; })()`), `C ${tag} 通過按鈕整顆在畫面內（UX）`);
    await click(`.ctile[data-card="${b1.cardId}"] [data-done-ok]`);
    await until(async () => !!(await get(b1)).verified, 8000, 'C 看板通過');
    assert.equal(await js("!!document.querySelector('#card-drawer .drawer')?.getClientRects().length"), false, `C ${tag} 按通過不會打開卡片`);
    await click('[data-view="A"]');
  }

  // ---------- G 一次補 201 張舊卡（超過增量同步一頁的上限 200 張）：開著的畫面要全部更新，原本看得到的卡一張都不能不見 ----------
  await size(1280, 900);
  for (let i = 1; i <= 201; i++) { const c = await mk(liu.token, `G 舊卡 ${i}`, L); await patch(liu.token, c, { status: '已完成' }); }
  kit.sql("UPDATE cards SET verified_by = NULL, verified_at = NULL, updated_at = '2026-11-01T00:00:00.000Z' WHERE title LIKE 'G 舊卡 %'");
  // 遷移後 201 張同一個時間：只讀第一頁（新到舊、同時間照編號大到小）會漏掉編號最小的「G 舊卡 1」；讓它一開始就載入在畫面上
  kit.sql("UPDATE cards SET updated_at = '2026-11-20T00:00:00.000Z' WHERE title = 'G 舊卡 1'");
  await openList();
  const gSelf = () => js("[...document.querySelectorAll('.crow-line')].filter(l => /G 舊卡 \\d+/.test(l.innerText) && /你完成的，要別人驗/.test(l.innerText)).length");
  const before = await js("[...document.querySelectorAll('.crow-line [data-card]')].map(b => b.dataset.card)"), gBefore = await gSelf();
  assert.ok(gBefore >= 150, 'G 畫面先載入很多張還沒驗收的舊卡：' + gBefore);
  const g1 = `[...document.querySelectorAll('.crow-line')].find(l => /G 舊卡 1(?!\\d)/.test(l.innerText))`;
  assert.match(await js(`${g1}?.innerText || ''`), /你完成的，要別人驗/, 'G 「G 舊卡 1」一開始就在畫面上、還沒驗收');
  kit.sql(fs.readFileSync(new URL('../migrations/010_verify_human_done.sql', import.meta.url), 'utf8')); // 畫面開著時跑遷移
  await js("(() => { const real = Date.now; Date.now = () => real() + 60_000; return true; })()"); // 讓下一輪輪詢就做增量同步
  await until(async () => (await gSelf()) === 0, 30000, 'G 看得到的舊卡都更新成已驗收');
  assert.ok(await js("[...document.querySelectorAll('.crow-line')].filter(l => /G 舊卡 \\d+/.test(l.innerText) && /已驗收/.test(l.innerText)).length") >= gBefore, 'G 原本待驗收的每一張都顯示已驗收（讀完所有頁，不漏；沒載入過的也會補進來）');
  assert.match(await js(`${g1}?.innerText || ''`), /已驗收/, 'G 「G 舊卡 1」（只讀第一頁會漏的那張）也更新成已驗收');
  const after = new Set(await js("[...document.querySelectorAll('.crow-line [data-card]')].map(b => b.dataset.card)"));
  assert.deepEqual(before.filter(id => !after.has(id)), [], 'G 原本看得到的卡一張都沒有不見');

  // ---------- F 英文介面 ----------
  await size(1280, 900);
  const e1 = await aiDone('EN done card'), eMine = await oldHumanDone(liu.token, L, 'EN my own done card');
  await login(liu.token, '/');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await openList();
  await until(() => js("document.documentElement.lang === 'en' && !document.documentElement.classList.contains('i18n-wait')"), 15000, 'F 英文介面');
  await sleep(400);
  assert.match(await text('.done-batch'), /^Select all Selected 0 Verify \(0\)$/, 'F 批次列英文：' + await text('.done-batch'));
  assert.equal(await js(`${lineOf(e1)}.querySelector('[data-done-ok]').textContent`), 'Verify', 'F 每列 Verify');
  assert.match(await js(`${lineOf(eMine)}.innerText`), /Needs someone else to verify/, 'F 自己完成的（英文）');
  assert.ok(await js(`${lineOf(eMine)}.querySelector('.crow-title').getBoundingClientRect().width > 150`), 'F 英文說明不擠標題（UX）');
  assert.ok(await js(`(() => { const l = ${lineOf(e1)}, t = l.querySelector('.crow-time').getBoundingClientRect(), a = l.querySelector('.crow-act').getBoundingClientRect(); return t.right <= a.left + 1 || t.bottom <= a.top + 1; })()`), 'F Verify 按鈕不蓋日期（UX）');
  assert.ok(await js(`(() => { const l = ${lineOf(eMine)}, t = l.querySelector('.crow-time').getBoundingClientRect(), a = l.querySelector('.crow-act').getBoundingClientRect(); return t.right <= a.left + 1 || t.bottom <= a.top + 1; })()`), 'F 說明不蓋日期（UX）');
  await js(`${lineOf(e1)}.scrollIntoView({ block: 'center' }); true`);
  await shot('04-1280-英文-已完成列表');

  console.log('verify-batch-ui-test：全部通過（英文、等你驗收勾選／全選／驗收通過（N）＋確認、已完成列表每列驗收通過＋批次、看板通過、自己完成的不能驗、遷移 010、1280／375 不橫向捲動）');
} finally {
  await kit.stop();
}
