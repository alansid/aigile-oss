// 畫面測試（照 UX 設計稿 KB-design-02、03、04、08）：文件頁「📚 知識庫」分頁、讀一段原文、專案文件徽章與「⋯」選單
// A. 分頁「📚 知識庫｜專案文件｜訊息附件」；黃框提醒；知識庫文件清單與每份的狀態字（一般成員看到「請 leader 上傳」）
// B. 搜尋：「文件原文 N 段 · 依符合程度排序」、每列「文件名 › 章節 · 第 N 段」＋片段高亮；找不到時提示換說法（03）
// C. 讀一段原文：回搜尋結果、第 N 段／共 N 段、上一段／下一段、下載原檔；手機按鈕固定在底部（04）
// D. 專案文件：在知識庫的標 📚；抽字失敗旁「重試」只給 leader／管理員（在知識庫分頁）；
//    改名、搬移、刪除收進「⋯」，手機只留「⋯」（下載也收進去）（08）
// E. 1280、375 不橫向捲動；中文、英文內容都搜得到
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 KB_SHOTS=資料夾 會另外截圖。用法：node scripts/kb-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';
import { makeDocx, makeZip } from './kb-fixtures.js';

if (!findBrowser()) { console.log('kb-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('p390');
try {
  const { call } = kit;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'), chen = await join('陳大文', 'PG');
  await call(liu.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  // 放進知識庫才抽字（管理員上傳、帶 kb=1）
  const up = (tok, name, body) => fetch(`${kit.BASE}/api/projects/${encodeURIComponent('預設專案')}/docs?${new URLSearchParams({ name, declared: 'true', kb: '1' })}`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body }).then(r => r.json());
  const long = '依勞動基準法規定辦理，未休完之日數得遞延至次年度。'.repeat(30);
  await up(liu.token, '雲杉員工手冊（測試假資料）.docx', await makeDocx([{ h: 1, text: '第三章 休假' }, { h: 2, text: '3.1 特別休假' }, { text: '到職滿一年者，給予特別休假 7 日；滿三年者 14 日。' + long },
    { h: 1, text: '第七章 遠距工作' }, { text: '遠距工作每週最多 2 日。Remote work requires manager approval.' }]));
  await up(liu.token, '組織圖.pdf', new TextEncoder().encode('%PDF-1.4\n%%EOF\n'));
  await up(liu.token, '部署筆記.txt', new TextEncoder().encode('-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n'));
  const broken = await makeZip([['[Content_Types].xml', '<Types/>'], ['ppt/presentation.xml', '<p:presentation/>'], ['ppt/slides/slide1.xml', new Uint8Array([9, 9, 9, 9])]], { stored: true });
  { const v = new DataView(broken.buffer); for (let p = 0; p + 4 <= broken.length; p++) { const sig = v.getUint32(p, true); if (sig === 0x04034b50) v.setUint16(p + 8, 8, true); if (sig === 0x02014b50) v.setUint16(p + 10, 8, true); } } // 標成 deflate 但內容不是：抽字失敗
  await up(liu.token, '壞掉的簡報.pptx', broken);
  await until(async () => (await call(chen.token, `/api/projects/${encodeURIComponent('預設專案')}/docs`)).body.items.every(x => x.kb.status !== 'pending'), 10000, '背景抽字完成');

  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.KB_SHOTS) return; fs.mkdirSync(process.env.KB_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.KB_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64')); };
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const visible = sel => J(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(b => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden').map(b => b.textContent.trim())`);
  const tab = async k => { await js(`document.querySelector('[data-files-tab="${k}"]').click(); true`); };
  const searchFor = async q => {
    await js(`(() => { document.querySelector('#kb-results').innerHTML = ''; const i = document.querySelector('#kb-q'); i.value = ${JSON.stringify(q)}; document.querySelector('#kb-form').requestSubmit(); return true; })()`);
    await until(() => js("!!document.querySelector('#kb-results').children.length"), 8000, '搜尋結果');
  };

  for (const [w, h, tag] of [[1280, 900, '電腦1280'], [375, 812, '手機375']]) {
    await size(w, h);
    // ---------- A ----------
    await login(chen.token, '/p/main/files');
    await until(() => js("!!document.querySelector('[data-files-tab=\"kb\"]')"), 15000, '文件頁');
    await tab('kb');
    await until(() => js("!!document.querySelector('#kb-q')"), 8000, '知識庫分頁');
    assert.deepEqual(await J("[...document.querySelectorAll('[data-files-tab]')].map(b => b.textContent)"), ['📚 知識庫', '專案文件', '訊息附件'], 'A 分頁順序');
    assert.equal(await text('#files-list .warn-box'), '⚠ 請勿上傳程式碼或客戶個資。上傳的文件會抽出文字，專案成員和 AI 都搜得到。', 'A 黃框提醒');
    assert.equal(await js("document.querySelector('#kb-q').placeholder"), '搜尋知識頁和知識庫文件原文，例如：年假、WFH、住宿', 'A 搜尋框提示');
    await until(() => js("!!document.querySelector('.kb-doc-row')"), 8000, '知識庫文件清單');
    assert.equal(await text('#files-list > p.muted.small'), '要把文件放進知識庫，請 leader 上傳，或請 leader 從專案文件加入。', 'A 一般成員：沒有上傳按鈕，改一行說明');
    assert.equal(await text('.kb-h'), '知識庫文件（4 份） 只有這裡的文件會被整理、被搜尋。', 'A 知識庫文件清單標題');
    const kbRows = await J("Object.fromEntries([...document.querySelectorAll('.kb-doc-row')].map(r => [r.querySelector('.file-name').textContent, r.querySelector('.kb-badges').textContent.trim()]))");
    assert.deepEqual(kbRows, { '雲杉員工手冊（測試假資料）.docx': '只能搜原文 · 還沒指定整理 AI', '組織圖.pdf': '這份 PDF 抽不到字，要讓 AI 整理才搜得到', '部署筆記.txt': '含密碼或金鑰，不抽字也不整理', '壞掉的簡報.pptx': '抽字失敗' }, 'A 狀態字（一般成員沒有重試、指定整理 AI）：' + JSON.stringify(kbRows));
    assert.ok(!(await hscroll()), `E ${tag} 知識庫分頁不橫向捲動`);
    await shot(`01-${tag}-知識庫分頁-知識庫文件`);

    // ---------- B ----------
    await searchFor('特別休假');
    assert.equal(await text('.kb-h'), '文件原文 1 段 · 依符合程度排序', 'B 區塊標題');
    assert.equal(await text('.kb-row .kb-row-head'), '雲杉員工手冊（測試假資料）.docx › 第三章 休假 > 3.1 特別休假 · 第 1 段', 'B 文件名 › 章節 · 第幾段');
    assert.ok(await js("[...document.querySelectorAll('.kb-row mark')].some(m => m.textContent === '特別休假')"), 'B 關鍵字高亮');
    assert.ok(!(await hscroll()), `E ${tag} 搜尋結果不橫向捲動`);
    await shot(`02-${tag}-搜尋特別休假`);

    // ---------- C ----------
    await js("document.querySelector('.kb-row').click(); true");
    await until(() => js("!!document.querySelector('.kb-text')"), 8000, '讀一段原文');
    assert.equal(await text('.kb-back'), '‹ 回搜尋結果「特別休假」', 'C 回搜尋結果');
    assert.equal(await text('.kb-read-head .kb-pill'), '第 1 段／共 2 段', 'C 第幾段／共幾段');
    assert.equal(await text('.kb-read-sec'), '第三章 休假 > 3.1 特別休假', 'C 章節');
    assert.match(await text('.kb-text'), /給予特別休假 7 日；滿三年者 14 日/, 'C 段落全文');
    assert.deepEqual(await J("[...document.querySelectorAll('.kb-pager > [data-kb-nav]')].map(b => b.disabled)"), [true, false], 'C 第一段：上一段不能按');
    if (w < 900) {
      assert.deepEqual(await visible('.kb-pager > .btn'), ['‹ 上一段', '下一段 ›', '⬇ 原檔'], 'C 手機三顆按鈕');
      assert.equal(await js("getComputedStyle(document.querySelector('.kb-pager')).position"), 'sticky', 'C 手機按鈕固定在底部');
      assert.ok(await js("(() => { const s = getComputedStyle(document.querySelector('.kb-pager')); return s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.borderTopWidth === '1px'; })()"), 'C 手機底部按鈕列有底色與上方細線（UX 第 6749 則）');
      assert.deepEqual(await visible('.kb-dl-top'), [], 'C 手機上方不放下載');
    } else {
      assert.deepEqual(await visible('.kb-read-head .kb-dl-top'), ['⬇ 下載原檔'], 'C 電腦右上角下載原檔');
      assert.equal(await text('.kb-pages'), '1 · 2', 'C 電腦顯示段號');
    }
    assert.ok(!(await hscroll()), `E ${tag} 讀一段不橫向捲動`);
    await shot(`03-${tag}-讀一段原文-第1段`);
    await js("document.querySelectorAll('.kb-pager > [data-kb-nav]')[1].click(); true");
    await until(async () => (await text('.kb-read-head .kb-pill')) === '第 2 段／共 2 段', 8000, '下一段');
    assert.match(await text('.kb-text'), /遠距工作每週最多 2 日/, 'C 下一段內容');
    await js("document.querySelector('.kb-back').click(); true");
    await until(() => js("!!document.querySelector('.kb-row')"), 8000, '回到搜尋結果');
    assert.equal(await js("document.querySelector('#kb-q').value"), '特別休假', 'C 回來時搜尋字還在');
    await searchFor('remote WORK');
    assert.equal(await js("document.querySelectorAll('.kb-row').length"), 1, 'E 英文不分大小寫搜得到');
    await searchFor('年假');
    assert.match(await text('#kb-results'), /找不到「年假」。原文是逐字比對，試試換個說法/, 'B 找不到時提示換說法');

    // ---------- D ----------
    await tab('docs');
    await until(() => js("document.querySelectorAll('.doc-row').length === 4"), 8000, '專案文件');
    assert.equal(await js("document.querySelectorAll('.doc-row .kb-tag').length"), 4, 'D 在知識庫的都標 📚 知識庫');
    assert.equal(await js("document.querySelectorAll('.doc-row .kb-pill').length"), 0, 'D 專案文件不再列抽字狀態（在知識庫分頁看）');
    const acts = () => visible('.doc-row:first-of-type .doc-acts > .btn, .doc-row:first-of-type .doc-acts .pm-more');
    assert.deepEqual(await acts(), w < 900 ? ['⋯'] : ['下載', '⋯'], `D ${tag} 列上只有${w < 900 ? '「⋯」' : '下載與「⋯」'}`);
    await js("document.querySelector('.doc-row .pm-more').click(); true");
    assert.deepEqual(await visible('.doc-row .pm-more-menu:not([hidden]) [role="menuitem"]'), w < 900 ? ['下載', '改名', '搬移', '刪除'] : ['改名', '搬移', '刪除'], `D ${tag} ⋯ 選單`);
    assert.ok(!(await hscroll()), `E ${tag} 專案文件不橫向捲動`);
    await shot(`04-${tag}-專案文件-徽章與⋯選單`);
    await js("document.querySelector('.doc-row .pm-more').click(); true");
    assert.equal(await js("document.querySelectorAll('.doc-row .pm-more-menu:not([hidden])').length"), 0, 'D 再按一次收起');
  }

  // ---------- D 管理員：抽字失敗旁「重試」（知識庫分頁） ----------
  await size(1280, 900);
  await login(liu.token, '/p/main/files');
  await until(() => js("!!document.querySelector('[data-files-tab=\"kb\"]')"), 15000, '文件頁');
  await tab('kb');
  await until(() => js("!!document.querySelector('[data-kb-redo]')"), 8000, '管理員看到重試');
  assert.equal(await js("document.querySelectorAll('[data-kb-redo]').length"), 1, 'D 只有抽字失敗那份有重試');
  assert.match(await js("document.querySelector('[data-kb-redo]').closest('.kb-doc-row').querySelector('.file-name').textContent"), /壞掉的簡報/, 'D 放在抽字失敗那列');
  assert.equal(await js("document.querySelectorAll('.kb-doc-row [data-kb-set-ai]').length"), 1, 'D 還沒指定整理 AI 旁有「指定整理 AI」');
  await shot('05-電腦1280-管理員-抽字失敗旁重試');
  await js("document.querySelector('[data-kb-redo]').click(); true");
  await until(async () => /開始補建索引/.test(await text('#toast')), 8000, 'D 補建提示');

  console.log('kb-ui-test：全部通過（知識庫分頁、知識庫文件狀態、搜尋高亮、讀一段、手機底部按鈕、📚 標示、⋯ 選單、重試、1280／375 不橫向捲動、中英文內容）');
} finally {
  await kit.stop();
}
