// 畫面測試：全站輸入框統一用群組上傳視窗那一套附件格（📎 選檔或 Ctrl+V 貼上，最多 4 張）
// A. 卡片回覆：附件格在上、文字框、聲明、底列 📎 ＠ 提示 送出；貼上截圖進附件格（電腦 4 欄）；沒勾聲明擋；
//    電腦 Enter 送出、Shift+Enter 換行；只附圖也能送；送出後那則掛 2 張、附件格清空
// B. 決策回覆：Enter 只換行（不送出）；附 1 張按「決定」→ 通知那則掛檔
// C. [需確認] 回覆：附圖、Enter 送出 → 回覆那則掛檔
// D. 退回：同一個附件格（原本的「附檔（選填）」和聲明併進來）；點縮圖大圖疊在退回框上、Esc 只關大圖；
//    有附件沒勾聲明「退回」停用；退回那則原因在前、掛 3 張
// E. 交接說明：附件格、Enter 只換行；[交接] 那則掛檔
// F. 手機 375：附件格 2 欄、「從相簿或檔案選」、提示只寫「可附截圖」、Enter 不送出、不橫向捲動、📎 至少 44px；
//    退回捲到最底聲明勾不被底部按鈕列蓋住；交接框也有附件格
// G. 英文介面：附件格、提示、聲明、退回框的字都有翻
// 本機暫存資料庫＋無頭 Chrome／Edge，不連任何站；截圖都是 canvas 畫的假資料。設 PASTEATT_SHOTS=資料夾 會另外截圖。
// 用法：node scripts/paste-attach-ui-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('paste-attach-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('pasteatt');
try {
  const { call } = kit;
  const PJ = '預設專案';
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const lin = await join('林志明', 'PO'), chen = await join('陳大文', 'PG');
  const LIN = lin.participant.participantId, CHEN = chen.participant.participantId;
  await call(lin.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [PJ] });
  const ai = (await call(lin.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey: 'PG', role: 'PG', name: '程式開發助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const AI = ai.participantId, aiTok = kit.aiToken(AI);
  let n = 0;
  const card = async (tok, body) => { const r = await call(tok, '/api/cards', 'POST', { requestId: 'pau_' + ++n, project: PJ, ...body }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const toVerify = async title => { const c = await card(aiTok, { title, ownerId: AI, status: '進行中' }); assert.equal((await call(aiTok, `/api/cards/${c.cardId}/handover`, 'POST', { toId: LIN, progress: '做好了', nextStep: '請驗收' })).status, 200); return c; };
  const msg = async id => (await call(lin.token, `/api/messages/${id}`)).body;
  const msgs = async () => (await call(lin.token, `/api/messages?project=${encodeURIComponent(PJ)}&limit=100`)).body.items;

  const kReply = await card(lin.token, { title: '搜尋框打中文會被吃字', ownerId: AI, status: '進行中' });
  const dCard = await card(aiTok, { type: '決策', title: '截圖放哪裡', question: '截圖要放卡片欄位嗎？', options: ['放', '不放'], deciderId: LIN });
  const vCard = await toVerify('退回附三張');
  const hCard = await card(lin.token, { title: '交接附圖', ownerId: LIN, status: '進行中' });
  const ask = (await call(aiTok, '/api/messages', 'POST', { project: PJ, requestId: 'pau_ask', text: '[需確認] 搜尋框要不要支援注音？\n選項：\nA. 要\nB. 先不要', recipientIds: [LIN], replyFrom: [LIN] })).body;
  assert.ok(ask.messageId, JSON.stringify(ask));

  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = async (w, h, touch = false) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: touch });
    await cdp('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 0 });
  };
  const SHOTS = process.env.PASTEATT_SHOTS;
  const shot = async name => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
  const helpers = `(() => {
    const C = { 搜尋結果: '#1d4ed8', 搜尋框: '#0f766e', 錯誤訊息: '#b45309', 設定: '#7c3aed' };
    window.__mk = (label, n) => new Promise(res => { const w = 640, h = 420, c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), col = C[label] || '#334155';
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = col; g.fillRect(0, 0, w, 52); g.fillStyle = '#fff'; g.font = 'bold 24px sans-serif'; g.fillText('示範系統 · ' + label + '（假資料）', 18, 35);
      g.fillStyle = col + '22'; g.fillRect(0, 52, 140, h - 52); g.fillStyle = '#e2e8f0'; for (let i = 0; i < 6; i++) g.fillRect(170, 76 + i * 52, 430, 32);
      g.strokeStyle = '#dc2626'; g.lineWidth = 5; g.beginPath(); g.ellipse(380, 200, 130, 44, 0, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#dc2626'; g.font = 'bold 30px sans-serif'; g.fillText(String(n || ''), w - 44, h - 22);
      c.toBlob(b => res(new File([b], (n ? n + '-' : '') + label + '.png', { type: 'image/png' })), 'image/png'); });
    window.__paste = async (sel, labels) => { const el = document.querySelector(sel); const dt = new DataTransfer(); for (const [k, l] of labels.entries()) dt.items.add(await __mk(l, k + 1)); el.focus(); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; };
    window.__type = (sel, text) => { const el = document.querySelector(sel); el.focus(); el.value = text; el.dispatchEvent(new Event('input', { bubbles: true })); return true; };
    return true; })()`;
  const go = async (page, w = 1280, h = 900, touch = false, lang = 'zh') => {
    await size(w, h, touch);
    await login(lin.token, page);
    if (lang !== 'zh' || await js("localStorage.getItem('aigile-lang') !== 'zh'")) {
      await js(`localStorage.setItem('aigile-lang', '${lang}'); location.reload(); true`);
      await sleep(400);
      await until(() => js("document.readyState === 'complete' && !!document.querySelector('.av-btn')"), 20000, '換語言後重新載入');
    }
    await js(helpers);
  };
  // 真的按鍵（會插入換行）：Enter／Shift+Enter
  const press = async (shift = false) => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: shift ? 8 : 0, ...(type === 'keyDown' ? { text: '\r' } : {}) }); };
  const box = key => J(`(() => { const g = document.querySelector('[data-att-grid="${key}"]'), d = document.querySelector('[data-att-decl="${key}"]'); const root = g?.closest('.att-box');
    return { cells: g ? [...g.querySelectorAll('.up-cell figcaption')].map(c => c.innerText.replace(/\\s+/g, ' ').replace(/ [\\d.]+ KB$/, '').trim()) : [], cols: g?.querySelector('.up-grid') ? getComputedStyle(g.querySelector('.up-grid')).gridTemplateColumns.split(' ').length : 0,
      count: g?.querySelector('.att-count')?.innerText.replace(/\\s+/g, ' ').trim() || '', add: g?.querySelector('.up-add')?.innerText.replace(/\\s+/g, ' ').trim() || '', declare: d?.querySelector('.att-declare-t')?.textContent || '', checked: !!d?.querySelector('input')?.checked,
      hint: root?.querySelector('.att-hint')?.innerText.trim() || '', pick: !!root?.querySelector('[data-att-pick]'), order: root ? [...root.children].map(x => x.className.split(' ')[0]) : [] }; })()`);
  const tick = key => js(`(() => { const c = document.querySelector('[data-att-decl="${key}"] input'); if (!c.checked) c.click(); return true; })()`);
  const cells = (key, k) => until(() => js(`document.querySelector('[data-att-grid="${key}"]')?.querySelectorAll('.up-cell').length === ${k}`), 8000, `${key} 有 ${k} 張`);
  const noHScroll = () => js('document.documentElement.scrollWidth <= innerWidth + 1');
  const openCardReply = async (cardId, key) => {
    await until(() => js(`!!document.querySelector('[data-card="${cardId}"]')`), 15000, '工作頁的卡');
    await js(`document.querySelector('[data-card="${cardId}"]').click(); true`);
    await until(() => js(`!!document.querySelector('[data-inl-open="${key}"], [data-inl-text="${key}"]')`), 10000, '卡片回覆');
    if (await js(`!!document.querySelector('[data-inl-open="${key}"]')`)) await js(`document.querySelector('[data-inl-open="${key}"]').click(); true`);
    await until(() => js(`!!document.querySelector('[data-inl-text="${key}"]')`), 5000, '卡片回覆框');
  };
  const openHandover = async cardId => {
    await until(() => js(`!!document.querySelector('[data-card="${cardId}"]')`), 15000, '工作頁的卡（交接）');
    await js(`document.querySelector('[data-card="${cardId}"]').click(); true`);
    await until(() => js("!!document.querySelector('[data-act=handover]')"), 10000, '交接鈕');
    await js("document.querySelector('[data-act=handover]').click(); true");
    await until(() => js("!!document.querySelector('#ho-note')"), 5000, '交接框');
  };
  const openReject = async cardId => {
    await until(() => js(`!!document.querySelector('[data-ver-no="${cardId}"]')`), 15000, '退回按鈕');
    await js(`document.querySelector('[data-ver-no="${cardId}"]').click(); true`);
    await until(() => js("!!document.querySelector('#rj-input')"), 5000, '退回框');
  };

  // ---------- A 卡片回覆（電腦 1280）----------
  const kk = 'k:' + kReply.cardId;
  await go('/p/main/work');
  await openCardReply(kReply.cardId, kk);
  let b = await box(kk);
  assert.equal(b.cells.length, 0, 'A 一開始沒有附件格');
  assert.ok(b.pick, 'A 底列有 📎');
  assert.equal(b.hint, 'Enter 送出 · Shift+Enter 換行 · 可直接貼上截圖', 'A 電腦提示：' + b.hint);
  assert.ok(await js(`!!document.querySelector('[data-inl-root="${kk}"] .att-bar [data-inl-at]') && !!document.querySelector('[data-inl-root="${kk}"] .att-bar [data-inl-act=send]')`), 'A 底列有 ＠ 和送出');
  await js(`__paste('[data-inl-text="${kk}"]', ['搜尋結果', '搜尋框'])`);
  await cells(kk, 2);
  b = await box(kk);
  assert.ok(/^1\. 截圖-\d{8}-\d{6}\.png$/.test(b.cells[0]) && /^2\. 截圖-\d{8}-\d{6}-2\.png$/.test(b.cells[1]), 'A 序號＋檔名（貼上的取有時間的檔名、同名自動加 -2）：' + JSON.stringify(b.cells));
  assert.equal(b.cols, 4, 'A 電腦 4 欄');
  assert.equal(b.count, '2 張（最多 4 張，每張 2 MB 以內）', 'A 上方張數：' + b.count);
  assert.equal(b.add, '＋ 再加一張 或直接 Ctrl+V 貼上', 'A 再加一張：' + b.add);
  assert.equal(b.declare, '我已逐張看過，這 2 張截圖都不含任何程式碼與客戶個資', 'A 聲明');
  assert.deepEqual(b.order, ['att-grid', 'inl-field', 'att-decl', 'att-bar'], 'A 版面：附件格在上、文字框、聲明、底列：' + b.order);
  assert.equal(await js(`document.querySelector('[data-inl-root="${kk}"] [data-inl-act=send]').disabled`), false, 'A 只有附圖也能送');
  await js(`__type('[data-inl-text="${kk}"]', '@程式開發助手 修好了，1 是修改前、2 是修改後')`);
  const before = (await msgs()).length;
  await press();
  await until(() => js(`/請先勾選/.test(document.querySelector('[data-inl-err="${kk}"]').textContent)`), 5000, '沒勾聲明擋');
  assert.equal((await msgs()).length, before, 'A 沒勾聲明不送');
  await press(true);
  assert.match(await js(`document.querySelector('[data-inl-text="${kk}"]').value`), /\n/, 'A Shift+Enter 換行');
  assert.equal((await msgs()).length, before, 'A Shift+Enter 不送');
  await js(`(() => { const t = document.querySelector('[data-inl-text="${kk}"]'); t.value = t.value.replace(/\\n$/, '') + '\\n請再看一次。'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await tick(kk);
  assert.equal((await box(kk)).checked, true, 'A 勾了聲明');
  await js(`document.querySelector('[data-inl-root="${kk}"] .att-bar').scrollIntoView({ block: 'end' }); true`);
  assert.ok(await js(`(() => { const h = document.querySelector('[data-inl-root="${kk}"] .att-hint'); return h.scrollWidth <= h.clientWidth + 1 && h.getBoundingClientRect().right <= document.querySelector('[data-inl-root="${kk}"] [data-inl-act=send]').getBoundingClientRect().left; })()`), 'A 提示沒被切掉、不壓到送出鈕');
  await shot('1-電腦1280-卡片回覆貼上兩張截圖');
  await js(`document.querySelector('[data-inl-text="${kk}"]').focus(); true`);
  await press();
  await until(async () => (await msgs()).some(m => m.text.startsWith(`[回覆] ${kReply.cardId}：`)), 10000, 'A Enter 送出');
  let m = (await msgs()).find(x => x.text.startsWith(`[回覆] ${kReply.cardId}：`));
  assert.match(m.text, /修改後\n請再看一次。\n\[文件\] 2 個檔案/, 'A 文字在前、[文件] 在後：' + m.text);
  assert.deepEqual((await msg(m.messageId)).files.map(f => f.name), b.cells.map(c => c.replace(/^\d\. /, '')), 'A 那則掛 2 張、照順序');
  await until(() => js(`!document.querySelector('[data-att-grid="${kk}"] .up-cell')`), 8000, 'A 送出後附件格清空');

  // ---------- B 決策回覆：Enter 只換行 ----------
  const ck = 'c:' + dCard.cardId;
  await go('/p/main/inbox');
  await until(() => js(`!!document.querySelector('[data-inl-text="${ck}"]')`), 15000, '決策回覆框');
  assert.equal((await box(ck)).hint, 'Enter 換行 · Ctrl+Enter 只留言 · 可直接貼上截圖', 'B 決策提示');
  await js(`__type('[data-inl-text="${ck}"]', '照這張圖放')`);
  const nB = (await msgs()).length;
  await js(`document.querySelector('[data-inl-text="${ck}"]').focus(); true`);
  await press();
  assert.match(await js(`document.querySelector('[data-inl-text="${ck}"]').value`), /\n/, 'B Enter 換行');
  await sleep(500);
  assert.equal((await msgs()).length, nB, 'B Enter 不送出');
  await js(`__paste('[data-inl-text="${ck}"]', ['設定'])`);
  await cells(ck, 1);
  await tick(ck);
  await js(`document.querySelector('[data-inl="${ck}"][data-inl-act=decide][data-result="放"]').click(); true`);
  await until(async () => (await call(lin.token, `/api/cards/${dCard.cardId}`)).body.status === '已完成', 10000, 'B 決定');
  m = (await msgs()).filter(x => x.text.startsWith('[通知]') && x.text.includes(dCard.cardId) && x.text.includes('決定「放」')).at(-1);
  assert.equal((await msg(m.messageId)).file?.name.startsWith('截圖-'), true, 'B 通知那則掛檔');

  // ---------- C [需確認] 回覆 ----------
  const qk = 'q:' + ask.messageId;
  await go('/p/main/messages');
  await until(() => js(`!!document.querySelector('[data-q-text="${ask.messageId}"]')`), 15000, '[需確認] 回覆框');
  await js(`document.querySelector('[data-q-opt="A"][data-qm="${ask.messageId}"]').click(); true`);
  await sleep(300); // 選項重畫完再貼
  await js(`__paste('[data-q-text="${ask.messageId}"]', ['搜尋框'])`);
  await cells(qk, 1);
  assert.equal((await box(qk)).hint, 'Enter 送出 · Shift+Enter 換行 · 可直接貼上截圖', 'C 提示');
  await tick(qk);
  await js(`__type('[data-q-text="${ask.messageId}"]', '注音也要，見圖')`);
  await js(`document.querySelector('[data-q-root="${ask.messageId}"]').scrollIntoView({ block: 'center' }); true`);
  await shot('4-電腦1280-需確認回覆附一張');
  await press();
  await until(async () => (await msgs()).some(x => x.replyToMessageId === ask.messageId), 10000, 'C Enter 送出');
  m = (await msgs()).filter(x => x.text.startsWith('[回覆] 選 A')).at(-1);
  assert.match(m.text, /^\[回覆\] 選 A。注音也要，見圖\n\[文件\] 1 個檔案/, 'C 內文：' + m.text);
  assert.equal((await msg(m.messageId)).file?.name.startsWith('截圖-'), true, 'C 回覆那則掛檔');

  // ---------- D 退回 ----------
  const rk = 'rj:' + vCard.cardId;
  await go('/p/main/inbox');
  await openReject(vCard.cardId);
  assert.equal(await js("!!document.querySelector('#rj-file')"), false, 'D 舊的「附檔（選填）」拿掉了');
  await js(`__paste('#rj-input', ['搜尋結果', '搜尋框', '錯誤訊息'])`);
  await cells(rk, 3);
  b = await box(rk);
  assert.equal(b.hint, 'Enter 換行 · 可直接貼上截圖', 'D 提示');
  assert.equal(b.declare, '我已逐張看過，這 3 張截圖都不含任何程式碼與客戶個資', 'D 聲明');
  await js(`__type('#rj-input', '搜尋框打「台北」還是會吃字，見截圖 1～3。')`);
  await press();
  assert.ok(await js("!!document.querySelector('#rj-input')"), 'D Enter 不送出');
  await shot('2-電腦1280-退回貼上三張截圖');
  await js(`document.querySelector('[data-att-grid="${rk}"] [data-up-view="1"]').click(); true`);
  await until(() => js("!!document.querySelector('.viewer')"), 5000, 'D 大圖');
  assert.ok(await js("(() => { const b = document.querySelector('.viewer .vw-x').getBoundingClientRect(); return !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('.viewer'); })()"), 'D 大圖疊在退回框上面');
  assert.match(await js("document.querySelector('.vw-title').textContent"), /^2 \/ 3 · 截圖-\d{8}-\d{6}-2\.png/, 'D 大圖從第 2 張開始');
  await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); true");
  assert.ok(await js("!document.querySelector('.viewer') && !!document.querySelector('#rj-input')"), 'D Esc 只關大圖，退回框還在');
  assert.equal(await js(`document.querySelector('[data-rj="1"]').disabled`), true, 'D 有附件沒勾聲明：「退回」停用');
  assert.equal(await js("document.querySelector('.confirm-root .up-add .k-desk').getClientRects().length"), 1, 'D「或直接 Ctrl+V 貼上」不斷字');
  await tick(rk);
  assert.equal(await js(`document.querySelector('[data-rj="1"]').disabled`), false, 'D 勾了聲明就能按');
  await js(`document.querySelector('[data-rj="1"]').click(); true`);
  await until(() => js("!document.querySelector('#rj-input')"), 10000, 'D 退回成功');
  m = (await msgs()).filter(x => x.text.startsWith('[退回]')).at(-1);
  assert.match(m.text, /：搜尋框打「台北」還是會吃字，見截圖 1～3。\n\[文件\] 3 個檔案/, 'D 原因在前：' + m.text);
  assert.equal((await msg(m.messageId)).files.length, 3, 'D 掛 3 張');

  // ---------- E 交接 ----------
  const hk = 'ho:' + hCard.cardId;
  await go('/p/main/work');
  await openHandover(hCard.cardId);
  await js(`(() => { const s = document.querySelector('#handover-form [name=toId]'); s.value = ${JSON.stringify(CHEN)}; return true; })()`);
  await js(`__type('#ho-note', '做到一半，看圖')`);
  await press();
  assert.ok(await js("!!document.querySelector('#ho-note')"), 'E Enter 不送出');
  assert.equal((await box(hk)).hint, 'Enter 換行 · 可直接貼上截圖', 'E 提示');
  await js(`__paste('#ho-note', ['設定'])`);
  await cells(hk, 1);
  await tick(hk);
  await shot('3-電腦1280-交接附一張截圖');
  await js("document.querySelector('#modal-root [type=submit]').click(); true");
  await until(() => js("!document.querySelector('#ho-note')"), 10000, 'E 交接成功');
  m = (await msgs()).filter(x => x.text.startsWith('[交接]') && x.text.includes(hCard.cardId)).at(-1);
  assert.match(m.text, /做到一半，看圖/, 'E 交接說明');
  assert.equal((await msg(m.messageId)).file?.name.startsWith('截圖-'), true, 'E [交接] 那則掛檔');

  // ---------- F 手機 375 ----------
  const k2 = await card(lin.token, { title: '手機回覆', ownerId: AI, status: '進行中' }), mk = 'k:' + k2.cardId;
  await go('/p/main/work', 375, 812, true);
  assert.equal(await js("matchMedia('(hover: hover) and (pointer: fine)').matches"), false, 'F 模擬觸控手機');
  await openCardReply(k2.cardId, mk);
  await js(`__paste('[data-inl-text="${mk}"]', ['搜尋結果', '搜尋框'])`);
  await cells(mk, 2);
  b = await box(mk);
  assert.equal(b.cols, 2, 'F 手機 2 欄');
  assert.equal(b.add, '＋ 再加一張 從相簿或檔案選', 'F 手機再加一張');
  assert.equal(b.hint, '可附截圖', 'F 手機提示（📎 不重複、不擠兩行）');
  assert.equal(await js(`document.querySelector('[data-inl-root="${mk}"] .att-hint .k-mob').getClientRects().length`), 1, 'F 手機提示一行');
  await tick(mk);
  await js(`__type('[data-inl-text="${mk}"]', '手機上看')`);
  const nF = (await msgs()).length;
  await js(`document.querySelector('[data-inl-text="${mk}"]').focus(); true`);
  await press();
  await sleep(500);
  assert.equal((await msgs()).length, nF, 'F 手機 Enter 不送出');
  assert.match(await js(`document.querySelector('[data-inl-text="${mk}"]').value`), /\n/, 'F 手機 Enter 換行');
  assert.ok(await noHScroll(), 'F 手機不橫向捲動');
  assert.ok(await js(`(() => { const b = document.querySelector('[data-inl-root="${mk}"] [data-att-pick]').getBoundingClientRect(); return b.width >= 44 && b.height >= 44; })()`), 'F 📎 至少 44px');
  await js(`document.querySelector('[data-inl-root="${mk}"] .att-bar').scrollIntoView({ block: 'end' }); true`);
  assert.ok(await js(`(() => { const h = document.querySelector('[data-inl-root="${mk}"] .att-hint'); return h.scrollWidth <= h.clientWidth + 1; })()`), 'F 手機提示沒被切掉');
  await shot('5-手機375-卡片回覆貼上兩張截圖');
  const v2 = await toVerify('手機退回');
  await go('/p/main/inbox', 375, 812, true);
  await openReject(v2.cardId);
  await js(`__paste('#rj-input', ['搜尋結果', '搜尋框', '錯誤訊息'])`);
  await js(`__type('#rj-input', '搜尋框打「台北」還是會吃字，見截圖 1～3。')`);
  await cells('rj:' + v2.cardId, 3);
  assert.equal((await box('rj:' + v2.cardId)).cols, 2, 'F 手機退回 2 欄');
  assert.ok(await noHScroll(), 'F 手機退回不橫向捲動');
  await shot('6-手機375-退回貼上三張截圖');
  // 捲到最底，聲明勾不能被底部按鈕列蓋住
  await js("(() => { const b = document.querySelector('.confirm-root .modal-body') || document.querySelector('.confirm-root .modal'); b.scrollTop = b.scrollHeight; document.querySelector('.confirm-root [data-att-declare]').scrollIntoView({ block: 'nearest' }); return true; })()");
  await until(() => js("(() => { const c = document.querySelector('.confirm-root [data-att-declare]').getBoundingClientRect(); return !!document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2)?.closest('.declare-box'); })()"), 3000, 'F 手機退回：聲明勾沒被底部按鈕列蓋住（等捲動停）');
  assert.equal(await js(`document.querySelector('[data-rj="1"]').disabled`), true, 'F 手機退回：沒勾聲明「退回」停用');
  await shot('7-手機375-退回捲到最底看得到聲明');
  await js("document.querySelector('[data-rj=\"0\"]').click(); true");
  const h2 = await card(lin.token, { title: '手機交接', ownerId: LIN, status: '進行中' });
  await go('/p/main/work', 375, 812, true);
  await openHandover(h2.cardId);
  await js(`__type('#ho-note', '做到一半，看圖')`);
  await js(`__paste('#ho-note', ['設定', '錯誤訊息'])`);
  await cells('ho:' + h2.cardId, 2);
  assert.equal((await box('ho:' + h2.cardId)).cols, 2, 'F 手機交接 2 欄');
  assert.ok(await noHScroll(), 'F 手機交接不橫向捲動');
  await shot('8-手機375-交接附兩張截圖');

  // ---------- G 英文介面 ----------
  const v3 = await toVerify('英文退回');
  await go('/p/main/inbox', 1280, 900, false, 'en');
  await openReject(v3.cardId);
  await js(`__paste('#rj-input', ['搜尋結果', '搜尋框'])`);
  await cells('rj:' + v3.cardId, 2);
  await js(`__type('#rj-input', 'Typing Chinese in the search box still drops characters; see screenshots 1-2.')`);
  await sleep(300); // 等畫面翻譯
  const en = await J(`(() => { const r = document.querySelector('.confirm-root'); return { label: r.querySelector('label[for=rj-input]').textContent.trim(), ph: r.querySelector('#rj-input').placeholder,
    hint: r.querySelector('.att-hint').innerText.trim(), count: [...r.querySelector('.att-count').children].map(x => x.textContent.trim()).join(' '), gap: parseFloat(getComputedStyle(r.querySelector('.att-count b + span')).marginLeft), add: r.querySelector('.up-add').innerText.replace(/\\s+/g, ' ').trim(),
    declare: r.querySelector('.att-declare-t').textContent, tip: r.querySelector('.up-tip').textContent, pick: r.querySelector('[data-att-pick]').getAttribute('aria-label'), go: r.querySelector('[data-rj="1"]').textContent.trim(), goTitle: r.querySelector('[data-rj="1"]').title }; })()`);
  assert.match(en.label, /^Reason \(required/, 'G 退回原因：' + en.label);
  assert.equal(en.ph, 'What is wrong and how to fix it; you can paste screenshots', 'G placeholder');
  assert.equal(en.hint, 'Enter for a new line · paste screenshots directly', 'G 提示：' + en.hint);
  assert.equal(en.count, '2 screenshots (up to 4, 2 MB each)', 'G 張數：' + en.count);
  assert.ok(en.gap > 0, 'G 英文的括號前空一格');
  delete en.gap;
  assert.match(en.add, /^＋ Add another or paste with Ctrl\+V$/, 'G 再加一張：' + en.add);
  assert.equal(en.declare, 'I have checked each one: these 2 screenshots contain no code and no customer personal data', 'G 聲明：' + en.declare);
  assert.equal(en.tip, 'Click a thumbnail to enlarge and check it', 'G 放大提示');
  assert.equal(en.pick, 'Attach screenshots or files', 'G 📎');
  assert.equal(en.go, 'Send back', 'G 退回鈕');
  assert.equal(en.goTitle, 'Check the declaration above first', 'G 停用的說明');
  assert.ok(!/[㐀-鿿]/.test(Object.values(en).join(' ')), 'G 都沒有中文：' + JSON.stringify(en));
  await shot('9-英文-電腦1280-退回貼上兩張截圖');

  console.log('paste-attach-ui-test：全部通過');
} catch (e) {
  console.error('paste-attach-ui-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
