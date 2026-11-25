// 卡片抽屜：底部固定輸入區（先選回覆／紀錄／交接／退回再打字）、時間軸、標題下「改狀態 ▾」
// - 工作卡：分段鈕回覆／紀錄／交接；記一筆紀錄（只存卡上）＋附檔，時間軸出現紀錄與附件；回覆附檔存成卡片附件
// - 交接分頁：選人、按鈕寫「交接給 X」、交接後負責人換人
// - 人類紀錄卡：沒有回覆、預設停在紀錄；改狀態選單有收集中／已整理
// - 唯讀成員不顯示輸入區；1280／375 不橫向捲動
// 本機暫存資料庫，不連正式站。用法：node scripts/card-drawer-input-ui-test.js（DRAWER_INPUT_SHOTS=資料夾 會存截圖）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startKit, until } from './browser-kit.js';

const kit = await startKit('drawer-input');
const shotDir = process.env.DRAWER_INPUT_SHOTS;
try {
  const { body: liu } = await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' });
  const { body: wang } = await kit.call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' });
  assert.equal((await kit.call(liu.token, '/api/participants/' + wang.participant.participantId + '/projects', 'PUT', { projects: ['預設專案'] })).status, 200, '王小明加進預設專案');
  const mk = async (type, title) => { const { body, status } = await kit.call(liu.token, '/api/cards', 'POST', { project: '預設專案', type, title, requestId: 'r-' + title, ownerId: liu.participant.participantId }); assert.equal(status, 201, JSON.stringify(body)); return body; };
  const work = await mk('工作', '報價單匯出加上幣別欄');
  const note = await mk('人類紀錄', '會議紀錄');
  const { js, cdp, login } = await kit.browser(1280, 900);
  const shot = async name => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const open = async id => {
    await login(liu.token, '/p/main/work');
    await until(() => js(`!!document.querySelector('[data-card="${id}"]')`), 15000, 'card ' + id);
    await js(`document.querySelector('[data-card="${id}"]').click(); true`);
    await until(() => js("!!document.querySelector('.drawer .dcompose')"), 8000, 'composer');
  };
  const tabs = () => js("[...document.querySelectorAll('.dcompose [data-cmode]')].map(b => b.textContent + (b.getAttribute('aria-selected') === 'true' ? '*' : ''))");
  const noHScroll = () => js('document.documentElement.scrollWidth <= innerWidth + 1');

  // 1. 工作卡：回覆／紀錄／交接，預設回覆；沒有舊的「想法與回覆」「相關訊息」「發生了什麼」區塊
  await open(work.cardId);
  assert.deepEqual(await tabs(), ['回覆*', '紀錄', '交接'], '工作卡分段鈕（不是驗收的人，沒有退回）');
  assert.equal(await js("[...document.querySelectorAll('.drawer .group-title')].map(x => x.textContent).filter(t => /想法與回覆|相關訊息|發生了什麼/.test(t)).length"), 0, '舊的三個清單合成時間軸');
  assert.ok(await js("!!document.querySelector('.drawer .timeline')"), '有時間軸');
  assert.ok(await js("!!document.querySelector('.drawer-status .st-menu summary')"), '標題下有「改狀態 ▾」');
  assert.equal(await js("!!document.querySelector('.card-files [data-add-file], .card-file-drop')"), false, '附件區只看，不再有自己的上傳框');
  const fixed = await js("(() => { const c = document.querySelector('.dcompose'), d = document.querySelector('.drawer'); return Math.abs(c.getBoundingClientRect().bottom - d.getBoundingClientRect().bottom) < 2; })()");
  assert.ok(fixed, '輸入區固定在抽屜底部');
  await shot('work-1280-reply');

  // 2. 紀錄：記一筆（只存卡上）＋附一個檔，時間軸出現紀錄和附件
  await js("document.querySelector('.dcompose [data-cmode=\"note\"]').click(); true");
  await until(() => js("!!document.querySelector('#note-text')"), 5000, 'note mode');
  await js(`(() => { const ta = document.querySelector('#note-text'); ta.value = '客戶要的是左邊這版。'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    const dt = new DataTransfer(); dt.items.add(new File(['sample agenda'], 'agenda.txt', { type: 'text/plain' }));
    ta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
  await until(() => js("!!document.querySelector('.dcompose [data-att-declare]')"), 5000, 'declare box');
  await js("document.querySelector('.dcompose [data-att-declare]').click(); true");
  await shot('work-1280-note');
  await js("document.querySelector('.dcompose [data-act=\"add-note\"]').click(); true");
  await until(() => js("!!document.querySelector('.timeline .tl-note') && /agenda\\.txt/.test(document.querySelector('.timeline .tl-note').innerText)"), 10000, 'note with file in timeline');
  assert.match(await js("document.querySelector('.timeline .tl-note').innerText"), /紀錄（只存卡上）[\s\S]*客戶要的是左邊這版/, '時間軸那則標「紀錄（只存卡上）」');
  assert.match(await js("document.querySelector('.card-files')?.innerText || ''"), /agenda\.txt/, '附件也列進附件區');
  assert.equal(await js("document.querySelector('.dcompose [data-cmode][aria-selected=\"true\"]').dataset.cmode"), 'note', '送出後停在原分頁');
  // 2b. 紀錄附兩個檔、第二個上傳失敗：留著沒存上的並顯示「重試上傳附件」；重試後仍只有一筆紀錄、每個附件一份
  await js(`(() => { const real = window.fetch; let n = 0; window.fetch = (u, o) => {
    if (String(u).includes('/docs?') && o?.method === 'POST' && ++n === 2) return Promise.resolve(new Response(JSON.stringify({ error: { message: '模擬失敗' } }), { status: 500, headers: { 'Content-Type': 'application/json' } }));
    return real(u, o); }; return true; })()`);
  const notesBefore = (await kit.call(liu.token, `/api/cards/${work.cardId}`)).body.notes.length;
  await js(`(() => { const ta = document.querySelector('#note-text'); ta.value = '兩個附件，第二個會失敗'; ta.dispatchEvent(new Event('input', { bubbles: true }));
    const dt = new DataTransfer(); dt.items.add(new File(['first'], 'first.txt', { type: 'text/plain' })); dt.items.add(new File(['second'], 'second.txt', { type: 'text/plain' }));
    ta.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })); return true; })()`);
  await until(() => js("!!document.querySelector('.dcompose [data-att-declare]')"), 5000, 'declare box 2');
  await js("document.querySelector('.dcompose [data-att-declare]').click(); document.querySelector('.dcompose [data-act=\"add-note\"]').click(); true");
  await until(() => js("!!document.querySelector('.dcompose [data-act=\"att-retry\"]')"), 10000, '出現重試上傳附件');
  assert.equal(await js("!!document.querySelector('.dcompose [data-act=\"add-note\"]')"), false, '待重試時不顯示「記下」，避免再建一筆紀錄');
  let after = (await kit.call(liu.token, `/api/cards/${work.cardId}`)).body;
  assert.equal(after.notes.length, notesBefore + 1, '紀錄只建一筆');
  assert.deepEqual(after.attachments.filter(f => /^(first|second)\.txt$/.test(f.name)).map(f => f.name), ['first.txt'], '第一個存上、第二個沒存上');
  await js("document.querySelector('.dcompose [data-act=\"att-retry\"]').click(); true");
  await until(() => js("!document.querySelector('.dcompose [data-act=\"att-retry\"]')"), 10000, '重試成功');
  after = (await kit.call(liu.token, `/api/cards/${work.cardId}`)).body;
  assert.equal(after.notes.length, notesBefore + 1, '重試後仍只有一筆紀錄');
  const twoFiles = after.attachments.filter(f => /^(first|second)\.txt$/.test(f.name));
  assert.deepEqual(twoFiles.map(f => f.name).sort(), ['first.txt', 'second.txt'], '每個附件一份');
  const lastNote = after.notes[after.notes.length - 1];
  assert.ok(twoFiles.every(f => f.noteId === lastNote.noteId), '兩個附件都掛在原本那筆紀錄');



  // 2c. 時間軸：回覆（含到訊息 ›）、紀錄（只存卡上）、附件、系統變更各一則，外加一個過期的訊息附件（灰字）
  {
    const up = async (p, body) => { const r = await fetch(kit.BASE + p, { method: 'POST', headers: { Authorization: 'Bearer ' + liu.token }, body }); return r.json(); };
    const f1 = await up(`/api/files?name=${encodeURIComponent('舊截圖.png')}&declared=true&project=${encodeURIComponent('預設專案')}&post=false`, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const fid = f1.file?.fileId;
    assert.ok(fid, '先傳一個訊息附件：' + JSON.stringify(f1));
    const mr = await kit.call(liu.token, '/api/messages', 'POST', { requestId: 'tl-msg', project: '預設專案', text: `[回覆] ${work.cardId}：附上對照圖`, cardId: work.cardId, recipientIds: [], fileIds: [fid] });
    assert.equal(mr.status, 201, JSON.stringify(mr.body));
    kit.sql('UPDATE files SET expires_at = 1 WHERE id = ?', fid);
    await up(`/api/projects/${encodeURIComponent('預設專案')}/docs?name=${encodeURIComponent('規格.txt')}&cardId=${encodeURIComponent(work.cardId)}&declared=true`, 'spec');
    await open(work.cardId);
    await until(() => js("!!document.querySelector('.timeline .tl-msg .tl-gone')"), 8000, '時間軸有過期附件');
    const kinds = await js("[...document.querySelectorAll('.timeline > li')].map(li => li.classList.contains('tl-msg') ? 'msg' : li.classList.contains('tl-note') ? 'note' : li.classList.contains('tl-file') ? 'file' : li.classList.contains('tl-sys') ? 'sys' : '?')");
    for (const k of ['msg', 'note', 'file', 'sys']) assert.ok(kinds.includes(k), `時間軸有 ${k}：` + JSON.stringify(kinds));
    assert.match(await js("document.querySelector('.timeline .tl-msg').innerText"), /到訊息 ›|Go to message ›/, '回覆有到訊息');
    assert.match(await js("document.querySelector('.timeline .tl-gone').innerText"), /已過期|expired/, '過期附件灰字');
    await js("document.querySelector('.timeline').scrollIntoView({ block: 'start' }); true");
    await shot('work-1280-timeline');
  }
  // 3. 交接：選王小明，按鈕寫「交接給 王小明」，交接後負責人換人
  await js("document.querySelector('.dcompose [data-cmode=\"handover\"]').click(); true");
  await until(() => js("!!document.querySelector('.dcompose [data-ho-to]')"), 5000, 'handover mode');
  await js(`(() => { const s = document.querySelector('.dcompose [data-ho-to]'); s.value = ${JSON.stringify(wang.participant.participantId)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  assert.equal(await js("document.querySelector('.dcompose [data-act=\"ho-go\"]').textContent"), '交接給 王小明');
  assert.match(await js("document.querySelector('.dcompose .ho-hint').textContent"), /負責人變 王小明/);
  await js(`(() => { const ta = document.querySelector('.dcompose [data-cdraft^="h:"]'); ta.value = '匯出欄位都好了'; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await shot('work-1280-handover');
  await js("document.querySelector('.dcompose [data-act=\"ho-go\"]').click(); true");
  await until(() => js("/負責：王小明/.test(document.querySelector('.drawer-status')?.innerText || '')"), 10000, 'owner changed');

  // 3b. 退回：待確認、等你驗收的卡才有「退回」分頁，按鈕寫「退回給 …」，原因必填
  const vcard = await mk('工作', '驗收用的卡');
  assert.equal((await kit.call(liu.token, `/api/cards/${vcard.cardId}`, 'PATCH', { status: '待確認', waitForId: liu.participant.participantId })).status, 200, '改成待確認、等我驗收');
  await open(vcard.cardId);
  assert.ok((await tabs()).some(t => t.startsWith('退回') || t.startsWith('Send back')), '等你驗收的卡有退回分頁：' + JSON.stringify(await tabs()));
  await js("document.querySelector('.dcompose [data-cmode=\"back\"]').click(); true");
  await until(() => js("!!document.querySelector('.dcompose [data-act=\"back-go\"]')"), 5000, 'back mode');
  await js("document.querySelector('.dcompose [data-act=\"back-go\"]').click(); true");
  assert.ok((await js("document.querySelector('#cmp-err').textContent")).length > 0, '原因沒寫不送出');
  await shot('work-1280-back');
  // 4. 人類紀錄卡：沒有回覆、預設紀錄；改狀態選單有已整理
  await open(note.cardId);
  const nt = await tabs();
  assert.ok(!nt.some(t => t.startsWith('回覆')) && (nt.length === 0 || nt[0] === '紀錄*'), '人類紀錄卡沒有回覆、預設紀錄：' + JSON.stringify(nt));
  assert.ok(await js("!!document.querySelector('#note-text')"), '紀錄輸入框');
  assert.ok(await js("(() => { const c = document.querySelector('.dcompose'), d = document.querySelector('.drawer'); return Math.abs(c.getBoundingClientRect().bottom - d.getBoundingClientRect().bottom) < 2; })()"), '內容少的卡，輸入區也貼在底部');
  await js("document.querySelector('.drawer-status .st-menu summary').click(); true");
  assert.match(await js("document.querySelector('.st-list').innerText"), /已整理/);
  await shot('note-1280');

  // 5. 375：輸入區在底部、不橫向捲動
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await open(work.cardId);
  assert.ok(await noHScroll(), '375 不橫向捲動');
  assert.ok(await js("(() => { const m = document.querySelector('.drawer-status .more-acts > summary'), st = document.querySelector('.drawer-status .st-menu > summary'); return Math.abs(m.getBoundingClientRect().top - st.getBoundingClientRect().top) < 24; })()"), '375「⋯」跟改狀態同一行');
  await until(() => js("(() => { const r = document.querySelector('.dcompose').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; })()"), 5000, '375 輸入區在畫面內（底部）');
  await shot('work-375');

  // 6. 唯讀成員：不顯示輸入區（王小明設成預設專案唯讀）
  assert.equal((await kit.call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: wang.participant.participantId, readOnlyIn: ['預設專案'] }] })).status, 200, '王小明設成唯讀');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await login(wang.token, '/p/main/work');
  await until(() => js(`!!document.querySelector('[data-card="${work.cardId}"]')`), 15000, 'card');
  await js(`document.querySelector('[data-card="${work.cardId}"]').click(); true`);
  await until(() => js("!!document.querySelector('.drawer .timeline')"), 8000, 'drawer');
  assert.equal(await js("!!document.querySelector('.drawer .dcompose')"), false, '唯讀成員不顯示輸入區');
  assert.equal(await js("!!document.querySelector('.drawer-status .st-menu')"), false, '唯讀成員沒有改狀態');
  // 7. 英文介面：分段鈕 Reply／Note／Hand over，輸入區與時間軸沒有殘留中文（另開一張劉昱志負責的卡）
  const enCard = await mk('工作', 'Export currency column');
  await login(liu.token, '/p/main/work');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await login(liu.token, '/p/main/work');
  await until(() => js(`!!document.querySelector('[data-card="${enCard.cardId}"]')`), 15000, 'card (en)');
  await js(`document.querySelector('[data-card="${enCard.cardId}"]').click(); true`);
  await until(() => js("!!document.querySelector('.drawer .dcompose')"), 8000, 'composer (en)');
  assert.deepEqual(await tabs(), ['Reply*', 'Note', 'Hand over'], '英文分段鈕');
  const cjk = await js("[...document.querySelectorAll('.dcompose, .drawer .timeline, .drawer-status')].map(e => e.innerText).join(' ').match(/[\\u3400-\\u9fff]+/g) || []");
  assert.deepEqual(cjk.filter(w => !/^(劉昱志|王小明|報價單匯出加上幣別欄|客戶要的是左邊這版|匯出欄位都好了)$/.test(w) && !/客戶|匯出|劉昱志|王小明/.test(w)), [], '英文介面輸入區、時間軸沒有殘留中文：' + JSON.stringify(cjk));
  await shot('work-1280-en');
  console.log('card-drawer-input-ui-test：全部通過（分段鈕、紀錄＋附檔進時間軸與附件區、交接給 X、人類紀錄卡、375、唯讀）');
} finally {
  await kit.stop();
}
