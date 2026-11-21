// 畫面測試：訊息附件保存時間由管理員調整，全站文字照實際設定顯示
// A. 管理員設定 › 稽核與儲存：「訊息附件保存時間」下拉（1、6、24 小時、3、7、30 天，標預設）＋儲存＋說明「只影響之後上傳的檔」
//    ＋說明 FILE_TTL_HOURS 只是初始值、改過以這裡為準；異動紀錄
// B. 改了之後：儲存空間那列、輸入框下的提示、上傳視窗（截圖、單一文件）、文件頁「訊息附件」分頁都寫實際的值（一般成員也一樣）
// C. 已上傳的舊檔照原本的到期時間；文件頁寫明「設定改了只影響之後上傳的檔」
// D. 網頁、index.html 沒有寫死「1 小時後自動刪除」
// E. 1280、375 不橫向捲動
// F. 英文介面：管理員設定、上傳視窗、輸入框提示整句英文（1 hour／6 hours／3 days 單複數），沒有留中文
// 本機暫存資料庫＋無頭 Chrome／Edge，不連任何站。設 FILETTL_SHOTS=資料夾 會另外截圖。用法：node scripts/file-ttl-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

// ---------- D 靜態檢查 ----------
const root = new URL('..', import.meta.url);
for (const f of ['public/app.js', 'public/index.html']) {
  const s = fs.readFileSync(new URL(f, root), 'utf8');
  assert.ok(!/1 ?小時後(自動)?刪除|不會在 1 小時後刪除|預設 1 小時/.test(s), `D ${f} 不能寫死 1 小時後刪除`);
}

if (!findBrowser()) { console.log('file-ttl-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('filettl');
try {
  const { call } = kit;
  const PJ = '預設專案';
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const wang = await join('王小美', 'PO'), chen = await join('陳大文', 'PG');
  const CHEN = chen.participant.participantId;
  await call(wang.token, `/api/participants/${CHEN}/projects`, 'PUT', { projects: [PJ] });
  const upload = (tok, name) => fetch(`${kit.BASE}/api/files?${new URLSearchParams({ name, declared: 'true', project: PJ })}`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]) }).then(r => r.json());
  const oldFile = await upload(chen.token, '舊的截圖-24小時.png'); // 改設定前上傳：預設 24 小時

  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const SHOTS = process.env.FILETTL_SHOTS;
  const shot = async name => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64')); };
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const setLang = async l => { await js(`localStorage.setItem('aigile-lang', '${l}'); true`); };
  const go = async (token, page, l = 'zh') => {
    await login(token, '/');
    await setLang(l);
    await login(token, page);
    if (l === 'en') await until(() => js("document.documentElement.lang === 'en'"), 8000, '英文');
  };
  const admin = async (l = 'zh') => {
    await go(wang.token, '/admin/audit', l);
    await until(() => js("!!document.querySelector('#adm-ttl') && !!document.querySelector('.adm-store')"), 15000, '稽核與儲存的保存時間設定');
  };
  const save = async v => {
    await js(`(() => { const s = document.querySelector('#adm-ttl'); s.value = '${v}'; s.dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('[data-pp="filettl"]').click(); return true; })()`);
  };
  const helpers = `(() => { window.__pick = files => { const dt = new DataTransfer(); files.forEach(f => dt.items.add(f)); const i = document.querySelector('#file-input'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; };
    window.__png = name => new Promise(res => { const c = document.createElement('canvas'); c.width = 480; c.height = 300; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 480, 300); g.fillStyle = '#1d4ed8'; g.fillRect(0, 0, 480, 44); g.fillStyle = '#fff'; g.font = 'bold 20px sans-serif'; g.fillText('示範系統（假資料）', 14, 29); c.toBlob(b => res(new File([b], name, { type: 'image/png' })), 'image/png'); });
    return true; })()`;
  // 剛登入時選檔的事件可能還沒接上：視窗沒出來就再選一次
  const shotDialog = () => until(() => js("(async () => !!document.querySelector('#modal-root .up-multi') || (__pick([await __png('搜尋結果.png')]), false))()"), 10000, '截圖上傳視窗');
  const docDialog = () => until(() => js("!!document.querySelector('#modal-root .file-box') || (__pick([new File(['會議記錄'], '會議記錄.txt', { type: 'text/plain' })]), false)"), 10000, '單一文件上傳視窗');
  const closeModal = async () => { await js("document.querySelector('#modal-root [data-close]')?.click(); true"); await sleep(250); };

  // ---------- A 管理員設定（1280） ----------
  await size(1280, 900);
  await admin();
  assert.equal(await text('.adm-ttl label[for="adm-ttl"]'), '訊息附件保存時間', 'A 標籤');
  assert.deepEqual(await J("[...document.querySelectorAll('#adm-ttl option')].map(o => o.value + '=' + o.textContent)"),
    ['1=1 小時', '6=6 小時', '24=24 小時（預設）', '72=3 天', '168=7 天', '720=30 天'], 'A 六個選項、標預設 24 小時');
  assert.equal(await js("document.querySelector('#adm-ttl').value"), '24', 'A 目前 24 小時');
  assert.match(await text('#adm-ttl-hint'), /改了只影響之後上傳的檔；已經上傳的照上傳當時的設定到期，不會提早或延後刪除。存好立即生效/, 'A 說明只影響之後上傳的檔');
  assert.match(await text('.adm-ttl-src'), /^目前是預設的 24 小時（主機沒設 FILE_TTL_HOURS）。主機設了 FILE_TTL_HOURS 會改用它當初始值；在這裡改過之後就以這裡為準。$/, 'A 說明 FILE_TTL_HOURS 與這裡誰為準：' + await text('.adm-ttl-src'));
  assert.match(await text('.adm-store'), /上傳 24 小時後自動刪除/, 'A 儲存空間那列寫目前的 24 小時');
  assert.ok(!(await hscroll()), 'E 1280 沒有橫向捲動');
  await shot('01-電腦1280-管理員設定-稽核與儲存-訊息附件保存時間-預設24小時');

  // ---------- B 改成 6 小時 ----------
  await save(6);
  await until(async () => /上傳 6 小時後自動刪除/.test(await text('.adm-store')), 8000, '儲存後儲存空間那列寫 6 小時');
  assert.match(await text('#toast'), /已儲存：之後上傳的訊息附件保存 6 小時；已上傳的照原本的到期時間/, 'B 提示訊息：' + await text('#toast'));
  assert.equal(await js("document.querySelector('#adm-ttl').value"), '6', 'B 下拉停在 6 小時');
  assert.equal((await call(wang.token, '/api/file-ttl')).body.hours, 6, 'B 存進資料庫');
  assert.match(await text('.adm-ttl-src'), /^目前用這裡的設定。主機的 FILE_TTL_HOURS 只決定還沒改過時的初始值，改過之後就以這裡為準。$/, 'A 改過之後說明以這裡為準');
  assert.match(await js("document.querySelector('#composer-hint').textContent"), /上傳的文件 6 小時後自動刪除/, 'B 已畫好的輸入框提示跟著換（不用重新整理）');
  await js("document.querySelector('.adm-ttl-log').open = true; true");
  assert.match(await text('.adm-ttl-log'), /王小美 把保存時間從 24 小時 改成 6 小時/, 'A 異動紀錄');
  await js("document.querySelector('.adm-ttl').scrollIntoView({ block: 'center' }); true");
  await shot('02-電腦1280-管理員設定-改成6小時後-含異動紀錄');

  // ---------- E 手機 375 ----------
  await size(375, 812);
  await admin();
  await until(() => js("(() => { const r = document.querySelector('#adm-ttl').getBoundingClientRect(), b = document.querySelector('[data-pp=\"filettl\"]').getBoundingClientRect(); return innerWidth === 375 && r.right <= innerWidth && b.right <= innerWidth && r.width > 80; })()"), 5000, 'E 375 下拉與儲存鈕都在畫面內');
  assert.ok(!(await hscroll()), 'E 375 沒有橫向捲動');
  assert.ok(await js("[...document.querySelectorAll('.adm-main .pm-card')].every(c => c.getBoundingClientRect().right <= innerWidth + 1)"), 'E 375 卡片都不超出畫面（稽核表格自己橫捲）');
  await js("document.querySelector('.adm-ttl').scrollIntoView({ block: 'start' }); true");
  await shot('03-手機375-管理員設定-訊息附件保存時間-6小時');

  // ---------- B 一般成員：輸入框提示、上傳視窗 ----------
  const newFile = await upload(chen.token, '新的截圖-6小時.png'); // 改設定後上傳：6 小時
  await size(1280, 900);
  await go(chen.token, '/p/main/messages');
  await until(async () => /上傳的文件 6 小時後自動刪除/.test(await text('#composer-hint')), 8000, 'B 輸入框提示寫 6 小時');
  await shot('04-電腦1280-一般成員-輸入框提示-上傳的文件6小時後自動刪除');
  await js(helpers);
  await shotDialog();
  assert.match(await text('#modal-root .warn-box'), /^上傳到平台後，所有群組成員都能下載，6 小時後自動刪除。每張截圖都請先確認沒有客戶資料。$/, 'B 截圖上傳視窗寫 6 小時');
  await shot('05-電腦1280-一般成員-上傳截圖視窗-6小時後自動刪除');
  await closeModal();
  await docDialog();
  assert.match(await text('#modal-root .warn-box'), /^上傳到平台後，所有群組成員都能下載，6 小時後自動刪除。$/, 'B 單一文件上傳視窗寫 6 小時：' + await text('#modal-root .warn-box'));
  await closeModal();

  // ---------- B／C 文件頁「訊息附件」分頁 ----------
  await go(chen.token, '/p/main/files');
  await until(() => js("!!document.querySelector('[data-files-tab=\"att\"]')"), 15000, '文件頁');
  await js("document.querySelector('[data-files-tab=\"att\"]').click(); true");
  await until(() => js("!!document.querySelector('.files-ttl-note') && document.querySelectorAll('.file-row').length >= 2"), 8000, '訊息附件分頁');
  assert.match(await text('.modal-sub'), /^上傳 6 小時後自動刪除$/, 'B 分頁標題下寫 6 小時：' + await text('.modal-sub'));
  assert.match(await text('.files-ttl-note'), /^保存時間由管理員設定，目前上傳 6 小時後自動刪除；設定改了只影響之後上傳的檔，已上傳的照各自顯示的時間刪除。$/, 'C 寫明只影響之後上傳的檔');
  const rows = await J("[...document.querySelectorAll('.file-row')].map(r => r.innerText.replace(/\\s+/g, ' '))");
  const rowOf = n => rows.find(r => r.includes(n)) || '';
  assert.match(rowOf('舊的截圖-24小時.png'), /剩 2[34] 小時/, 'C 舊檔照原本 24 小時：' + rowOf('舊的截圖'));
  assert.match(rowOf('新的截圖-6小時.png'), /剩 [56] 小時/, 'C 新檔 6 小時：' + rowOf('新的截圖'));
  assert.ok(oldFile.file && newFile.file, '兩個檔都上傳成功');
  assert.ok(!(await hscroll()), 'E 1280 文件頁沒有橫向捲動');
  await shot('06-電腦1280-文件頁-訊息附件分頁-6小時-舊檔仍是24小時');

  // ---------- E 手機 375：文件頁、上傳視窗 ----------
  await size(375, 812);
  await go(chen.token, '/p/main/files');
  await until(() => js("!!document.querySelector('[data-files-tab=\"att\"]')"), 15000, '手機文件頁');
  await js("document.querySelector('[data-files-tab=\"att\"]').click(); true");
  await until(() => js("!!document.querySelector('.files-ttl-note')"), 8000, '手機訊息附件分頁');
  assert.match(await text('.modal-sub'), /6 小時後自動刪除/, 'B 手機文件頁寫 6 小時');
  assert.ok(!(await hscroll()), 'E 375 文件頁沒有橫向捲動');
  await go(chen.token, '/p/main/messages');
  await until(() => js("!!document.querySelector('#file-input')"), 15000, '手機訊息頁');
  await js(helpers);
  await shotDialog();
  assert.match(await text('#modal-root .warn-box'), /6 小時後自動刪除/, 'B 手機上傳視窗寫 6 小時');
  assert.ok(!(await hscroll()), 'E 375 上傳視窗沒有橫向捲動');
  await closeModal();

  // ---------- F 英文介面：管理員設定（改成 3 天） ----------
  await size(1280, 900);
  await admin('en');
  await save(72);
  await until(async () => /deleted automatically 3 days after upload/.test(await text('.adm-store')), 8000, 'F 英文儲存空間那列寫 3 days');
  assert.equal(await text('.adm-ttl label[for="adm-ttl"]'), 'Attachment retention', 'F 英文標籤');
  assert.deepEqual(await J("[...document.querySelectorAll('#adm-ttl option')].map(o => o.textContent)"), ['1 hour', '6 hours', '24 hours (default)', '3 days', '7 days', '30 days'], 'F 英文選項分單複數');
  assert.match(await text('#toast'), /^Saved: attachments uploaded from now on are kept for 3 days; files already uploaded keep their original expiry$/, 'F 英文提示');
  assert.match(await text('#adm-ttl-hint'), /^Files and screenshots uploaded in messages are deleted automatically after this time \(project docs are not affected\)\. A change only applies to later uploads;/, 'F 英文說明');
  assert.match(await text('.adm-ttl-src'), /^This setting is in use\. The server's FILE_TTL_HOURS only sets the starting value until someone changes it here; after that, this setting wins\.$/, 'F 英文說明 FILE_TTL_HOURS');
  await js("document.querySelector('.adm-ttl-log').open = true; true");
  assert.match(await text('.adm-ttl-log'), /王小美 changed retention from 6 hours to 3 days[\s\S]*王小美 changed retention from 24 hours to 6 hours/, 'F 英文異動紀錄');
  assert.match(await text('.adm-ttl-log summary'), /^Change log$/, 'F 英文異動紀錄標題');
  const han = await js("(document.querySelector('.adm-ttl').innerText + document.querySelector('.adm-store').innerText).replace(/王小美/g, '').match(/[\\u3400-\\u9fff]+/g)?.join(' ') || ''");
  assert.equal(han, '', 'F 英文管理員設定沒有留中文：' + han);
  assert.ok(!(await hscroll()), 'F 英文 1280 沒有橫向捲動');
  await js("document.querySelector('.adm-ttl').scrollIntoView({ block: 'center' }); true");
  await shot('07-英文-電腦1280-管理員設定-訊息附件保存時間-3天');
  await size(375, 812);
  await admin('en');
  assert.ok(!(await hscroll()), 'F 英文 375 沒有橫向捲動');
  assert.ok(await js("[...document.querySelectorAll('.adm-main .pm-card')].every(c => c.getBoundingClientRect().right <= innerWidth + 1)"), 'F 英文 375 卡片都不超出畫面');
  await js("document.querySelector('.adm-ttl').scrollIntoView({ block: 'start' }); true");
  await shot('08-英文-手機375-管理員設定-訊息附件保存時間-3天');

  // ---------- F 英文介面：一般成員（改成 1 小時，看單數） ----------
  assert.equal((await call(wang.token, '/api/file-ttl', 'PUT', { hours: 1 })).body.hours, 1);
  await size(1280, 900);
  await go(chen.token, '/p/main/messages', 'en');
  await until(async () => /^Enter to send · Shift\+Enter for new line · type @ to mention · uploaded files are deleted after 1 hour$/.test(await text('#composer-hint')), 8000, 'F 英文輸入框提示 1 hour：' + await text('#composer-hint'));
  await js(helpers);
  await shotDialog();
  assert.match(await text('#modal-root .warn-box'), /^Once uploaded, every group member can download these\. They are deleted automatically after 1 hour\. Make sure no screenshot contains customer data\.$/, 'F 英文截圖上傳視窗 1 hour：' + await text('#modal-root .warn-box'));
  await shot('09-英文-電腦1280-一般成員-上傳截圖視窗-1小時');
  await closeModal();
  await docDialog();
  assert.match(await text('#modal-root .warn-box'), /^Once uploaded, all group members can download it\. It's deleted automatically after 1 hour\.$/, 'F 英文單一文件上傳視窗：' + await text('#modal-root .warn-box'));
  await closeModal();
  await go(chen.token, '/p/main/files', 'en');
  await until(() => js("!!document.querySelector('[data-files-tab=\"att\"]')"), 15000, '英文文件頁');
  await js("document.querySelector('[data-files-tab=\"att\"]').click(); true");
  await until(() => js("!!document.querySelector('.files-ttl-note')"), 8000, '英文訊息附件分頁');
  assert.equal(await text('.modal-sub'), 'Deleted automatically 1 hour after upload', 'F 英文文件頁標題下');
  assert.match(await text('.files-ttl-note'), /^The admin sets how long attachments are kept\. Files uploaded now are deleted automatically after 1 hour\./, 'F 英文文件頁說明');

  console.log('file-ttl-ui-test：全部通過（管理員設定下拉、FILE_TTL_HOURS 說明、改了立即生效、輸入框提示、上傳視窗、文件頁、舊檔不變、英文介面、1280／375 不橫向捲動）');
} finally {
  await kit.stop();
}
