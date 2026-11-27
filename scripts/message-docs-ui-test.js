// 畫面測試：發文引用專案文件區的檔（docIds），訊息直接顯示縮圖、點開看大圖
// A. 一張截圖：照原比例顯示（最寬 360px、最高 280px），縮圖真的載入
// B. 兩張截圖＋一份 md：兩張並排的縮圖格；md 顯示檔名＋大小，點了從文件區下載
// C. 點縮圖：深色全螢幕「1 / 2 · 檔名 · 發文者 時間」、下載、→ 下一張、Esc 關閉
// D. 文件從文件區刪掉：剩下的照常，下方寫「另有 1 個文件已從專案文件區刪除」；全刪光顯示「文件已從專案文件區刪除」
// E. 手機 375：縮圖格放得下、不橫向捲動、點開是全螢幕
// F. 英文 1280／375：沒有漏翻
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站；截圖是 canvas 畫的假資料。設 MESSAGE_DOCS_SHOTS=資料夾 會另外截圖。
// 用法：node scripts/message-docs-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('message-docs-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('msgdocs');
try {
  const { call } = kit;
  const liu = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  await call(liu.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'msgdocs_0', text: '[通知] 今天交截圖。', audience: 'all' });

  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shot = async name => { if (!process.env.MESSAGE_DOCS_SHOTS) return; fs.mkdirSync(process.env.MESSAGE_DOCS_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.MESSAGE_DOCS_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
  const helpers = `(() => {
    const T = () => localStorage.getItem('aigile-switch-token');
    window.__mk = (label, w, h, col) => new Promise(res => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.fillStyle = col; g.fillRect(0, 0, w, 48); g.fillStyle = '#fff'; g.font = 'bold 22px sans-serif'; g.fillText('示範畫面 · ' + label + '（假資料）', 16, 32);
      g.fillStyle = '#e2e8f0'; for (let i = 0; i < 8; i++) g.fillRect(16, 70 + i * 44, w - 32, 28);
      c.toBlob(b => res(new File([b], label + '.png', { type: 'image/png' })), 'image/png'); });
    window.__up = async f => { const r = await fetch('/api/projects/' + encodeURIComponent('預設專案') + '/docs?' + new URLSearchParams({ name: f.name, declared: 'true' }), { method: 'POST', headers: { Authorization: 'Bearer ' + T() }, body: f }); return (await r.json()).doc.docId; };
    window.__post = async (text, docIds) => { const r = await fetch('/api/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + T(), 'Content-Type': 'application/json' }, body: JSON.stringify({ project: '預設專案', requestId: 'ui_' + Math.random(), text, docIds }) }); return (await r.json()).messageId; };
    window.__del = id => fetch('/api/projects/' + encodeURIComponent('預設專案') + '/docs/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T() } }).then(r => r.status);
    window.__dl = []; // 攔下載：記下網址，不真的存檔
    const click = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push(this.download); return; } return click.call(this); };
    return true; })()`;
  const open = async (w, h = 900) => {
    await size(w, h);
    await login(liu.token, '/p/main/messages');
    await until(() => js("document.querySelectorAll('#messages .msg').length >= 1"), 20000, '訊息');
    await js(helpers);
  };
  const msg = id => J(`(() => { const a = document.getElementById('msg-${id}'); if (!a) return null; const g = a.querySelector('.msg-docs .fgrid'), r = g?.getBoundingClientRect();
    return { cls: g?.className || '', width: r ? Math.round(r.width) : 0, cells: g ? [...g.querySelectorAll('.fg-cell')].map(c => { const b = c.getBoundingClientRect(), i = c.querySelector('img'); return { w: Math.round(b.width), h: Math.round(b.height), nat: i?.naturalWidth ? [i.naturalWidth, i.naturalHeight] : null, label: c.getAttribute('aria-label') }; }) : [],
      refs: [...a.querySelectorAll('.doc-ref')].map(b => b.innerText.replace(/\\s+/g, ' ').trim()), foot: a.querySelector('.msg-docs .fg-foot')?.innerText || '', gone: a.querySelector('.file-card.gone')?.innerText || '', note: a.querySelector('.msg-text')?.innerText || '' }; })()`);
  const viewer = () => J(`(() => { const v = document.querySelector('.viewer'); return v ? { title: v.querySelector('.vw-title').textContent, img: v.querySelector('.vw-img')?.naturalWidth || 0, dl: !!v.querySelector('[data-vw=dl]'), th: v.querySelectorAll('.vw-th').length } : null; })()`);
  const key = k => js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true, cancelable: true })); true`);
  const loaded = id => until(() => js(`(() => { const im = [...document.querySelectorAll('#msg-${id} .msg-docs img')]; return im.length > 0 && im.every(i => i.naturalWidth > 0); })()`), 10000, '縮圖載入');

  await open(1280);
  // ---------- A 一張 ----------
  const ids = await js(`(async () => [await __up(await __mk('搜尋頁-1280', 640, 420, '#1d4ed8')), await __up(await __mk('搜尋頁-375', 375, 640, '#0f766e')), await __up(await __mk('錯誤提示', 640, 420, '#b45309')),
    await __up(new File(['# 驗收清單\\n- 縮圖\\n- 點開大圖'], '驗收清單.md', { type: 'text/markdown' }))])()`);
  const one = await js(`__post('[通知] 搜尋頁的 1280 截圖。', ['${ids[0]}'])`);
  await until(() => js(`!!document.querySelector('#msg-${one} .msg-docs')`), 10000, '一張的訊息');
  await loaded(one);
  let m = await msg(one);
  assert.match(m.cls, /fg-1/, 'A 一張用 fg-1');
  assert.match(m.note, /搜尋頁的 1280 截圖。$/, 'A 內文照常顯示：' + m.note);
  assert.ok(m.width <= 360, 'A 最寬 360：' + m.width);
  assert.deepEqual(m.cells[0].nat, [640, 420], 'A 縮圖真的載入');
  assert.ok(Math.abs(m.cells[0].h / m.cells[0].w - 420 / 640) < 0.05, 'A 照原比例：' + JSON.stringify(m.cells[0]));
  assert.equal(m.cells[0].label, '搜尋頁-1280.png，點開放大', 'A 讀屏文字');
  await js(`document.getElementById('msg-${one}').scrollIntoView({ block: 'center' }); true`);
  await shot('1-電腦1280-一張截圖');

  // ---------- B 兩張＋md ----------
  const two = await js(`__post('[通知] 1280 和 375 各一張，另附驗收清單。', ['${ids[1]}', '${ids[2]}', '${ids[3]}'])`);
  await until(() => js(`!!document.querySelector('#msg-${two} .msg-docs')`), 10000, '兩張的訊息');
  await loaded(two);
  m = await msg(two);
  assert.match(m.cls, /fg-2/, 'B 兩張用 fg-2');
  assert.equal(m.cells.length, 2, 'B 只有圖片進縮圖格');
  assert.ok(m.width <= 420, 'B 最寬 420：' + m.width);
  assert.equal(m.cells[0].label, '第 1 張，共 2 張：搜尋頁-375.png，點開放大', 'B 讀屏文字');
  assert.equal(m.refs.length, 1, 'B 非圖片一個');
  assert.match(m.refs[0], /^📄 驗收清單\.md [\d.]+ B$/, 'B 非圖片顯示檔名與大小：' + m.refs[0]);
  await js(`document.querySelector('#msg-${two} .doc-ref').click(); true`);
  await until(() => js("window.__dl.length === 1"), 5000, '下載 md');
  assert.equal(await js('window.__dl[0]'), '驗收清單.md', 'B 點檔名下載');
  await js(`document.getElementById('msg-${two}').scrollIntoView({ block: 'center' }); true`);
  await shot('2-電腦1280-兩張加文件');

  // ---------- C 點開大圖 ----------
  await js(`document.querySelector('#msg-${two} [data-dg-open][data-i="0"]').click(); true`);
  await until(async () => (await viewer())?.img > 0, 5000, '大圖');
  let v = await viewer();
  assert.match(v.title, /^1 \/ 2 · 搜尋頁-375\.png · 林志明 /, 'C 標題：' + v.title);
  assert.ok(v.dl && v.th === 2, 'C 有下載、縮圖列 2 張');
  await shot('3-電腦1280-點開大圖');
  await key('ArrowRight');
  await until(async () => /^2 \/ 2 · 錯誤提示/.test((await viewer()).title), 3000, 'C → 下一張');
  await js("document.querySelector('.viewer [data-vw=dl]').click(); true");
  await until(() => js("window.__dl.length === 2"), 5000, '大圖下載');
  assert.equal(await js('window.__dl[1]'), '錯誤提示.png', 'C 大圖下載從文件區');
  await key('Escape');
  assert.equal(await js("!!document.querySelector('.viewer')"), false, 'C Esc 關閉');

  // ---------- D 從文件區刪掉 ----------
  assert.equal(await js(`__del('${ids[2]}')`), 200, 'D 刪一張');
  await open(1280);
  await until(() => js(`!!document.querySelector('#msg-${two} .msg-docs')`), 10000, '重開');
  await loaded(two);
  m = await msg(two);
  assert.match(m.cls, /fg-1/, 'D 剩一張改成 fg-1');
  assert.equal(m.foot, '另有 1 個文件已從專案文件區刪除', 'D 寫有幾個被刪');
  assert.equal(await js(`__del('${ids[0]}')`), 200, 'D 刪掉一張那則的圖');
  await open(1280);
  await until(() => js(`!!document.querySelector('#msg-${one} .file-card.gone')`), 10000, '全刪光');
  assert.equal((await msg(one)).gone, '📄 文件已從專案文件區刪除', 'D 全刪光的提示');

  // ---------- E 手機 375 ----------
  await open(375, 800);
  await until(() => js(`!!document.querySelector('#msg-${two} .msg-docs')`), 10000, '手機訊息');
  await loaded(two);
  m = await msg(two);
  assert.ok(m.width <= 375 - 16, 'E 縮圖格放得下：' + m.width);
  assert.ok(m.cells[0].h > 0 && m.cells[0].h <= 281, 'E 縮圖最高 280：' + JSON.stringify(m.cells[0]));
  assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), 'E 不橫向捲動');
  await js(`document.getElementById('msg-${two}').scrollIntoView({ block: 'center' }); true`);
  await shot('4-手機375-訊息縮圖');
  await js(`document.querySelector('#msg-${two} [data-dg-open]').click(); true`);
  await until(async () => (await viewer())?.img > 0, 5000, '手機大圖');
  assert.ok(await js("(() => { const r = document.querySelector('.viewer').getBoundingClientRect(); return Math.round(r.width) === innerWidth && Math.round(r.height) === innerHeight; })()"), 'E 手機全螢幕');
  await shot('5-手機375-點開大圖');
  await key('Escape');

  // ---------- F 英文 ----------
  const zh = t => t.split(String.fromCharCode(10)).filter(l => /[一-鿿]/.test(l) && !/搜尋頁|錯誤提示|驗收清單|今天交截圖|截圖。|各一張|林志明|預設專案/.test(l));
  const enText = id => js(`document.getElementById('msg-${id}').querySelector('.msg-docs, .file-card.gone').innerText`);
  for (const w of [1280, 375]) {
    await js("localStorage.setItem('aigile-lang', 'en'); true");
    await open(w, w < 700 ? 800 : 900);
    await until(() => js(`!!document.querySelector('#msg-${two} .msg-docs') && !!document.querySelector('#msg-${one} .file-card.gone')`), 10000, '英文訊息');
    await loaded(two);
    const t2 = await enText(two), t1 = await enText(one);
    assert.deepEqual(zh(t2 + String.fromCharCode(10) + t1), [], `英文 ${w} 沒有漏翻：` + t2 + ' / ' + t1);
    assert.match(t2, /1 more removed from the project docs/, `英文 ${w} 被刪的提示`);
    assert.match(t1, /Removed from the project docs/, `英文 ${w} 全刪光`);
    assert.equal(await js(`document.querySelector('#msg-${two} [data-dg-open]').getAttribute('aria-label')`), '搜尋頁-375.png, open full size', `英文 ${w} 讀屏文字`);
    assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), `英文 ${w} 不橫向捲動`);
    await js(`document.getElementById('msg-${two}').scrollIntoView({ block: 'center' }); true`);
    await shot(`en-${w}-訊息縮圖`);
    await js(`document.querySelector('#msg-${two} [data-dg-open]').click(); true`);
    await until(async () => (await viewer())?.img > 0, 5000, '英文大圖');
    assert.match((await viewer()).title, /^搜尋頁-375.png · 林志明 /, `英文 ${w} 大圖標題`);
    assert.equal(await js("document.querySelector('.viewer [data-vw=dl]').textContent"), 'Download', `英文 ${w} 下載鈕`);
    await shot(`en-${w}-點開大圖`);
    await key('Escape');
  }
  await js("localStorage.removeItem('aigile-lang'); true");
  console.log('message-docs-ui-test：全部通過（一張照比例、兩張＋文件、點開大圖與下載、文件刪除後的提示、手機 375、英文 1280／375）');
} finally { await kit.stop(); }
