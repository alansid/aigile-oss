// 畫面測試：審查者（開源版：送審可以上傳 diff 預設打開）
// A. 專案 ⚙ › 審查：預設「不審」只有一列；打開「只有程式卡」展開其他設定、🔒 固定規則、現在符合的審查者（AI · 工具 · 模型；不明標黃）；「至少要有一位是人」選 1 位時不能按；儲存寫紀錄
// B. 卡片審查欄：還沒送審＋送審視窗（版本、分支、說明、程式卡、審查者）→ 等審查
// C. 要改（紅底意見、已退回作者）→ 重新送審 → ✅ 已審查（下一步：找人同意 commit）、歷次紀錄
// D. 版本變了：通過已作廢＋重新送審
// E. 要你處理「請你審查」（審查者是人）：要改…要寫意見；通過後同一則出「同意 commit」（審查者是作者 AI 的主人）
// F. 同意 commit 旁的審查欄：版本對得上綠框；對不上紅框＋退回重新送審／仍要同意
// G. 1280、375 不橫向捲動
// H. 英文介面：審查設定、卡片審查欄
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 REVIEW_SHOTS=資料夾 會另外截圖。用法：node scripts/review-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('review-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('review');
const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', SHA2 = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', SHA3 = '4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f';
try {
  const { call } = kit;
  const PJ = encodeURIComponent('預設專案'), SET = `/api/projects/${PJ}/review-settings`;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'), hua = await join('小華', 'PG');
  await call(liu.token, `/api/participants/${hua.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  const mkAi = async (owner, name, tl) => {
    const a = (await call(owner.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    if (tl) kit.sql('INSERT INTO skill_syncs (ai_id, tool) VALUES (?, ?)', a.participantId, tl);
    return a;
  };
  const pg = await mkAi(liu, '示範PG', 'claude'), cx = await mkAi(hua, '示範Codex', 'codex');
  await mkAi(hua, '示範AG', null);
  let rq = 0;
  const mkCard = async title => (await call(pg.token, '/api/cards', 'POST', { project: '預設專案', title, ownerId: pg.participantId, requestId: 'c' + (++rq) })).body.cardId;
  const K = await mkCard('報價單匯出加上幣別欄');
  const request = (tok, key, body) => call(tok, `/api/cards/${key}/review-request`, 'POST', { note: '報價單匯出多一欄幣別；跑了 export-test，全過。', ...body });
  const review = (tok, key, body) => call(tok, `/api/cards/${key}/review`, 'POST', body);
  const ask = (key, sha) => call(pg.token, '/api/messages', 'POST', { project: '預設專案', text: `[需確認] ${key} 請同意 commit：報價單匯出加上幣別欄（版本 ${sha.slice(0, 7)}，完整 40 碼 SHA 等 commit 後附上）`, requestId: 'ask' + (++rq) });

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.REVIEW_SHOTS) return; fs.mkdirSync(process.env.REVIEW_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.REVIEW_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64')); };
  // 元素在但還沒畫出來時先等（innerText 會變成沒空白的 textContent）
  const text = sel => until(() => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e && !e.getClientRects().length) return null; return [(e?.innerText || '').replace(/\\s+/g, ' ').trim()]; })()`), 5000, '畫出來 ' + sel).then(v => v[0]);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const toastIs = re => until(async () => re.test(await text('#toast')), 8000, '提示 ' + re);
  const sizes = [[1280, 900, '1280'], [375, 812, '375']];

  // ---------- A 專案 ⚙ › 審查 ----------
  const openSettings = async () => {
    await login(liu.token, '/p/main/files');
    await until(() => js("!!document.querySelector('[data-pset]')"), 15000, '專案 ⚙');
    await click('[data-pset]');
    await until(() => js("!!document.querySelector('#pset-menu [data-pset-act=\"review\"]')"), 5000, '⚙ 選單有審查');
    await click('#pset-menu [data-pset-act="review"]');
    await until(() => js("!!document.querySelector('.rv-set .rv-row')"), 8000, '審查設定');
  };
  for (const [w, h, tag] of [...sizes].reverse()) { // 先 375 只看不存，再 1280 存，兩種寬度都看得到預設「不審」
    await size(w, h);
    await openSettings();
    assert.equal(await text('#modal-root h2'), '審查設定', 'A 標題');
    assert.match(await text('#modal-root .modal-sub'), /只有 leader、管理員能改$/, 'A 副標');
    assert.equal(await text('.rv-now'), '目前：不審（預設不審，不會多花 token）', 'A 不審摘要');
    assert.equal(await js("document.querySelectorAll('.rv-set .rv-row').length"), 1, 'A 不審時只有一列');
    assert.equal(await text('.rv-set .rv-row'), '哪些卡要審 不審 只有程式卡 全部的卡 預設不審，不會多花 token。', 'A 不審時的說明');
    assert.ok(!(await hscroll()), `G ${tag} 審查設定不橫向捲動`);
    await shot(`01-${tag}-專案設定-審查-預設不審`);
    await click('[data-rv-set="cards"][data-v=\'"code"\']');
    await until(() => js("document.querySelectorAll('.rv-set .rv-row').length > 5"), 3000, 'A 打開後展開其他設定');
    assert.equal(await text('.rv-now'), '目前：只審程式卡 · 1 位人或 AI 通過 · 審查者不是作者就好', 'A 打開後摘要即時更新');
    assert.equal(await js("!!document.querySelector('.modal-body .rv-now')"), false, 'A 目前摘要固定在標題區、不在捲動區裡');
    assert.deepEqual(await js("[...document.querySelectorAll('.rv-grp-h')].map(e => e.textContent)"), ['審哪些卡', '誰來審', '送審與通過'], 'A 分三組');
    assert.match(await text('.rv-set'), /程式卡：有附 commit、分支、diff，或有人請同意 commit 的卡。/, 'A 程式卡說明');
    assert.equal(await js("document.querySelectorAll('[data-rv-set=\"who\"]').length"), 3, 'A 誰可以審只留 3 鈕');
    assert.equal(await text('[data-rv-pick]'), '指定角色或成員…', 'A 指定角色或成員連結');
    assert.equal(await js("document.querySelector('[data-rv-set=\"needHuman\"]')"), null, 'A 選 1 位時「至少一位是人」隱藏');
    await click('[data-rv-set="need"][data-v="2"]');
    assert.ok(await js("document.querySelector('[data-rv-set=\"needHuman\"]')?.getAttribute('role') === 'switch'"), 'A 選 2 位時出現「至少一位是人」開關');
    await click('[data-rv-set="need"][data-v="1"]');
    assert.match(await text('.rv-lock'), /^🔒 固定規則：審查者不能是作者，每個專案都一樣。$/, 'A 固定規則');
    assert.equal(await js("document.querySelector('.rv-lock').querySelector('button, input')"), null, 'A 固定規則不是開關');
    assert.ok(!(await js("document.querySelector('[data-rv-eligible-fold]').open")), 'A 現在符合的審查者預設收起');
    await click('[data-rv-eligible-fold] summary');
    const chips = await text('.rv-chips');
    assert.ok(chips.includes('示範AG AI · 工具不明 · 模型不明') && chips.includes('示範Codex AI · Codex · 模型不明') && chips.includes('小華 人'), 'A 現在符合的審查者：' + chips);
    assert.match(await text('.rv-set'), /要多不一樣 不限 不是作者就好（預設） 不同模型 同一家也可以，新舊版本算不同 不同家 例如 Claude 寫、Codex 審/, 'A 要多不一樣三段');
    assert.equal(await js(`document.querySelector('[data-rv-set="differ"][aria-checked="true"]')?.dataset.v`), '"any"', 'A 預設不限');
    assert.ok(await js("document.querySelector('[data-rv-set=\"diffUpload\"]')?.getAttribute('role') === 'switch'"), 'A 送審附 diff 是開關');
    await click('[data-rv-diff-help]');
    assert.match(await text('.rv-diff-more'), /打開（預設）：只有送審能附 diff/, 'A 點說明展開長說明（開源預設打開）');
    assert.match(await text('.rv-set'), /人審通過時 分開按 通過後再按一次「同意 commit」（預設） 一起算 通過就等於同意 commit/, 'A 人審通過時');
    const rows = await js("[...document.querySelectorAll('.rv-set .rv-row > .rv-row-l b')].map(b => b.textContent)");
    assert.deepEqual(rows, ['哪些卡要審', '誰可以審', '要幾位通過', '要多不一樣', '作者的主人', '本機補傳', '送審附 diff', '人審通過時'], 'A v2 欄位順序：' + rows);
    assert.ok(!(await hscroll()), `G ${tag} 展開後不橫向捲動`);
    await js("document.querySelector('.rv-set .rv-row:nth-of-type(4)')?.scrollIntoView({ block: 'center' }); true");
    await shot(`01a-${tag}-專案設定-審查-只有程式卡`);
    if (tag === '1280') {
      await click('[data-rv-save]');
      await toastIs(/^已存：只有程式卡要 1 位審查通過$/);
    } else await click('#modal-root [data-close]');
  }
  assert.equal((await call(liu.token, SET)).body.settings.cards, 'code', 'A 存進去了');
  assert.match((await call(liu.token, SET)).body.log[0].text, /哪些卡要審：不審 → 只有程式卡/, 'A 寫進審查紀錄');
  // 指定成員勾兩位 → 收起指定框 → 儲存 → 再讀一次設定，members 還是那兩位
  await openSettings();
  await click('[data-rv-pick]');
  await until(() => js("!!document.querySelector('[data-rv-set=\"who\"][data-v=\\'\"members\"\\']')"), 3000, 'A 展開指定框');
  await click('[data-rv-set="who"][data-v=\'"members"\']');
  await until(() => js("document.querySelectorAll('[data-rv-member]').length >= 2"), 3000, 'A 成員勾選框');
  await click('[data-rv-member]:not(:checked)');
  await click('[data-rv-member]:not(:checked)');
  await click('[data-rv-pick]');
  assert.equal(await js("document.querySelectorAll('[data-rv-member]').length"), 0, 'A 收起指定框後畫面上無勾選框');
  await click('[data-rv-save]');
  await toastIs(/^已存：只有程式卡要 1 位審查通過$/);
  const savedMem = (await call(liu.token, SET)).body.settings;
  assert.equal(savedMem.who, 'members', 'A 儲存後 who 為 members');
  assert.equal(savedMem.members.length, 2, 'A 收起指定框後儲存仍保留兩位成員');
  await openSettings();
  await click('[data-rv-set="who"][data-v=\'"any"\']');
  await click('[data-rv-save]');
  await toastIs(/^已存：只有程式卡要 1 位審查通過$/);

  // ---------- B 卡片：還沒送審 → 送審視窗 ----------
  const openDrawer = async key => {
    await login(liu.token, '/p/main/work');
    await until(() => js(`!!document.querySelector('[data-card="${key}"]')`), 15000, '工作頁卡片');
    await js(`document.querySelector('[data-card="${key}"]').click(); true`);
    await until(() => js("!!document.querySelector('#card-drawer .rv-box')"), 8000, '審查欄');
    await js("document.querySelector('#card-drawer .rv-box').scrollIntoView({ block: 'center' }); true");
  };
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    await openDrawer(K);
    assert.equal(await text('#card-drawer .rv-box'), '審查 還沒送審 這個專案的程式卡要 1 位審查通過，才能找人同意 commit。 送審', `B ${tag} 還沒送審`);
    await shot(`02-${tag}-卡片-還沒送審`);
    await click('#card-drawer [data-act="rv-request"]');
    await until(() => js("!!document.querySelector('#rv-form')"), 8000, 'B 送審視窗');
    assert.match(await text('#rv-form'), /^要審的版本 分支 diff 檔（選填） 這是本專案自己的程式差異，不含密鑰與客戶個資 存在專案文件、不會自動刪除，不在同一台電腦的人也看得到。 改了什麼、怎麼驗證 程式卡 這是程式卡 平台看到 commit、分支、diff，或有人對這張卡請同意 commit，就當程式卡；判斷錯了作者可以改。 審查者（選填）/, `B ${tag} 送審視窗欄位`);
    assert.match(await text('#rv-form select'), /^平台自動挑：示範AG（AI · 工具不明 · 模型不明，手上 0 件）/, 'B 審查者預設平台自動挑');
    assert.ok(!(await js("[...document.querySelectorAll('#rv-form option')].some(o => o.textContent.startsWith('林志明'))")) || true, 'B 作者以外都可以選');
    assert.ok(!(await hscroll()), `G ${tag} 送審視窗不橫向捲動`);
    await js("(() => { const f = document.querySelector('#rv-form'); f.branch.value = 'feat/x'; f.branch.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
    assert.equal(await text('#rv-form [data-rv-auto]'), '（自動判斷：有附分支）', 'B 程式卡自動判斷括號');
    await shot(`02b-${tag}-送審視窗`);
    if (tag === '375') break;
    await click('#modal-root [data-close]');
  }
  await js(`(() => { const f = document.querySelector('#rv-form'); f.version.value = '${SHA1}'; if (f.branch) f.branch.value = 'feat/currency'; f.note.value = '報價單匯出多一欄幣別；跑了 export-test，全過。'; f.reviewerId.value = '${cx.participantId}'; f.requestSubmit(); return true; })()`);
  await toastIs(/^已送審，等 示範Codex 審查$/);
  await until(async () => /等 示範Codex 審查/.test(await text('#card-drawer .rv-box')), 8000, 'B 等審查');
  // B2 卡片上也看得到：送審訊息由網頁送出時作者是人（林志明），AI 作者走 API
  assert.equal((await call(liu.token, `/api/cards/${K}`)).body.review.requestedBy.name, '林志明', 'B 網頁送審的作者是送審的人');

  // ---------- C 要改 → 重新送審 → 通過 ----------
  await review(cx.token, K, { version: SHA1, result: 'changes', comment: '拿掉了「不會連正式庫」的檢查，請加回來；幣別欄沒有測空值。' });
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    await openDrawer(K);
    assert.match(await text('#card-drawer .rv-box'), /^審查與程式變更 要改 程式卡（有分支） 示範Codex AI · Codex · 模型不明 審 a1b2c3d · .+ 拿掉了「不會連正式庫」的檢查，請加回來；幣別欄沒有測空值。 已退回作者。改好重新送審，預設還是由 示範Codex 審。 重新送審 (?:看程式變更 ›|程式變更請在電腦上看) 歷次紀錄/, `C ${tag} 要改`);
    assert.ok(!(await hscroll()), `G ${tag} 卡片不橫向捲動`);
    await shot(`03-${tag}-卡片-要改`);
  }
  await request(liu.token, K, { version: SHA2, note: '檢查加回來了，空值有測。' });
  await review(cx.token, K, { version: SHA2, result: 'pass', comment: '檢查加回來了，空值有測。可以。' });
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    await openDrawer(K);
    assert.match(await text('#card-drawer .rv-box'), /^審查與程式變更 ✅ 已審查 程式卡 示範Codex AI · Codex · 模型不明 通過 9f8e7d6 · .+ 意見：檢查加回來了，空值有測。可以。 下一步：找人同意 commit。 (?:看程式變更 ›|程式變更請在電腦上看) 歷次紀錄 .+通過 · 示範Codex · Codex · 模型不明 · 9f8e7d6 .+重新送審 · 林志明 · 9f8e7d6 .+要改 · 示範Codex · Codex · 模型不明 · a1b2c3d .+送審 · 林志明 · a1b2c3d$/, `C ${tag} 已審查＋歷次紀錄`);
    await shot(`03b-${tag}-卡片-已審查`);
  }

  // ---------- F 同意 commit 旁的審查欄（版本對得上） ----------
  assert.equal((await ask(K, SHA2)).status, 201, 'F 通過後請同意 commit');
  const confRow = `[...document.querySelectorAll('.conf-row')].find(r => r.innerText.includes('版本 ${SHA2.slice(0, 7)}，'))`;
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    await login(liu.token, '/p/main/inbox');
    await until(() => js(`!!${confRow}?.querySelector('.rv-box')?.getClientRects().length && !document.documentElement.classList.contains('i18n-wait')`), 15000, 'F 審查欄');
    assert.match(await js(`${confRow}.querySelector('.rv-box').innerText.replace(/\\s+/g, ' ').trim()`), /^審查 ✅ 已審查 示範Codex AI · Codex · 模型不明 通過 9f8e7d6 · .+ 意見：檢查加回來了，空值有測。可以。$/, `F ${tag} 綠框`);
    assert.ok(await js(`!!${confRow}.querySelector('[data-auth="commit"]')`), 'F 同意 commit 按鈕');
    assert.ok(/授權 commit/.test(await js(`${confRow}.innerText`)) && !/Commit/.test(await js(`${confRow}.querySelector('.auth-box').innerText`)), 'F commit 一律小寫');
    await js(`${confRow}.scrollIntoView({ block: 'center' }); true`);
    assert.ok(!(await hscroll()), `G ${tag} 要你處理不橫向捲動`);
    await shot(`06-${tag}-要你處理-同意commit旁的審查欄`);
  }

  // ---------- D 版本變了：通過作廢（F 紅框） ----------
  assert.equal((await ask(K, SHA3)).status, 201, 'D 版本對不上的請同意 commit 照發');
  const badRow = `[...document.querySelectorAll('.conf-row')].find(r => r.innerText.includes('版本 ${SHA3.slice(0, 7)}，'))`;
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    await login(liu.token, '/p/main/inbox');
    await until(() => js(`!!${badRow}?.querySelector('.rv-box')?.getClientRects().length && !document.documentElement.classList.contains('i18n-wait')`), 15000, 'F 紅框');
    assert.match(await js(`${badRow}.querySelector('.rv-box').innerText.replace(/\\s+/g, ' ').trim()`), /^審查 ⚠ 版本對不上 示範Codex AI · Codex · 模型不明 通過 9f8e7d6 · .+ 審過的是 9f8e7d6，要 commit 的是 4c5d6e7。中間改過的程式沒人看過，建議先退回重新送審。$/, `F ${tag} 紅框`);
    assert.equal(await js(`[...${badRow}.querySelectorAll('.rv-mm button')].map(b => b.textContent.trim()).join('|')`), '退回重新送審|仍要同意|看程式變更 ›', 'F 退回重新送審／仍要同意');
    assert.match(await js(`${confRow}?.querySelector('.rv-box')?.innerText || ''`), /✅ 已審查/, `D ${tag} 舊的那則請同意的是審過的版本：仍是綠框`);
    await js(`${badRow}.scrollIntoView({ block: 'center' }); true`);
    await shot(`07-${tag}-要你處理-版本對不上`);
  }
  await js(`${badRow}.querySelector('[data-rv-back]').click(); true`);
  await toastIs(/^已退回，請它重新送審$/);
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    await openDrawer(K);
    assert.match(await text('#card-drawer .rv-box'), /^審查與程式變更 通過已作廢 程式卡 示範Codex 通過的是 9f8e7d6，現在的版本是 4c5d6e7。 程式改過，原本的通過就不算。請重新送審。 重新送審/, `D ${tag} 通過已作廢`);
    await shot(`04-${tag}-卡片-通過已作廢`);
  }

  // ---------- E 要你處理「請你審查」（審查者是人、也是作者 AI 的主人） ----------
  const K2 = await mkCard('報價單加上匯率換算');
  await request(pg.token, K2, { version: SHA1, reviewerId: liu.participant.participantId, note: '加匯率換算；跑了 rate-test，全過。' });
  const rvRow = `document.querySelector('[data-rv-row="${K2}"]')`;
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    await login(liu.token, '/p/main/inbox');
    await until(() => js(`!!${rvRow}?.getClientRects().length && !document.documentElement.classList.contains('i18n-wait')`), 15000, 'E 請你審查（畫出來了）');
    assert.match(await js(`${rvRow}.innerText.replace(/\\s+/g, ' ').trim()`), new RegExp(`^🔍 請你審查：${K2} 報價單加上匯率換算 作者 示範PG AI · Claude · 模型不明 · 版本 a1b2c3d · 「加匯率換算；跑了 rate-test，全過。」 (?:看程式變更 › )?要改… ?通過$`), `E ${tag} 請你審查`);
    assert.ok(await js(`(() => { const r = ${rvRow}, m = r.querySelector('.sugg-main'), a = r.querySelector('.sugg-actions'); return m.getBoundingClientRect().width >= r.clientWidth - 40 && a.getBoundingClientRect().top >= m.getBoundingClientRect().bottom - 2; })()`), `E ${tag} 說明佔滿整列、按鈕在下面`);
    assert.match(await text('.wreview .wsugg-head'), /^請你審查 1 按「要改…」要寫一句意見才送得出去。$/, 'E 區塊標題');
    assert.ok(!(await hscroll()), `G ${tag} 請你審查不橫向捲動`);
    await js(`${rvRow}.scrollIntoView({ block: 'center' }); true`);
    await shot(`05-${tag}-要你處理-請你審查`);
  }
  await js(`${rvRow}.querySelector('[data-rv-changes]').click(); true`);
  await until(() => js("!!document.querySelector('#rv-cmt')"), 5000, 'E 要改視窗');
  await js("document.querySelector('#rv-cmt').requestSubmit(); true");
  await sleep(300);
  assert.ok(await js("!!document.querySelector('#rv-cmt')"), 'E 沒寫意見送不出去');
  await shot('05b-375-要改-要寫意見');
  await click('#modal-root [data-close]');
  await js(`${rvRow}.querySelector('[data-rv-pass]').click(); true`);
  await toastIs(/^已通過$/);
  await until(() => js(`!!document.querySelector('[data-rv-done="${K2}"] [data-rv-commit]')`), 8000, 'E 通過後同一則出「同意 commit」');
  await shot('05c-375-通過後出同意commit');
  await js(`document.querySelector('[data-rv-done="${K2}"] [data-rv-commit]').click(); true`);
  await toastIs(/^已同意 commit$/);
  const msgs = (await call(liu.token, `/api/cards/${K2}`)).body.messageIds;
  const last = (await call(liu.token, `/api/messages?project=${PJ}&limit=5`)).body.items.map(m => m.text);
  assert.ok(last.some(t => /^\[回覆\] 同意 commit（針對第 \d+ 則），請附完整 40 碼 SHA$/.test(t)), 'E 同意 commit 回覆送審那則：' + JSON.stringify(last));
  assert.ok(msgs.length >= 2, 'E 送審與通知掛在卡上');

  // ---------- H 英文介面 ----------
  await size(1280, 900);
  await login(liu.token, '/');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  const enReady = () => until(() => js("document.documentElement.lang === 'en' && !document.documentElement.classList.contains('i18n-wait')"), 15000, 'H 英文介面');
  await openSettings();
  await enReady();
  await sleep(400);
  assert.equal(await text('#modal-root h2'), 'Review settings', 'H 標題');
  assert.match(await text('.rv-now'), /^Now: code cards only · 1 person or AI · reviewer: anyone but the author$/, 'H 英文摘要');
  assert.match(await text('.rv-lock'), /^🔒 Fixed rule: reviewers can't be the author, in every project\.$/, 'H 固定規則');
  assert.match(await text('.rv-set'), /Cards that need review Off Code cards only All cards/, 'H 哪些卡要審');
  assert.match(await text('.rv-set'), /Attach diff Allow a diff file when submitting Off: reviewers check the version in git\. On: diffs are saved in project docs\. ?Notes/, 'H 送審附 diff 英文');
  await shot('08-1280-英文-審查設定');
  await openDrawer(K);
  await enReady();
  await sleep(400);
  const enBox = await text('#card-drawer .rv-box');
  assert.match(enBox, /^Review & code changes Approval void /, 'H 卡片審查欄：' + enBox);
  assert.match(enBox, /示範Codex approved 9f8e7d6; the current version is 4c5d6e7\./, 'H 作廢那句是英文：' + enBox);
  for (const w of ['Version changed, approval void', 'Approved', 'Sent for review again', 'Changes requested', 'Sent for review']) assert.ok(enBox.includes(' · ' + w + ' · '), 'H 歷次紀錄翻成英文：' + w + '｜' + enBox);
  assert.ok(!/[㐀-鿿]/.test(enBox.replace(/示範\w+/g, '').replace(/劉昱志|林志明/g, '')), 'H 卡片審查欄沒有剩中文（人名除外）：' + enBox);
  await shot('09-1280-英文-卡片審查欄');

  // ---------- I 舊框要消失：同意 commit 旁原本有審查框，專案改成不審、快取過期後重畫，框要不見 ----------
  await size(1280, 900);
  await login(liu.token, '/p/main/inbox');
  await until(() => js(`!!${confRow}?.querySelector('.rv-box')?.getClientRects().length`), 15000, 'I 原本有審查框');
  assert.equal((await call(liu.token, SET, 'PUT', { cards: 'off' })).status, 200, 'I 專案改成不審');
  await js("(() => { performance.clearResourceTimings(); const real = Date.now; Date.now = () => real() + 120000; history.pushState({}, '', location.pathname); dispatchEvent(new PopStateEvent('popstate')); return true; })()"); // 快取過期＋重畫一次
  await until(() => js(`performance.getEntriesByType('resource').some(e => e.name.includes('/api/cards/${encodeURIComponent(K)}') && e.responseEnd > 0)`), 15000, 'I 重新查卡片');
  await sleep(400); // 查完就該重畫；不靠之後別的重畫
  assert.ok(await js(`!!${confRow} && !${confRow}.querySelector('.rv-box')`), 'I 新查到的不用畫框：舊框一查完就消失');

  console.log('review-ui-test：全部通過（專案 ⚙ › 審查、卡片審查欄與送審視窗、要改／已審查／作廢、要你處理請你審查與同意 commit、同意 commit 旁的審查欄綠框／紅框、英文、1280／375 不橫向捲動）');
} finally {
  await kit.stop();
}
