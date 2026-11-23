// 畫面測試：卡片詳情排版
// A. 編輯在右上角、跟關閉並排（⋯ 其他動作不再有編輯）
// B. 人類紀錄：鎖頭縮成一行小字，點「說明」才展開原本的句子
// C. 專案、負責、阻塞收成一列；空的欄位收成一行「還沒填：…　＋ 補上」，點補上開編輯；有填的小標題在上
// D. 相關訊息 0 則不顯示；紀錄輸入框一直在，都沒有時寫一行；變更紀錄預設收起
// E. 1280、375 不橫向捲動
// G. 唯讀成員：右上角沒有編輯、空欄那行沒有「補上」
// F. 英文介面
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 CARD_DETAIL_SHOTS=資料夾 會另外截圖。用法：node scripts/card-detail-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('card-detail-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('cardui');
try {
  const { call } = kit;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const boss = await join('林志明', 'PO');
  const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '示範PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  let rq = 0;
  const mk = async body => (await call(boss.token, '/api/cards', 'POST', { project: '預設專案', requestId: 'c' + (++rq), ...body })).body;
  const empty = await mk({ type: '人類紀錄', title: '卡片要可以傳圖片或檔案', ownerId: boss.participant.participantId });
  const full = await mk({ type: '人類紀錄', title: '卡片要可以傳圖片或檔案（填好）', ownerId: boss.participant.participantId, reason: '卡片的紀錄和交接要能附截圖、檔案，跟訊息一樣可以貼上。', next: '請 UX 出示意圖', criteria: '紀錄可以附 4 張截圖；手機也能傳' });
  await call(boss.token, `/api/cards/${full.cardId}/notes`, 'POST', { text: '先看行動版能不能貼上' });
  const work = await mk({ type: '工作', title: '報價單匯出加上幣別欄', ownerId: ai.participantId, next: '改匯出' });
  const ro = await join('唯讀成員', 'BA');
  await call(boss.token, `/api/participants/${ro.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  assert.equal((await call(boss.token, '/api/members/matrix', 'PUT', { changes: [{ id: ro.participant.participantId, readOnlyIn: ['預設專案'] }] })).status, 200, '設成唯讀');

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.CARD_DETAIL_SHOTS) return; fs.mkdirSync(process.env.CARD_DETAIL_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.CARD_DETAIL_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64')); };
  const text = sel => until(() => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e && !e.getClientRects().length) return null; return [(e?.innerText || '').replace(/\\s+/g, ' ').trim()]; })()`), 5000, '畫出來 ' + sel).then(v => v[0]);
  const open = async (key, tok = boss.token) => {
    await login(tok, '/p/main/work');
    await until(() => js(`!!document.querySelector('[data-card="${key}"]')`), 15000, '工作頁卡片 ' + key);
    await js(`document.querySelector('[data-card="${key}"]').click(); true`);
    await until(() => js("!!document.querySelector('#card-drawer .drawer-body')?.getClientRects().length && !document.documentElement.classList.contains('i18n-wait')"), 8000, '卡片詳情');
  };
  const D = '#card-drawer';
  const blankText = () => js(`(() => { const b = document.querySelector('${D} .dblank'); if (!b) return null; const items = [...b.querySelectorAll('.dblank-k')].map(k => (getComputedStyle(k, '::before').content.replace(/^"|"$/g, '').replace(/^none$/, '')) + k.textContent).join(''); return (b.querySelector('.dblank-l').textContent + (document.documentElement.lang === 'en' ? ' ' : '') + items + ' ' + b.querySelector('[data-act=edit]').textContent).replace(/\\s+/g, ' ').trim(); })()`); // 分隔號在 ::before，要一起讀

  for (const [w, h, tag] of [[1280, 900, '1280'], [375, 812, '375']]) {
    await size(w, h);
    // ---------- 還沒填內容的人類紀錄 ----------
    await open(empty.cardId);
    // A 編輯在右上角，跟關閉並排
    assert.ok(await js(`(() => { const a = document.querySelector('${D} .drawer-head .drawer-acts'); return !!a && !!a.querySelector('[data-act="edit"][title="編輯"]') && !!a.querySelector('[data-close-drawer]'); })()`), `A ${tag} 編輯和關閉並排在右上角`);
    assert.equal(await js(`document.querySelectorAll('${D} .drawer-body .btn[data-act="edit"]').length`), 0, `A ${tag} 內文不再有「編輯」大按鈕`);
    // B 鎖頭一行；點說明才展開
    assert.equal(await text(`${D} .lock-line summary`), '🔒 AI 看不到這張卡，除非你給它卡號。說明 ▾', `B ${tag} 鎖頭一行小字`);
    assert.equal(await js(`document.querySelector('${D} .lock-line').open`), false, `B ${tag} 預設收起`);
    assert.equal(await js(`document.querySelector('${D} .lock-more').getClientRects().length`), 1, `B ${tag} 「說明 ▾」不拆成兩行`);
    assert.equal(await js(`document.querySelectorAll('${D} .lockbar').length`), 0, `B ${tag} 不再有大框`);
    // C 一列＋還沒填
    assert.equal(await text(`${D} .dmeta`), '專案 預設專案 負責 林志明 阻塞 沒有', `C ${tag} 專案、負責、阻塞一列`);
    assert.equal(await blankText(), '還沒填：內容、下一步、完成條件 ＋ 補上', `C ${tag} 空的欄位收成一行`);
    assert.equal(await js(`document.querySelectorAll('${D} .dstack').length`), 0, `C ${tag} 沒有填的就沒有欄位`);
    // D 相關訊息 0 不顯示；紀錄輸入框在；都沒有時一行；變更紀錄收起
    assert.ok(!(await js(`[...document.querySelectorAll('${D} .group-title')].some(g => g.textContent.includes('相關訊息'))`)), `D ${tag} 相關訊息 0 則不顯示`);
    assert.ok(await js(`!!document.querySelector('${D} .note-add #note-text')`), `D ${tag} 紀錄輸入框一直在`);
    assert.equal(await text(`${D} .note-list`), '還沒有紀錄，也沒有相關訊息。', `D ${tag} 都沒有時寫一行`);
    assert.ok(await js(`document.querySelector('${D} .note-add').compareDocumentPosition(document.querySelector('${D} .note-list')) & Node.DOCUMENT_POSITION_FOLLOWING`), `D ${tag} 輸入框在紀錄上面`);
    assert.match(await text(`${D} .dlog-box > summary`), /^變更紀錄（1）$/, `D ${tag} 變更紀錄寫筆數`);
    assert.equal(await js(`document.querySelector('${D} .dlog-box').open`), false, `D ${tag} 變更紀錄預設收起`);
    assert.ok(!(await hscroll()), `E ${tag} 不橫向捲動`);
    await shot(`01-${tag}-還沒填內容的卡`);
    await js(`document.querySelector('${D} .lock-line summary').click(); true`);
    await until(() => js(`document.querySelector('${D} .lock-line').open`), 3000, 'B 展開說明');
    assert.match(await text(`${D} .lock-line p`), /^AI 不會主動看到這張卡。下面的紀錄只存在卡片上，不會發到群組；你給 AI 卡號，它才讀得到卡片和紀錄。$/, `B ${tag} 展開原本的完整句子`);
    // C 補上開編輯；編輯中右上角不再有編輯
    await js(`document.querySelector('${D} .dblank [data-act="edit"]').click(); true`);
    await until(() => js(`!!document.querySelector('${D} #card-edit')`), 5000, 'C 補上開編輯');
    assert.equal(await js(`document.querySelectorAll('${D} .drawer-acts [data-act="edit"]').length`), 0, `A ${tag} 編輯中右上角不放編輯`);
    await js(`document.querySelector('${D} [data-act="cancel-edit"]').click(); true`);

    // ---------- 填好的人類紀錄 ----------
    await open(full.cardId);
    assert.equal(await js(`document.querySelectorAll('${D} .dblank').length`), 0, `C ${tag} 都填了就沒有「還沒填」`);
    assert.deepEqual(await js(`[...document.querySelectorAll('${D} .dstack dt')].map(x => x.textContent)`), ['內容', '下一步', '完成條件'], `C ${tag} 有填的小標題在上`);
    assert.ok(await js(`(() => { const dt = document.querySelector('${D} .dstack dt'), dd = dt.nextElementSibling; return dd.getBoundingClientRect().top >= dt.getBoundingClientRect().bottom - 1; })()`), `C ${tag} 內容在小標題下面`);
    assert.match(await text(`${D} .note-list`), /先看行動版能不能貼上/, `D ${tag} 有紀錄就列出來`);
    assert.ok(!(await text(`${D} .note-list`)).includes('還沒有紀錄'), `D ${tag} 有紀錄就不寫還沒有`);
    assert.ok(!(await hscroll()), `E ${tag} 不橫向捲動`);
    await js(`document.querySelector('${D} .dmeta').scrollIntoView({ block: 'start' }); true`);
    await shot(`02-${tag}-填好的卡`);

    // ---------- 一般工作卡：負責人在狀態那行，一列只放專案、阻塞；⋯ 其他動作沒有編輯 ----------
    await open(work.cardId);
    assert.equal(await text(`${D} .dmeta`), '專案 預設專案 阻塞 沒有', `C ${tag} 工作卡一列不重複放負責人`);
    assert.equal(await blankText(), '還沒填：背景／緣由、完成條件 ＋ 補上', `C ${tag} 工作卡的空欄位`);
    assert.equal(await js(`document.querySelectorAll('${D} .more-acts [data-act="edit"]').length`), 0, `A ${tag} ⋯ 其他動作不再有編輯`);
    assert.ok(await js(`!!document.querySelector('${D} .drawer-acts [data-act="edit"]')`), `A ${tag} 工作卡也是右上角編輯`);
    assert.equal(await js(`document.querySelectorAll('${D} .lock-line').length`), 0, `B ${tag} 只有人類紀錄有鎖頭這行`);
    assert.equal(await js(`[...document.querySelectorAll('${D} .inl-open, ${D} .inl')].filter(e => e.getClientRects().length).length`), 1, `G ${tag} 一般成員照樣有回覆（1280 輸入框、375「決定或回覆…」）`);
    assert.ok(!(await hscroll()), `E ${tag} 不橫向捲動`);
    await shot(`03-${tag}-工作卡`);
  }

  // ---------- G 唯讀成員：右上角沒有編輯、空欄那行沒有「補上」，⋯ 其他動作也看不到 ----------
  for (const [w, h, tag] of [[1280, 900, '1280'], [375, 812, '375']]) {
    await size(w, h);
    await open(work.cardId, ro.token);
    assert.ok(await js("document.body.classList.contains('ro-here')"), `G ${tag} 唯讀成員`);
    assert.ok(await js(`!!document.querySelector('${D} .dblank')`), `G ${tag} 空欄那行照樣顯示`);
    assert.equal(await js(`[...document.querySelectorAll('${D} [data-act="edit"]')].filter(b => b.getClientRects().length).length`), 0, `G ${tag} 看不到任何編輯入口（右上角、補上、⋯ 其他動作）`);
    assert.ok(!(await js(`[...document.querySelectorAll('${D} .group-title')].some(e => e.getClientRects().length && e.textContent.trim() === '想法與回覆')`)), `G ${tag} 沒有輸入框就不顯示「想法與回覆」小標題`);
    assert.equal(await js(`[...document.querySelectorAll('${D} .inl-open, ${D} .drawer-compose, ${D} .inl')].filter(e => e.getClientRects().length).length`), 0, `G ${tag} 沒有「決定或回覆…」按鈕與輸入框`);
    assert.ok(!(await hscroll()), `E ${tag} 不橫向捲動`);
    await shot(`05-${tag}-唯讀成員`);
  }

  // ---------- F 英文介面 ----------
  await size(1280, 900);
  await login(boss.token, '/');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await open(empty.cardId);
  await until(() => js("document.documentElement.lang === 'en'"), 15000, 'F 英文介面');
  await sleep(300);
  assert.equal(await text(`${D} .lock-line summary`), "🔒 AIs can't see this card unless you give them its number.More ▾", 'F 鎖頭一行');
  assert.equal(await text(`${D} .dmeta`), 'Project Default project Owner 林志明 Blocked None', 'F 一列');
  assert.equal(await blankText(), 'Not filled in yet: Details, Next step, Done when ＋ Add', 'F 還沒填');
  assert.equal(await text(`${D} .note-list`), 'No notes or related messages yet.', 'F 都沒有');
  assert.equal(await text(`${D} .dlog-box > summary`), 'Change history (1)', 'F 變更紀錄');
  assert.equal(await js(`document.querySelector('${D} .drawer-acts [data-act="edit"]').title`), 'Edit', 'F 編輯提示');
  await shot('04-1280-英文-還沒填內容的卡');

  console.log('card-detail-ui-test：全部通過（編輯在右上、鎖頭一行、專案／負責／阻塞一列、空欄位收成一行、相關訊息 0 不顯示、紀錄輸入框、變更紀錄收起、英文、1280／375 不橫向捲動）');
} finally {
  await kit.stop();
}
