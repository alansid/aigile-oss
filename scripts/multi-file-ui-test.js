// 畫面測試：群組發文一次可以帶多張截圖（一則訊息最多 4 個檔）
// A. 上傳視窗：選檔一次多張 → 縮圖格（電腦 4 欄、手機 2 欄）、序號＋檔名＋大小、每張 × 拿掉、＋再加一張、Ctrl+V 連貼
// B. 最多 4 張、每張 2 MB：超過的標紅不上傳、按鈕「上傳 N 張（略過 M 張）」；第 5 張起提示「最多 4 張」
// C. 聲明一次勾：「我已逐張看過，這 N 張截圖都不含任何程式碼與客戶個資」；再加圖自動取消勾選＋提示；沒勾不能上傳
// D. 訊息：2 張並排、3 張一大兩小、4 張 2×2，最寬約 420px；下方「🖼 N 張截圖 · ✓ 已聲明… · 全部下載」；1 張照舊是檔案卡
// E. 點開深色全螢幕：「2 / 3 · 檔名 · 發文者 時間」、下載、✕；← → 鍵、手機滑；縮圖列；Esc 關閉（上傳視窗不跟著關）
// F. 手機 375 不橫向捲動；單一份 pdf 照舊用原本的上傳視窗
// G. 全螢幕「刪除這張」＋確認「只刪這一張，同一則的其他 N 張會留著」；手機「再加一張」寫「從相簿或檔案選」；
//    手機全螢幕底部「左右滑動或點縮圖切換」；超過 2 MB 的縮圖調淡、紅字疊上，讀不出圖改放 🖼（不出現破圖）
// H. 英文介面：上傳視窗、訊息縮圖格的字都有翻
// 本機暫存資料庫＋無頭 Chrome／Edge，不連任何站；截圖都是 canvas 畫的假資料。設 MULTIFILE_SHOTS=資料夾 會另外截圖。
// 用法：node scripts/multi-file-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('multi-file-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('multifile');
try {
  const { call } = kit;
  const PJ = '預設專案';
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const lin = await join('林志明', 'PO'), chen = await join('陳大文', 'PG');
  const CHEN = chen.participant.participantId;
  await call(lin.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [PJ] });
  await call(lin.token, '/api/messages', 'POST', { project: PJ, requestId: 'mfu_0', text: '搜尋框打「台北」會吃字，大家看一下。', audience: 'all' });

  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const SHOTS = process.env.MULTIFILE_SHOTS;
  const shot = async name => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
  const helpers = `(() => {
    const C = { 搜尋結果: '#1d4ed8', 搜尋框: '#0f766e', 錯誤訊息: '#b45309', 設定: '#7c3aed', 報表: '#be123c', 登入頁: '#0369a1' };
    window.__mk = (label, n) => new Promise(res => { const w = 640, h = 420, c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'), col = C[label] || '#334155';
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = col; g.fillRect(0, 0, w, 52); g.fillStyle = '#fff'; g.font = 'bold 24px sans-serif'; g.fillText('示範系統 · ' + label + '（假資料）', 18, 35);
      g.fillStyle = col + '22'; g.fillRect(0, 52, 140, h - 52); g.fillStyle = '#94a3b8'; for (let i = 0; i < 6; i++) g.fillRect(20, 80 + i * 46, 100, 14);
      g.fillStyle = '#e2e8f0'; for (let i = 0; i < 6; i++) g.fillRect(170, 76 + i * 52, 430, 32);
      g.strokeStyle = '#dc2626'; g.lineWidth = 5; g.beginPath(); g.ellipse(380, 200, 130, 44, 0, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#dc2626'; g.font = 'bold 30px sans-serif'; g.fillText(String(n || ''), w - 44, h - 22);
      c.toBlob(b => res(new File([b], (n ? n + '-' : '') + label + '.png', { type: 'image/png' })), 'image/png'); });
    window.__big = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), new Uint8Array(2.2 * 1048576)], '4-設定頁-儲存後.png', { type: 'image/png' });
    window.__pick = files => { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); const i = document.querySelector('#file-input'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    window.__paste = (el, files) => { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; };
    window.__send = async (labels, text) => { const t = localStorage.getItem('aigile-switch-token'), ids = [];
      for (const [k, l] of labels.entries()) { const f = await __mk(l, k + 1); const r = await fetch('/api/files?' + new URLSearchParams({ name: f.name, declared: 'true', project: ${JSON.stringify(PJ)}, post: 'false' }), { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: f }); ids.push((await r.json()).file.fileId); }
      const r = await fetch('/api/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ project: ${JSON.stringify(PJ)}, requestId: 'ui_' + labels.length + '_' + Date.now(), text, fileIds: ids }) });
      return (await r.json()).messageId; };
    return true; })()`;
  const open = async (w, h = 900, lang = 'zh') => {
    await size(w, h);
    await login(lin.token, '/p/main/messages');
    await js(`localStorage.setItem('aigile-lang', '${lang}'); window.__staleReload = 1; location.reload(); true`);
    await until(() => js('!window.__staleReload'), 20000, '重新整理後換成新頁面');
    await sleep(400);
    await until(() => js("document.querySelector('#app')?.hidden === false && document.querySelector('#boot')?.hidden === true && !!document.querySelector('.av-btn')?.innerHTML && document.querySelectorAll('#messages .msg').length >= 1"), 20000, '訊息');
    await js(helpers);
  };
  const dlg = () => J(`(() => { const m = document.querySelector('#modal-root .modal'); if (!m) return null; const go = m.querySelector('#up-go'), rd = m.querySelector('#up-redeclare'), lm = m.querySelector('#up-limit');
    return { title: m.querySelector('#modal-title').textContent, cells: [...m.querySelectorAll('.up-cell')].map(c => ({ cap: c.querySelector('figcaption').innerText.replace(/\\s+/g, ' ').trim(), bad: c.classList.contains('bad') ? c.querySelector('.up-bad').textContent : '' })),
      add: !!m.querySelector('.up-add'), count: m.querySelector('#up-count').textContent, declare: m.querySelector('#up-declare-t').textContent, checked: m.querySelector('#up-declare').checked,
      go: go.textContent, goOff: go.disabled, redeclare: rd.hidden ? '' : rd.textContent, limit: lm.hidden ? '' : lm.textContent,
      cols: getComputedStyle(m.querySelector('#up-grid')).gridTemplateColumns.split(' ').length }; })()`);
  const tick = async on => { await js(`(() => { const c = document.querySelector('#up-declare'); if (c.checked !== ${on}) c.click(); return true; })()`); };
  const viewer = () => J(`(() => { const v = document.querySelector('.viewer'); return v ? { title: v.querySelector('.vw-title').textContent, th: v.querySelectorAll('.vw-th').length, sel: [...v.querySelectorAll('.vw-th')].findIndex(x => x.classList.contains('sel')), img: !!v.querySelector('.vw-img')?.src, dl: !!v.querySelector('[data-vw=dl]') } : null; })()`);
  const key = k => js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true })); true`);
  const lastMsg = sel => J(`(() => { const a = [...document.querySelectorAll('#messages article.msg')].filter(x => x.querySelector('${sel}')).at(-1); if (!a) return null; const g = a.querySelector('.fgrid'), r = g?.getBoundingClientRect();
    return { id: a.id.replace('msg-', ''), cls: g?.className || '', cells: g ? [...g.querySelectorAll('.fg-cell')].map(c => { const b = c.getBoundingClientRect(); return { x: Math.round(b.left - r.left), y: Math.round(b.top - r.top), w: Math.round(b.width), h: Math.round(b.height) }; }) : [],
      width: r ? Math.round(r.width) : 0, thumbs: g ? [...g.querySelectorAll('img')].filter(i => i.src.startsWith('blob:') && i.naturalWidth > 0).length : 0,
      foot: a.querySelector('.fg-foot')?.innerText.replace(/\\s+/g, ' ').trim() || '', card: !!a.querySelector('.file-card'), note: a.querySelector('.msg-text')?.innerText || '' }; })()`);

  // ---------- 電腦 1280：選 3 張 ----------
  await open(1280);
  await js(`(async () => __pick([await __mk('搜尋結果', 1), await __mk('搜尋框', 2), await __mk('錯誤訊息', 3)]))()`);
  await until(() => js("document.querySelectorAll('#modal-root .up-cell').length === 3"), 8000, '上傳視窗三張');
  await sleep(300);
  let d = await dlg();
  assert.equal(d.title, '上傳截圖（3 張）', 'A 標題：' + d.title);
  assert.deepEqual(d.cells.map(c => c.cap.replace(/ [\d.]+ KB$/, '')), ['1. 1-搜尋結果.png', '2. 2-搜尋框.png', '3. 3-錯誤訊息.png'], 'A 序號＋檔名：' + JSON.stringify(d.cells));
  assert.ok(d.cells.every(c => / [\d.]+ KB$/.test(c.cap)), 'A 每張有大小');
  assert.ok(d.add, 'A 有「＋再加一張」');
  assert.equal(await js("document.querySelector('.up-add').innerText.replace(/\\s+/g, ' ').trim()"), '＋ 再加一張 或直接 Ctrl+V 貼上', 'G 電腦：或直接 Ctrl+V 貼上');
  assert.equal(d.cols, 4, 'A 電腦 4 欄');
  assert.match(d.count, /^3 張（最多 4 張，每張 2 MB 以內）$/, 'A 張數說明：' + d.count);
  assert.equal(d.declare, '我已逐張看過，這 3 張截圖都不含任何程式碼與客戶個資', 'C 聲明文字');
  assert.ok(d.goOff && d.go === '上傳 3 張', 'C 沒勾不能上傳：' + d.go);
  await tick(true);
  await js(`(() => { const t = document.querySelector('#up-note'); t.value = '@陳大文 搜尋框打「台北」還是會吃字，1 是結果、2 是輸入中、3 是跳出的錯誤。'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  d = await dlg();
  assert.ok(!d.goOff, 'C 勾了就能上傳');
  await shot('1-電腦1280-上傳預覽3張-聲明已勾');

  // ---------- 貼上第 4 張（超過 2 MB）→ 聲明自動取消、標紅、略過 ----------
  await js(`__paste(document.querySelector('#up-note'), [__big()])`);
  await until(() => js("document.querySelectorAll('#modal-root .up-cell').length === 4"), 5000, '第 4 張');
  d = await dlg();
  assert.equal(d.title, '上傳截圖（4 張）');
  assert.equal(d.cells[3].bad, '超過 2 MB，不會上傳', 'B 超過 2 MB 標紅');
  await until(() => js("!document.querySelector('.up-cell.bad .up-th img')"), 5000, '讀不出圖改放圖示');
  assert.deepEqual(await J("(() => { const i = document.querySelector('.up-cell.bad .up-th .up-ico'); return i ? [i.textContent, getComputedStyle(i).opacity] : null; })()"), ['🖼', '0.35'], 'G 讀不出圖：🖼 圖示、調淡');
  assert.ok(!d.add, 'B 滿 4 張不再顯示「＋再加一張」');
  assert.equal(d.checked, false, 'C 加圖後聲明自動取消勾選');
  assert.equal(d.redeclare, '你剛加了第 4 張，聲明已自動取消勾選，請再看一次全部截圖後重新勾選。', 'C 提示重勾');
  assert.equal(d.declare, '我已逐張看過，這 3 張截圖都不含任何程式碼與客戶個資', 'C 聲明只算要上傳的 3 張');
  assert.ok(d.goOff && d.go === '上傳 3 張（略過 1 張）', 'B 按鈕寫略過：' + d.go);
  await shot('2-電腦1280-第4張超過2MB標紅-聲明自動取消');
  // 第 5 張
  await js(`(async () => __paste(document.querySelector('#up-note'), [await __mk('報表', 5)]))()`);
  await until(() => js("!document.querySelector('#up-limit').hidden"), 5000, '最多 4 張提示');
  d = await dlg();
  assert.equal(d.cells.length, 4, 'B 第 5 張沒加進來');
  assert.match(d.limit, /最多 4 張/, 'B 提示最多 4 張：' + d.limit);

  // ---------- 點縮圖放大；Esc 只關大圖 ----------
  await js("document.querySelector('[data-up-view=\"1\"]').click(); true");
  await until(() => js("!!document.querySelector('.viewer .vw-img')?.src"), 5000, '上傳預覽放大');
  let v = await viewer();
  assert.match(v.title, /^2 \/ 4 · 2-搜尋框\.png · [\d.]+ KB$/, 'A 點縮圖放大：' + v.title);
  await key('ArrowRight');
  assert.match((await viewer()).title, /^3 \/ 4 · 3-錯誤訊息\.png/, 'E → 下一張');
  await key('Escape');
  assert.equal(await js("!!document.querySelector('.viewer')"), false, 'E Esc 關掉大圖');
  assert.equal(await js("!!document.querySelector('#modal-root .modal')"), true, 'E 上傳視窗還在');

  // ---------- 拿掉第 4 張、重勾、上傳 ----------
  await js("document.querySelector('[data-up-rm=\"3\"]').click(); true");
  d = await dlg();
  assert.equal(d.title, '上傳截圖（3 張）', 'A × 拿掉單張');
  assert.ok(d.add, 'A 少於 4 張又出現「＋再加一張」');
  await tick(true);
  d = await dlg();
  assert.equal(d.redeclare, '', 'C 重勾後提示消失');
  assert.ok(!d.goOff && d.go === '上傳 3 張', 'C 重勾後可上傳：' + d.go);
  await js("document.querySelector('#up-go').click(); true");
  await until(() => js("!document.querySelector('#modal-root .modal')"), 15000, '上傳完關掉視窗');
  await until(() => js("[...document.querySelectorAll('#messages article.msg .fgrid img')].filter(i => i.src.startsWith('blob:') && i.naturalWidth > 0).length >= 3"), 15000, '縮圖載入');
  let m = await lastMsg('.fgrid');
  assert.equal(m.cls, 'fgrid fg-3', 'D 3 張');
  const [big, s1, s2] = m.cells;
  assert.ok(big.x === 0 && big.h > s1.h * 1.8 && s1.x === s2.x && s1.x > big.x && s2.y > s1.y, 'D 3 張一大兩小：' + JSON.stringify(m.cells));
  assert.ok(m.width <= 422, 'D 最寬約 420px：' + m.width);
  assert.equal(m.foot, '🖼 3 張截圖 · ✓ 已聲明不含程式碼與個資 · 全部下載', 'D 下方一行：' + m.foot);
  assert.match(m.note, /^@陳大文 搜尋框打「台北」還是會吃字/, 'D 附註照常顯示');
  const apiMsg = (await call(lin.token, `/api/messages/${m.id}`)).body;
  assert.deepEqual(apiMsg.files.map(f => f.name), ['1-搜尋結果.png', '2-搜尋框.png', '3-錯誤訊息.png'], '一則訊息掛 3 個檔、照順序');
  const nt = (await call(chen.token, '/api/notifications')).body.items.filter(n => n.messageId === m.id);
  assert.equal(nt.length, 1, '通知只發一次');
  await js(`document.querySelector('#msg-${m.id}').scrollIntoView({ block: 'center' }); true`);
  await shot('3-電腦1280-訊息3張一大兩小');

  // ---------- 點開深色全螢幕 ----------
  await js(`document.querySelector('#msg-${m.id} [data-fg-open][data-i="1"]').click(); true`);
  await until(() => js("!!document.querySelector('.viewer .vw-img')?.src"), 5000, '全螢幕');
  v = await viewer();
  assert.match(v.title, /^2 \/ 3 · 2-搜尋框\.png · 林志明 \S+/, 'E 上方「2 / 3 · 檔名 · 發文者 時間」：' + v.title);
  assert.ok(v.dl && v.th === 3 && v.sel === 1, 'E 有下載、縮圖列 3 張、目前第 2 張：' + JSON.stringify(v));
  assert.equal(await js("getComputedStyle(document.querySelector('.viewer')).position"), 'fixed', 'E 全螢幕');
  await shot('4-電腦1280-全螢幕看大圖-左右切');
  await key('ArrowRight'); assert.match((await viewer()).title, /^3 \/ 3/, 'E → 鍵');
  await key('ArrowRight'); assert.match((await viewer()).title, /^1 \/ 3/, 'E 最後一張再往右回到第 1 張');
  await key('ArrowLeft'); assert.match((await viewer()).title, /^3 \/ 3/, 'E ← 鍵');
  await js("document.querySelector('.vw-th[data-vw-i=\"1\"]').click(); true"); assert.match((await viewer()).title, /^2 \/ 3/, 'E 點縮圖列');
  await key('Escape');
  assert.equal(await js("!!document.querySelector('.viewer')"), false, 'E Esc 關閉');
  // G 刪除這張：先確認、只刪一張
  await js(`document.querySelector('#msg-${m.id} [data-fg-open][data-i="2"]').click(); true`);
  await until(() => js("!!document.querySelector('.viewer [data-vw=del]')"), 5000, '全螢幕刪除鈕');
  assert.equal(await js("document.querySelector('.viewer [data-vw=del]').textContent"), '刪除這張', 'G 按鈕寫「刪除這張」');
  await js("document.querySelector('.viewer [data-vw=del]').click(); true");
  await until(() => js("!!document.querySelector('.confirm-root .confirm-msg')"), 5000, '確認框');
  assert.equal(await js("document.querySelector('.confirm-root .confirm-msg').textContent"), '只刪這一張，同一則的其他 2 張會留著。', 'G 確認框文字');
  assert.ok(await js("(() => { const b = document.querySelector('.confirm-root [data-ok]').getBoundingClientRect(); return !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('.confirm-root'); })()"), 'G 確認框疊在大圖上面、點得到');
  await shot('5-電腦1280-全螢幕刪除這張-確認');
  await js("document.querySelector('.confirm-root .overlay').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true");
  await until(() => js("!document.querySelector('.confirm-root')"), 5000, '確認框關掉');
  assert.ok(await js("!!document.querySelector('.viewer')"), 'G Esc 只關確認框，大圖還在');
  await js("document.querySelector('.viewer [data-vw=del]').click(); true");
  await until(() => js("!!document.querySelector('.confirm-root [data-ok]')"), 5000, '確認框 2');
  await js("document.querySelector('.confirm-root [data-ok]').click(); true");
  await until(() => js("!document.querySelector('.viewer')"), 8000, '刪完關掉大圖');
  const after = (await call(lin.token, `/api/messages/${m.id}`)).body.files.map(f => f.available);
  assert.deepEqual(after, [true, true, false], 'G 只刪第 3 張，其他 2 張留著：' + JSON.stringify(after));
  await until(() => js(`document.querySelectorAll('#msg-${m.id} .fg-cell.gone').length === 1 && document.querySelectorAll('#msg-${m.id} [data-fg-open]').length === 2`), 5000, '畫面上那格變成已刪除');

  // ---------- 2 張、4 張、1 張 ----------
  await js(`__send(['登入頁', '首頁'], '兩張：登入前後')`);
  await js(`__send(['搜尋框', '錯誤訊息', '設定', '報表'], '設定頁改完了，四個狀態都拍給你看。')`);
  await open(1280);
  await until(() => js("[...document.querySelectorAll('#messages .fgrid img')].filter(i => i.naturalWidth > 0).length >= 8"), 15000, '2、4 張的縮圖（3 張那則刪了 1 張）');
  const grids = await J(`[...document.querySelectorAll('#messages .fgrid')].map(g => { const r = g.getBoundingClientRect(); return { cls: g.className, w: Math.round(r.width), cells: [...g.querySelectorAll('.fg-cell')].map(c => { const b = c.getBoundingClientRect(); return [Math.round(b.left - r.left), Math.round(b.top - r.top)]; }) }; })`);
  const g2 = grids.find(g => g.cls.includes('fg-2')), g4 = grids.find(g => g.cls.includes('fg-4'));
  assert.ok(g2 && g2.cells[0][1] === g2.cells[1][1] && g2.cells[1][0] > g2.cells[0][0], 'D 2 張並排：' + JSON.stringify(g2));
  assert.ok(g4 && g4.cells[0][1] === g4.cells[1][1] && g4.cells[2][1] === g4.cells[3][1] && g4.cells[2][1] > g4.cells[0][1] && g4.cells[0][0] === g4.cells[2][0], 'D 4 張 2×2：' + JSON.stringify(g4));
  assert.ok(grids.every(g => g.w <= 422), 'D 都不超過約 420px');
  await js(`document.querySelector('#messages .fgrid.fg-2').scrollIntoView({ block: 'center' }); true`);
  await shot('6-電腦1280-訊息2張並排');
  await js(`document.querySelector('#messages .fgrid.fg-4').scrollIntoView({ block: 'center' }); true`);
  await shot('7-電腦1280-訊息4張2x2');
  // 1 張：視窗一樣，送出後照舊是檔案卡
  await js(`(async () => __pick([await __mk('登入頁', 0)]))()`);
  await until(() => js("document.querySelectorAll('#modal-root .up-cell').length === 1"), 8000, '一張');
  d = await dlg();
  assert.equal(d.title, '上傳截圖（1 張）');
  assert.equal(d.declare, '我已逐張看過，這 1 張截圖都不含任何程式碼與客戶個資');
  await tick(true);
  await js("document.querySelector('#up-go').click(); true");
  await until(() => js("!document.querySelector('#modal-root .modal')"), 15000, '一張上傳完');
  await until(() => js("[...document.querySelectorAll('#messages article.msg')].at(-1)?.querySelector('.file-card .file-name')?.textContent === '登入頁.png'"), 10000, '一張照舊是檔案卡');
  // 單一份 pdf：原本的上傳視窗
  await js(`__pick([new File(['%PDF-1.4 假資料'], '會議紀錄.pdf', { type: 'application/pdf' })])`);
  await until(() => js("document.querySelector('#modal-root #modal-title')?.textContent === '上傳文件'"), 5000, 'pdf 原本的視窗');
  assert.equal(await js("!!document.querySelector('#modal-root .file-box') && !document.querySelector('#modal-root .up-grid')"), true, 'F 單一份 pdf 照舊');
  await js("document.querySelector('#modal-root [data-close]').click(); true");

  // ---------- 手機 375 ----------
  await open(375, 800);
  await js(`(async () => __pick([await __mk('搜尋結果', 1), await __mk('搜尋框', 2), await __mk('錯誤訊息', 3)]))()`);
  await until(() => js("document.querySelectorAll('#modal-root .up-cell').length === 3"), 8000, '手機上傳視窗');
  await tick(true);
  d = await dlg();
  assert.equal(d.cols, 2, 'A 手機 2 欄');
  assert.equal(await js("document.querySelector('.up-add').innerText.replace(/\\s+/g, ' ').trim()"), '＋ 再加一張 從相簿或檔案選', 'G 手機：從相簿或檔案選（沒有 Ctrl+V）');
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), 'F 手機上傳視窗不橫向捲動');
  assert.ok(await js("(() => { const m = document.querySelector('#modal-root .modal').getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth; })()"), 'F 手機視窗在畫面內');
  await shot('8-手機375-上傳預覽2欄');
  await js("document.querySelector('#modal-root [data-close]').click(); true");
  await until(() => js("[...document.querySelectorAll('#messages .fgrid img')].filter(i => i.naturalWidth > 0).length >= 8"), 15000, '手機縮圖');
  m = await lastMsg('.fgrid.fg-4');
  assert.ok(m.width <= 375 - 16, 'F 手機訊息縮圖格放得下：' + m.width);
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), 'F 手機訊息頁不橫向捲動');
  await js(`document.querySelector('#msg-${m.id} .fgrid').scrollIntoView({ block: 'center' }); true`);
  await shot('9-手機375-訊息4張2x2');
  await js(`document.querySelector('#msg-${m.id} [data-fg-open][data-i="0"]').click(); true`);
  await until(() => js("!!document.querySelector('.viewer .vw-img')?.src"), 5000, '手機全螢幕');
  // 手機滑：往左滑＝下一張
  await js(`(() => { const v = document.querySelector('.viewer'), t = (type, x) => v.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: type === 'touchend' ? [] : [new Touch({ identifier: 1, target: v, clientX: x, clientY: 300 })], changedTouches: [new Touch({ identifier: 1, target: v, clientX: x, clientY: 300 })] })); t('touchstart', 300); t('touchend', 120); return true; })()`);
  v = await viewer();
  assert.match(v.title, /^2 \/ 4/, 'E 手機往左滑到下一張：' + v.title);
  assert.equal(await js("document.querySelector('.vw-hint').innerText.trim()"), '左右滑動或點縮圖切換', 'G 手機底部提示沒有方向鍵');
  assert.ok(await js("(() => { const v = document.querySelector('.viewer').getBoundingClientRect(); return Math.round(v.width) === innerWidth && Math.round(v.height) === innerHeight; })()"), 'E 手機也是全螢幕');
  await shot('10-手機375-全螢幕滑動切換');
  await key('Escape');

  // ---------- 英文介面 ----------
  await open(1280, 900, 'en');
  await until(() => js("document.documentElement.lang === 'en'"), 8000, '英文');
  await js(`(async () => __pick([await __mk('搜尋結果', 1), await __mk('搜尋框', 2), await __mk('錯誤訊息', 3), __big()]))()`);
  await until(() => js("document.querySelectorAll('#modal-root .up-cell').length === 4"), 8000, '英文上傳視窗');
  await sleep(400);
  d = await dlg();
  assert.equal(d.title, 'Upload screenshots (4)', 'H 英文標題：' + d.title);
  assert.equal(d.count, '4 screenshots(up to 4, 2 MB each)', 'H 英文張數：' + d.count);
  assert.equal(d.declare, 'I have checked each one: these 3 screenshots contain no code and no customer personal data', 'H 英文聲明：' + d.declare);
  assert.equal(d.go, 'Upload 3 (skip 1)', 'H 英文按鈕：' + d.go);
  assert.equal(d.cells[3].bad, "Over 2 MB; won't be uploaded", 'H 英文超過 2 MB');
  const enText = await js("document.querySelector('#modal-root .modal').innerText");
  assert.ok(!/[一-鿿]/.test(enText.replace(/\d-(搜尋結果|搜尋框|錯誤訊息|設定頁-儲存後)\.png/g, '')), 'H 上傳視窗除了檔名沒有中文：' + enText);
  await shot('11-英文-電腦1280-上傳預覽4張含超過2MB');
  await js("document.querySelector('#modal-root [data-close]').click(); true");
  await until(() => js("[...document.querySelectorAll('#messages .fgrid img')].filter(i => i.naturalWidth > 0).length >= 8"), 15000, '英文縮圖');
  m = await lastMsg('.fgrid.fg-4');
  assert.equal(m.foot, '🖼 4 screenshots · ✓ Declared free of code and personal data · Download all', 'H 英文訊息下方一行：' + m.foot);
  await js(`document.querySelector('#msg-${m.id} .fgrid').scrollIntoView({ block: 'center' }); true`);
  await shot('12-英文-電腦1280-訊息4張2x2');
  await js(`document.querySelector('#msg-${m.id} [data-fg-open][data-i="1"]').click(); true`);
  await until(() => js("!!document.querySelector('.viewer .vw-img')?.src"), 5000, '英文全螢幕');
  await sleep(300);
  assert.equal(await js("document.querySelector('.vw-hint').innerText.trim()"), '← → keys or swipe to switch · Esc to close', 'H 英文全螢幕提示');
  assert.equal(await js("document.querySelector('.viewer [data-vw=dl]').textContent"), 'Download', 'H 英文下載');
  await shot('13-英文-電腦1280-全螢幕看大圖');
  await key('Escape');
  console.log('multi-file-ui-test：全部通過');
} finally { await kit.stop(); }
