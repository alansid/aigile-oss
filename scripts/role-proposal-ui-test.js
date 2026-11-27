// 畫面測試：私訊的角色提案是精簡卡＋彈窗
// 1. 私訊只放精簡卡：名稱、代碼、主要職責摘要、五段標籤、「打開提案／不要／有效期限」，沒有輸入框
// 2. 「打開提案」開彈窗：標籤在上內容在下；超過 3 行的段落截斷＋「展開」，標題列有「全部展開」
// 3. 「✎ 修改」整張變表單：輸入框跟著字長高不出捲軸、字數、改過的段有藍點；關彈窗時有沒送出的修改先問；「取消修改」回原文
// 4. 修改後「建立角色」送改過的內容；私訊收成一行，「看內容」開唯讀彈窗
// 5. 代碼衝突：打開直接進修改、黃色提示、游標在代碼
// 6. 沒權限的人：彈窗沒有「修改」「建立角色」，底部寫誰能建立＋「不要」
// 7. 375：彈窗全螢幕、名稱代碼上下兩格、不橫向捲動；彈窗裡按「不要」收成「已略過」
// 8. 英文 1280、375：卡片、彈窗、修改、放棄修改都沒有漏翻
// 用法：node scripts/role-proposal-ui-test.js（ROLE_PROPOSAL_SHOTS=資料夾 會存截圖）
import './test-home.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('role-proposal-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('rpui');
const shotDir = process.env.ROLE_PROPOSAL_SHOTS;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const join = async (name, role) => (await kit.call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('劉昱志', 'PO'), chen = await join('陳小明', 'PG');
  const Cn = chen.participant.participantId;
  assert.equal((await kit.call(liu.token, `/api/participants/${Cn}/projects`, 'PUT', { projects: ['預設專案'] })).status, 200);
  const mkAi = async (tok, name) => { const r = await kit.call(tok, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' }); assert.equal(r.status, 201, JSON.stringify(r.body)); return { id: r.body.participantId, tok: kit.aiToken(r.body.participantId) }; };
  const pgL = await mkAi(liu.token, '劉的PG'), pgC = await mkAi(chen.token, '陳的PG');
  assert.equal((await kit.call(liu.token, '/api/projects/%E9%A0%90%E8%A8%AD%E5%B0%88%E6%A1%88/dm', 'PUT', { on: true })).status, 200);
  const DEF = {
    role: '測試與發布', key: 'REL',
    duties: '把審查通過、負責人已同意提交的 PG 版本合進整合分支（平台版、開源版各一條），跑完整套測試，整理成可以部署的版本，再照規矩請負責人同意部署。合併前先確認差異指紋跟審查通過的一致，合併後在整合版上補跑相關的單支測試，全套測試失敗時先找出是哪一張卡造成的，交回原作者修，不自己動別人的程式。每次部署後追蹤線上版本號，確認畫面與 API 都正常才回報完成。',
    style: '回報一律寫結果：綠／紅、卡在哪、要誰做什麼。附完整 40 碼 SHA、測試通過數、跑的時間。',
    autonomy: '合併已同意提交的 commit 到整合分支、跑全套與單支測試。',
    mustConfirm: '推送 GitHub、部署平台、正式庫遷移：每次都要負責人在本機明確同意。',
    handoff: '部署完成：線上版本號、套用的遷移、包含哪些卡回報群組。',
  };
  const propose = async (ai, body, rid) => { const r = await kit.call(ai.tok, '/api/role-proposals', 'POST', { project: '預設專案', ...DEF, ...body, requestId: rid }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.proposalId; };
  const P0 = await propose(pgL, { key: 'PG', role: '衝突角色' }, 'p0'); // 跟內建代碼衝突
  const P2 = await propose(pgL, { key: 'CHK', role: '品質把關', style: '回報一律寫結果：綠／紅、卡在哪、要誰做什麼。附完整 40 碼 SHA、測試通過數、跑的時間；失敗時貼最短的錯誤那幾行，不貼整段紀錄，也不要猜原因；同一件事一天內只回報一次，有新進度才再發。' }, 'p2'); // 375 用、按「不要」
  const P1 = await propose(pgL, {}, 'p1'); // 主要那張
  const PC = await propose(pgC, { key: 'DOC', role: '文件整理' }, 'pc'); // 一般成員收到的

  const { js, cdp, login, key } = await kit.browser(1280, 900);
  const shot = async name => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); await sleep(250); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const has = sel => js(`!!document.querySelector(${JSON.stringify(sel)})`);
  const card = id => `#dm-list [data-rp-card="${id}"]`;
  const M = '#modal-root .rp-modal';
  const openChat = async (tok, aiId) => {
    await login(tok, '/p/main/messages');
    await until(() => has('[data-dm-toggle]:not([hidden])'), 15000, '私訊按鈕');
    if (!(await js("document.body.classList.contains('dm-open')"))) await click('[data-dm-toggle]:not([hidden])'); // 面板開關會記住
    await sleep(300);
    await until(() => js(`!!document.querySelector('#dm-panel [data-dm-open="${aiId}"], #dm-list .rp-card')`), 10000, '私訊清單或對話');
    await click(`#dm-panel [data-dm-open="${aiId}"]`); // 只有一隻 AI 時直接進對話
    await until(() => has('#dm-list .rp-card'), 10000, '提案卡');
  };
  const typeInto = async (sel, value) => js(`(() => { const t = document.querySelector(${JSON.stringify(sel)}); t.focus(); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  // 1. 精簡卡
  await openChat(liu.token, pgL.id);
  await until(() => has(card(P1)), 5000, 'P1 卡');
  const c1 = await text(card(P1));
  assert.match(c1, /^🧩 角色提案 · 只用在「[^」]+」 測試與發布 REL 把審查通過/, c1);
  assert.match(c1, /主要職責 溝通風格 可自主處理 要先問人 完成與交接 打開提案 不要 \d+\/\d+ \d\d:\d\d 前有效$/, c1);
  assert.equal(await js('document.querySelectorAll("#dm-list input, #dm-list textarea").length'), 0, '私訊卡裡沒有輸入框');
  assert.ok(await js(`(() => { const s = document.querySelector('${card(P1)} .rp-sum'); return s.scrollHeight > s.clientHeight + 2; })()`), '主要職責摘要只顯示 2 行');
  await js(`document.querySelector('${card(P1)}').scrollIntoView({ block: 'end' }); true`);
  await shot('1-精簡卡-1280');

  // 2. 打開提案：唯讀全文、截斷與展開
  await click(`${card(P1)} [data-rp-open]`);
  await until(() => has(M), 5000, '提案彈窗');
  assert.equal(await text(`${M} .rp-kicker`), (await text(`${card(P1)} .rp-head`)), '彈窗頭列同卡片');
  assert.equal(await text(`${M} h2`), '測試與發布 REL');
  assert.equal(await js(`document.querySelector('${M}').getBoundingClientRect().width`), 640, '彈窗 640px');
  assert.deepEqual(await js(`[...document.querySelectorAll('${M} .rp-lab')].map(x => x.textContent)`), ['主要職責', '溝通風格', '可自主處理', '要先問人', '完成與交接'], '標籤在上');
  assert.equal(await js(`document.querySelectorAll('${M} input, ${M} textarea').length`), 0, '預設唯讀');
  assert.deepEqual(await js(`[...document.querySelectorAll('${M} [data-rp-more]')].filter(b => !b.hidden).map(b => b.dataset.rpMore)`), ['duties'], '只有超過 3 行的段落有「展開」');
  assert.equal(await js(`document.querySelector('${M} [data-rp-all]').hidden`), false, '有被截的段：標題列出現「全部展開」');
  assert.equal(await text(`${M} .modal-foot`).then(t => t.replace(/ \S+ \S+ 前有效$/, '')), '建立角色 不要');
  await shot('2-彈窗唯讀-1280');
  await click(`${M} [data-rp-more="duties"]`);
  assert.equal(await text(`${M} [data-rp-more="duties"]`), '收起 ▴');
  assert.ok(await js(`(() => { const t = document.querySelector('${M} [data-rp-txt="duties"]'); return t.scrollHeight <= t.clientHeight + 1; })()`), '展開後全文');
  assert.equal(await js(`document.querySelector('${M} [data-rp-all]').hidden`), true, '都展開了就不出現「全部展開」');
  await click(`${M} [data-rp-more="duties"]`);
  await click(`${M} [data-rp-all]`);
  assert.equal(await text(`${M} [data-rp-more="duties"]`), '收起 ▴', '「全部展開」');

  // 3. 修改：表單、長高、藍點、關之前先問、取消修改
  await click(`${M} [data-rp-edit]`);
  await until(() => has(`${M} textarea[data-rp-f="duties"]`), 3000, '修改模式');
  assert.equal(await js(`document.activeElement.dataset.rpF`), 'role', '游標在名稱');
  assert.deepEqual(await js(`[...document.querySelectorAll('${M} .modal-head input')].map(i => i.value)`), ['測試與發布', 'REL'], '名稱、代碼在上面');
  assert.equal(await js(`(() => { const [a, b] = document.querySelectorAll('${M} .rp-nk label'); return a.getBoundingClientRect().top === b.getBoundingClientRect().top; })()`), true, '名稱、代碼一排兩格');
  const aligned = () => js(`(() => { const t = document.querySelector('${M} textarea').getBoundingClientRect(), k = document.querySelector('${M} input[data-rp-f="key"]').getBoundingClientRect(), r = document.querySelector('${M} input[data-rp-f="role"]').getBoundingClientRect(); return [Math.round(k.right - t.right), Math.round(r.left - t.left)]; })()`);
  const noScroll = () => js(`[...document.querySelectorAll('${M} textarea')].every(t => t.scrollHeight <= t.clientHeight + 2)`);
  assert.ok(await noScroll(), '五段輸入框不出捲軸');
  assert.deepEqual(await aligned(), [0, 0], '名稱、代碼跟下面五段同寬');
  assert.match(await text(`${M} .modal-foot`), /^建立角色 取消修改 .+ 前有效$/);
  const h0 = await js(`document.querySelector('${M} textarea[data-rp-f="autonomy"]').offsetHeight`);
  await typeInto(`${M} textarea[data-rp-f="autonomy"]`, DEF.autonomy + '\n另外：每週一整理上週部署紀錄。\n遇到 CI 紅燈最優先處理，修好才排下一批。');
  assert.ok(await js(`document.querySelector('${M} textarea[data-rp-f="autonomy"]').offsetHeight`) > h0, '輸入框跟著字長高');
  assert.ok(await noScroll(), '長高後還是沒有捲軸');
  assert.equal(await js(`!!document.querySelector('${M} textarea[data-rp-f="autonomy"]').closest('label').querySelector('.rp-dot')`), true, '改過的段有藍點');
  assert.equal(await js(`document.querySelectorAll('${M} .rp-dot').length`), 1, '沒改的段沒有藍點');
  assert.match(await js(`document.querySelector('${M} textarea[data-rp-f="autonomy"]').closest('label').querySelector('.rp-cnt').textContent`), /^\d+\/1000$/);
  await shot('3-彈窗修改-1280');
  await key('Escape');
  await until(() => has('.confirm-root'), 3000, '關之前先問');
  assert.match(await text('.confirm-root'), /要放棄修改嗎？/);
  await shot('4-放棄修改-1280');
  await click('.confirm-root [data-close]') || await key('Escape');
  await until(() => js("!document.querySelector('.confirm-root')"), 3000, '問完關掉');
  assert.ok(await has(M), '選「繼續修改」：彈窗還在');
  assert.match(await js(`document.querySelector('${M} textarea[data-rp-f="autonomy"]').value`), /每週一整理/, '改的字還在');
  await click(`${M} [data-rp-cancel]`);
  assert.equal(await js(`document.querySelectorAll('${M} textarea').length`), 0, '取消修改回唯讀');
  assert.equal(await text(`${M} [data-rp-txt="autonomy"]`), DEF.autonomy, '取消修改回原文');
  await key('Escape');
  await until(() => js(`!document.querySelector('${M}')`), 3000, '沒改：Esc 直接關');

  // 4. 修改後建立
  await click(`${card(P1)} [data-rp-open]`);
  await until(() => has(M), 5000, '再開');
  await click(`${M} [data-rp-edit]`);
  await typeInto(`${M} textarea[data-rp-f="style"]`, '只寫結果與下一步。');
  await click(`${M} [data-rp-create]`);
  await until(() => js(`!document.querySelector('${M}') && !!document.querySelector('${card(P1)}.done')`), 8000, '建立後關彈窗、卡片收成一行');
  assert.match(await text(card(P1)), /^✓ 已建立「測試與發布」（REL） 看內容 ▾$/);
  const roles = (await kit.call(liu.token, '/api/projects')).body.items.find(p => p.id === '預設專案').roles;
  const rel = roles.find(d => d.key === 'REL');
  assert.ok(rel && rel.style === '只寫結果與下一步。' && rel.duties === DEF.duties, '送的是改過的內容，沒改的段照原文');
  await click(`${card(P1)} [data-rp-open]`);
  await until(() => has(M), 5000, '看內容');
  assert.equal(await js(`!!document.querySelector('${M} [data-rp-edit], ${M} [data-rp-create], ${M} [data-rp-skip]')`), false, '已建立的唯讀、沒有按鈕');
  assert.match(await text(`${M} .modal-foot`), /✓ 已建立「測試與發布」（REL）/);
  assert.match(await text(`${M} [data-rp-txt="style"]`), /只寫結果與下一步。/);
  await shot('5-已建立看內容-1280');
  await key('Escape');

  // 5. 代碼衝突
  await click(`${card(P0)} [data-rp-open]`);
  await until(() => has(`${M} input[data-rp-f="key"]`), 5000, '衝突：直接進修改');
  assert.match(await text(`${M} .rp-conflict`), /代碼 PG 已經有角色在用/);
  assert.equal(await js('document.activeElement.dataset.rpF'), 'key', '游標在代碼');
  await shot('6-代碼衝突-1280');
  await key('Escape');
  await until(() => js(`!document.querySelector('${M}')`), 3000, '沒改：直接關');

  // 7. 375：全螢幕、上下兩格、彈窗裡按「不要」
  // 開著彈窗從 1280 縮到 375：段落變長要出現「展開」，已展開的段保持展開
  await click(`${card(P2)} [data-rp-open]`);
  await until(() => has(M), 5000, '1280 開 P2');
  await click(`${M} [data-rp-more="duties"]`);
  assert.equal(await js(`document.querySelector('${M} [data-rp-more="style"]').hidden`), true, '1280 溝通風格沒超過 3 行');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await until(() => js(`!document.querySelector('${M} [data-rp-more="style"]').hidden`), 3000, '縮到 375 後溝通風格出現展開');
  assert.equal(await text(`${M} [data-rp-more="style"]`), '展開 ▾');
  assert.equal(await text(`${M} [data-rp-more="duties"]`), '收起 ▴', '已展開的段保持展開');
  assert.equal(await js(`document.querySelector('${M} [data-rp-all]').hidden`), false, '有被截的段：出現全部展開');
  await key('Escape');
  await until(() => js(`!document.querySelector('${M}')`), 3000, '關掉');
  await sleep(300);
  await js(`document.querySelector('${card(P2)}').scrollIntoView({ block: 'center' }); true`);
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '375 私訊不橫向捲動');
  await shot('7-精簡卡-375');
  await click(`${card(P2)} [data-rp-open]`);
  await until(() => has(M), 5000, '375 彈窗');
  await sleep(250);
  assert.deepEqual(await js(`(() => { const r = document.querySelector('${M}').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()`), [0, 0, 375, 812], '375 全螢幕');
  assert.equal(await js(`!!document.querySelector('${M} [data-rp-edit]')`), true, '375 先唯讀');
  await shot('8-彈窗-375');
  await click(`${M} [data-rp-edit]`);
  assert.equal(await js(`(() => { const [a, b] = document.querySelectorAll('${M} .rp-nk label'); return b.getBoundingClientRect().top > a.getBoundingClientRect().bottom - 1; })()`), true, '375 名稱、代碼上下兩格');
  assert.deepEqual(await aligned(), [0, 0], '375 代碼跟下面五段同寬');
  assert.equal(await js(`(() => { const t = document.querySelector('${M} textarea').getBoundingClientRect(), r = document.querySelector('${M} input[data-rp-f="role"]').getBoundingClientRect(); return Math.round(r.right - t.right); })()`), 0, '375 名稱也滿寬');
  assert.ok(await js(`document.querySelector('${M}').scrollWidth <= 375`), '375 彈窗不橫向捲動');
  await shot('9-彈窗修改-375');
  await click(`${M} [data-rp-cancel]`);
  await click(`${M} [data-rp-skip]`);
  await until(() => js(`!document.querySelector('${M}') && !!document.querySelector('${card(P2)}.done')`), 8000, '彈窗裡按不要');
  assert.match(await text(card(P2)), /^已略過 · 角色提案「品質把關」 看內容 ▾$/);
  await cdp('Emulation.clearDeviceMetricsOverride', {});

  // 6. 沒權限的人
  await openChat(chen.token, pgC.id);
  assert.match(await text(card(PC)), /打開提案 不要/, '沒權限的人主按鈕一樣是「打開提案」');
  await click(`${card(PC)} [data-rp-open]`);
  await until(() => has(M), 5000, '一般成員彈窗');
  assert.equal(await js(`!!document.querySelector('${M} [data-rp-edit], ${M} [data-rp-create]')`), false, '沒有修改、建立角色');
  assert.match(await text(`${M} .modal-foot`), /^只有「[^」]+」的負責人／管理員能按「建立角色」 不要$/);
  await shot('10-沒權限-1280');
  await key('Escape');

  // 8. 英文：卡片、彈窗、修改、放棄修改
  const P3 = await propose(pgL, { key: 'OPS', role: '維運整理' }, 'p3');
  const zh = t => t.split(String.fromCharCode(10)).filter(l => /[一-鿿]/.test(l) && !Object.values(DEF).concat('維運整理', '預設專案').some(v => l.includes(v)));
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await openChat(liu.token, pgL.id);
  await until(() => has(card(P3)), 5000, '英文 P3 卡');
  assert.match(await text(card(P3)), /^🧩 Role proposal · only for "[^"]+" 維運整理 OPS .+ Main responsibilities Communication style .+ Open proposal Dismiss Valid until \S+ \d\d:\d\d$/);
  assert.match(await text(card(P1)), /^✓ Created “測試與發布” \(REL\) View ▾$/);
  assert.match(await text(card(P2)), /^Dismissed · role proposal “品質把關” View ▾$/);
  await js(`document.querySelector('${card(P3)}').scrollIntoView({ block: 'end' }); true`);
  await shot('en-1-精簡卡-1280');
  await click(`${card(P3)} [data-rp-open]`);
  await until(() => js(`!!document.querySelector('${M} [data-rp-edit]') && !document.querySelector('${M} [data-rp-all]').hidden`), 5000, '英文彈窗');
  const enView = await js(`document.querySelector('${M}').innerText`);
  assert.deepEqual(zh(enView), [], '英文彈窗沒有漏翻');
  assert.match(enView, /Expand all[\s\S]*✎ Edit[\s\S]*More ▾[\s\S]*Create role[\s\S]*Dismiss[\s\S]*Valid until/);
  await shot('en-2-彈窗唯讀-1280');
  await click(`${M} [data-rp-edit]`);
  await typeInto(`${M} textarea[data-rp-f="style"]`, '只寫結果。');
  const enEdit = await js(`document.querySelector('${M}').innerText`);
  assert.deepEqual(zh(enEdit), [], '英文修改沒有漏翻');
  assert.match(enEdit, /Name[\s\S]*Code · 2–4 letters[\s\S]*Create role[\s\S]*Cancel edit/);
  await shot('en-3-彈窗修改-1280');
  await key('Escape');
  await until(() => has('.confirm-root'), 3000, '英文放棄修改');
  assert.match(await text('.confirm-root'), /Discard your edits\?[\s\S]*Discard edits/);
  await click('.confirm-root [data-ok]');
  await until(() => js(`!document.querySelector('${M}')`), 3000, '放棄後關掉');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  await js(`document.querySelector('${card(P3)}').scrollIntoView({ block: 'center' }); true`);
  assert.ok(await js('document.documentElement.scrollWidth <= innerWidth + 1'), '英文 375 私訊不橫向捲動');
  await shot('en-4-精簡卡-375');
  await click(`${card(P3)} [data-rp-open]`);
  await until(() => has(M), 5000, '英文 375 彈窗');
  await sleep(250);
  assert.equal(await js(`document.querySelector('${M} [data-rp-txt="style"]').textContent`), DEF.style, '放棄修改後回原文');
  assert.ok(await js(`document.querySelector('${M}').scrollWidth <= 375`), '英文 375 彈窗不橫向捲動');
  await shot('en-5-彈窗-375');
  await cdp('Emulation.clearDeviceMetricsOverride', {});
  await js("localStorage.removeItem('aigile-lang'); true");
  console.log('role-proposal-ui-test：全部通過（精簡卡、彈窗唯讀與展開、修改長高與藍點、放棄修改先問、取消修改、建立送改過的內容、已建立看內容、代碼衝突、375 全螢幕與略過、沒權限、英文 1280／375）');
} finally {
  await kit.stop();
}
