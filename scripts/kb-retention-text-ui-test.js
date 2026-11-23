// 畫面測試：說清楚知識庫就是專案文件、都不會自動刪除
// A. 管理員設定 › 訊息附件保存時間的說明：開頭先講「只有訊息附件會刪」，後半段原文不動
// B. 文件 › 知識庫分頁「知識庫文件（N 份）」下面一行小字；知識庫空的時候不顯示；一般成員也看得到
// C. 說明第 6 章開頭「專案文件和知識庫有什麼不同？」整段換掉
// D. 「上傳到知識庫」視窗的黃框換成「檔案會存進專案文件…」，從專案文件上傳維持原句
// 1280、375 都不橫向捲動
// E. 英文介面兩句都翻好
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 KB_RETENTION_SHOTS=資料夾 會另外截圖。用法：node scripts/kb-retention-text-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

const HINT_A = '只有訊息附件（在訊息裡上傳的文件、截圖）會在這段時間後自動刪除。專案文件和知識庫都不會自動刪除；知識庫裡的文件就是專案文件，只存一份。';
const HINT_REST = '改了只影響之後上傳的檔；已經上傳的照上傳當時的設定到期，不會提早或延後刪除。存好立即生效，不用重新啟動或部署。';
const C_TEXT = '專案文件和知識庫有什麼不同？專案文件是大家共用的檔案櫃，只存檔，AI 不會整理、也搜不到內容。知識庫不是另一個地方：它是專案文件裡你挑出來、要讓 AI 讀懂的那些，只存一份。放進知識庫的會抽字、整理成知識頁，大家和 AI 都搜得到。專案文件和知識庫都不會自動刪除；會到期刪除的只有訊息附件。';
const D_KB = '檔案會存進專案文件，長期保存、不會自動刪除，本專案成員都能下載。';
const D_DOCS = '專案文件長期保存、不會自動刪除，本專案成員都能下載。';
const NOTE_B = '這些文件也在「專案文件」裡，只存一份、不會自動刪除。移出知識庫不會刪檔，只是 AI 不再整理、搜尋它。';

if (!findBrowser()) { console.log('kb-retention-text-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('kbretain');
try {
  const { call } = kit;
  const PJ = encodeURIComponent('預設專案');
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'), chen = await join('陳大文', 'PG');
  await call(liu.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  const up = (name, text, q = {}) => fetch(`${kit.BASE}/api/projects/${PJ}/docs?${new URLSearchParams({ name, declared: 'true', ...q })}`, { method: 'POST', headers: { Authorization: 'Bearer ' + liu.token }, body: text }).then(r => r.json());

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.KB_RETENTION_SHOTS) return; fs.mkdirSync(process.env.KB_RETENTION_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.KB_RETENTION_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64')); };
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const kbTab = async tok => {
    await login(tok, '/p/main/files');
    await until(() => js("!!document.querySelector('[data-files-tab=\"kb\"]')"), 15000, '文件頁');
    await js(`document.querySelector('[data-files-tab="kb"]').click(); true`);
    await until(() => js("!!document.querySelector('.kb-docs, .kb-empty')"), 8000, '知識庫分頁');
  };

  // ---------- B 知識庫空的：不顯示 ----------
  await up('會議紀錄-1121.md', '# 週會\n下週三上線。'); // 一般專案文件，不在知識庫
  await kbTab(liu.token);
  assert.ok(await js("!!document.querySelector('.kb-empty')"), 'B 知識庫是空的');
  assert.equal(await js("!!document.querySelector('.kb-docs-note')"), false, 'B 空的時候不顯示那行');

  // ---------- A 管理員設定 ----------
  for (const [w, h, tag] of [[1280, 900, '1280'], [375, 812, '375']]) {
    await size(w, h);
    await login(liu.token, '/admin/audit');
    await until(() => js("!!document.querySelector('#adm-ttl-hint')"), 15000, '保存時間說明');
    assert.equal(await text('#adm-ttl-hint'), HINT_A + HINT_REST, `A ${tag} 說明整段`);
    assert.ok(!(await hscroll()), `C ${tag} 管理員設定不橫向捲動`);
    await js("document.querySelector('#adm-ttl-hint').scrollIntoView({ block: 'center' }); true");
    await shot(`01-${tag}-管理員設定-訊息附件保存時間說明`);
  }
  const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('專案文件不受影響'), 'A 舊說明「專案文件不受影響」已拿掉');

  // ---------- B 知識庫有文件：標題下面那行 ----------
  await up('報價單範本.md', '# 報價\n單價含稅 1,200 元。', { kb: '1', curate: '0' });
  for (const [who, tok] of [['管理員', liu.token], ['一般成員', chen.token]]) {
    for (const [w, h, tag] of [[1280, 900, '1280'], [375, 812, '375']]) {
      await size(w, h);
      await kbTab(tok);
      await until(() => js("!!document.querySelector('.kb-docs-note')"), 8000, `B ${who} ${tag} 那行`);
      assert.equal(await text('.kb-docs-note'), NOTE_B, `B ${who} ${tag} 文字`);
      assert.ok(await js("document.querySelector('.kb-h + .kb-docs-note + .kb-docs') !== null"), `B ${who} ${tag} 在標題和清單中間`);
      assert.ok(await js("document.querySelector('.kb-docs-note').classList.contains('muted') && document.querySelector('.kb-docs-note').classList.contains('small')"), 'B muted small');
      assert.ok(!(await hscroll()), `C ${who} ${tag} 知識庫分頁不橫向捲動`);
      if (who === '管理員') await shot(`02-${tag}-知識庫分頁-標題下那行`);
    }
  }

  // ---------- C 說明第 6 章開頭 ----------
  const pickFile = (input, name) => js(`(() => { const i = document.querySelector('${input}'), dt = new DataTransfer(); dt.items.add(new File(['# x'], '${name}')); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const introSel = "[...document.querySelectorAll('p, div')].filter(e => e.children.length < 3 && /^(專案文件和知識庫有什麼不同？|How are project docs)/.test(e.innerText)).pop()";
  for (const [w, h, tag] of [[1280, 900, '1280'], [375, 812, '375']]) {
    await size(w, h);
    await login(liu.token, '/help/6');
    await until(() => js(`!!(${introSel})`), 10000, 'C 說明第 6 章開頭');
    assert.equal(await js(`(${introSel}).innerText.replace(/\\s+/g, ' ').trim()`), C_TEXT, `C ${tag} 第 6 章開頭整段`);
    assert.ok(!(await hscroll()), `C ${tag} 說明不橫向捲動`);
    await js(`(${introSel}).scrollIntoView({ block: 'center' }); true`);
    await shot(`03-${tag}-說明第6章開頭`);
  }

  // ---------- D 上傳視窗的黃框：只有上傳到知識庫才換 ----------
  for (const [w, h, tag] of [[1280, 900, '1280'], [375, 812, '375']]) {
    await size(w, h);
    await kbTab(liu.token);
    await pickFile('#kb-input', '規章.md');
    await until(() => js("!!document.querySelector('#modal-root .warn-box')"), 5000, 'D 上傳到知識庫視窗');
    assert.equal(await text('#modal-root .warn-box'), D_KB, `D ${tag} 上傳到知識庫的黃框`);
    assert.ok(!(await hscroll()), `D ${tag} 視窗不橫向捲動`);
    await shot(`04-${tag}-上傳到知識庫-黃框`);
    await js("document.querySelector('#modal-root [data-close]').click(); true");
    await until(() => js("!document.querySelector('#modal-root .warn-box')"), 5000, 'D 視窗關掉');
  }
  await size(1280, 900);
  await js(`document.querySelector('[data-files-tab="docs"]').click(); true`);
  await until(() => js("!!document.querySelector('#docs-input')"), 8000, 'D 專案文件分頁');
  await pickFile('#docs-input', '週會.md');
  await until(() => js("!!document.querySelector('#modal-root .warn-box')"), 5000, 'D 上傳到專案文件視窗');
  assert.equal(await text('#modal-root .warn-box'), D_DOCS, 'D 從專案文件上傳維持原句');
  await js("document.querySelector('#modal-root [data-close]').click(); true");
  await until(() => js("!document.querySelector('#modal-root .warn-box')"), 5000, 'D 視窗關掉');

  // ---------- E 英文介面 ----------
  await size(1280, 900);
  await login(liu.token, '/');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  const enReady = () => until(() => js("document.documentElement.lang === 'en' && !document.documentElement.classList.contains('i18n-wait')"), 15000, 'E 英文介面');
  await login(liu.token, '/admin/audit');
  await enReady();
  await until(() => js("!!document.querySelector('#adm-ttl-hint')"), 15000, 'E 保存時間說明');
  await sleep(400);
  assert.equal(await text('#adm-ttl-hint'), 'Only message attachments (files and screenshots uploaded in messages) are deleted after this time. Project docs and the knowledge base are never deleted automatically; knowledge base files are project docs, stored once. A change only applies to later uploads; files already uploaded expire under the setting in effect when they were uploaded, never earlier or later. Takes effect as soon as you save, no restart or redeploy needed.', 'E 保存時間說明');
  await js("document.querySelector('#adm-ttl-hint').scrollIntoView({ block: 'center' }); true");
  await shot('05-1280-英文-管理員設定-保存時間說明');
  await login(liu.token, '/p/main/files');
  await enReady();
  await js("document.querySelector('[data-files-tab=\"kb\"]').click(); true");
  await until(() => js("!!document.querySelector('.kb-docs-note')"), 8000, 'E 知識庫那行');
  await sleep(400);
  assert.equal(await text('.kb-docs-note'), 'These files are also in "Project docs": one copy, never deleted automatically. Removing one from the knowledge base doesn\'t delete it; AI just stops curating and searching it.', 'E 知識庫那行');
  assert.ok(!(await hscroll()), 'C 英文 1280 不橫向捲動');
  await shot('06-1280-英文-知識庫分頁-標題下那行');
  await pickFile('#kb-input', 'rules.md');
  await until(() => js("!!document.querySelector('#modal-root .warn-box')"), 5000, 'E 上傳到知識庫視窗');
  await sleep(400);
  assert.equal(await text('#modal-root .warn-box'), 'Files are saved to Project docs: kept long-term, never deleted automatically, and downloadable by project members.', 'E 上傳到知識庫的黃框');
  await shot('07-1280-英文-上傳到知識庫-黃框');
  await js("document.querySelector('#modal-root [data-close]').click(); true");
  await until(() => js("!document.querySelector('#modal-root .warn-box')"), 5000, 'E 視窗關掉');
  await login(liu.token, '/help/6');
  await enReady();
  await until(() => js(`!!(${introSel})`), 10000, 'E 說明第 6 章開頭');
  await sleep(400);
  assert.equal(await js(`(${introSel}).innerText.replace(/\\s+/g, ' ').trim()`), 'How are project docs and the knowledge base different? Project docs are the shared file cabinet: files are stored only, and AI doesn\'t organize or search them. The knowledge base isn\'t a separate place: it\'s the project docs you pick for AI to understand, stored once. Their text is extracted and curated into knowledge pages that everyone and every AI can search. Neither project docs nor the knowledge base are deleted automatically; only message attachments expire.', 'E 說明第 6 章開頭');
  await js(`(${introSel}).scrollIntoView({ block: 'center' }); true`);
  await shot('08-1280-英文-說明第6章開頭');

  console.log('kb-retention-text-ui-test：全部通過（說明第 6 章開頭、上傳到知識庫的黃框、保存時間說明先講只有訊息附件會刪、知識庫標題下那行、空的時候不顯示、一般成員也看得到、英文四句、1280／375 不橫向捲動）');
} finally {
  await kit.stop();
}
