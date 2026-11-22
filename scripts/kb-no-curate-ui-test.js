// 畫面測試：放進知識庫可以選「只抽字、不整理」
// A. 上傳到知識庫視窗有勾選「讓 AI 整理成知識頁」（預設勾）＋說明；不勾上傳 → 清單「只搜原文，不整理」＋「請 AI 整理」＋下面一行小字
// B. 專案文件勾選 → 「加入知識庫（N 份）」視窗，同一個勾選；不勾加入 → 提示「已加入知識庫，只抽字、不整理。」
// C. 已整理文件的 ⋯：下載原檔／改成不整理／移出知識庫；改成不整理先確認，完成提示「已改成不整理，知識頁保留。」
// D. 一般成員看不到「請 AI 整理」與 ⋯；1280、375 不橫向捲動
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 KB_NO_CURATE_SHOTS=資料夾 會另外截圖。用法：node scripts/kb-no-curate-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('kb-no-curate-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('kbnocurate');
try {
  const { call } = kit;
  const PJ = encodeURIComponent('預設專案'), KB = `/api/projects/${PJ}/kb`;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'), chen = await join('陳大文', 'PG');
  await call(liu.token, `/api/participants/${chen.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PO', role: '產品負責', name: '整理助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  await call(liu.token, `${KB}/settings`, 'PUT', { aiId: ai.participantId });
  const up = (name, text, q = {}) => fetch(`${kit.BASE}/api/projects/${PJ}/docs?${new URLSearchParams({ name, declared: 'true', ...q })}`, { method: 'POST', headers: { Authorization: 'Bearer ' + liu.token }, body: text }).then(r => r.json());
  const docsOf = async () => new Map((await call(liu.token, `/api/projects/${PJ}/docs`)).body.items.map(d => [d.name, d]));
  // 已整理的一份：放進知識庫 → 整理 AI 寫一頁
  const hb = (await up('員工手冊-2026版.md', '# 休假\n## 特別休假\n到職滿一年給 7 日。', { kb: '1' })).doc.docId;
  await until(async () => (await docsOf()).get('員工手冊-2026版.md').kb.org === 'todo', 10000, '排進整理卡');
  const cardId = (await docsOf()).get('員工手冊-2026版.md').kb.cardId;
  const mcp = (await call(ai.token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aigile_kb_write', arguments: { project: '預設專案', kind: 'source', title: '員工手冊', summary: '休假', sources: [hb], cardId, body: '## 重點\n- 特別休假 7 日。' } } })).body;
  assert.ok(!mcp.result?.isError, '整理 AI 寫頁：' + JSON.stringify(mcp).slice(0, 200));
  await up('會議紀錄-1121.md', '# 週會\n下週三上線。'); // 一般專案文件，B 用

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.KB_NO_CURATE_SHOTS) return; fs.mkdirSync(process.env.KB_NO_CURATE_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.KB_NO_CURATE_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64')); };
  const text = sel => js(`(document.querySelector(${JSON.stringify(sel)})?.innerText || '').replace(/\\s+/g, ' ').trim()`);
  const tab = async (tok, which) => {
    await login(tok, '/p/main/files');
    await until(() => js("!!document.querySelector('[data-files-tab=\"kb\"]')"), 15000, '文件頁');
    await js(`document.querySelector('[data-files-tab="${which}"]').click(); true`);
    await until(() => js(which === 'kb' ? "!!document.querySelector('.kb-docs')" : "!!document.querySelector('[data-kb-pick]')"), 8000, which);
  };
  const row = name => `[...document.querySelectorAll('.kb-doc-row')].find(r => r.innerText.includes(${JSON.stringify(name)}))`;
  const toastIs = t => until(() => js(`document.querySelector('#toast')?.innerText === ${JSON.stringify(t)}`), 8000, '提示：' + t);
  const box = '讓 AI 整理成知識頁 不勾：照樣抽字，大家和 AI 都搜得到原文，只是不寫知識頁、不花整理的 token。之後可以再按「請 AI 整理」。';

  // ---------- A 上傳到知識庫：勾選預設勾，不勾上傳 ----------
  await tab(liu.token, 'kb');
  await js(`(() => { const i = document.querySelector('#kb-input'), dt = new DataTransfer(); dt.items.add(new File(['# 報價\\n單價含稅 1,200 元。'], '報價單範本.md')); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await until(() => js("!!document.querySelector('.modal [data-kb-curate-box]')"), 5000, 'A 上傳視窗有勾選');
  assert.equal(await text('.modal .kb-curate-box'), box, 'A 勾選文字');
  assert.equal(await js("document.querySelector('.modal [data-kb-curate-box]').checked"), true, 'A 預設勾');
  await js("document.querySelector('.modal [data-kb-curate-box]').click(); document.querySelector('#up-declare').click(); true");
  await shot('01-1280-上傳到知識庫-不勾');
  await js("document.querySelector('#up-go').click(); true");
  await until(async () => (await docsOf()).get('報價單範本.md')?.kb.status === 'indexed', 10000, 'A 抽完字');
  assert.equal((await docsOf()).get('報價單範本.md').kb.org, 'off', 'A 不勾上傳：只抽字不整理');

  for (const [w, h, tag] of [[1280, 900, '1280'], [375, 812, '375']]) {
    await size(w, h);
    await tab(liu.token, 'kb');
    assert.equal(await js(`${row('報價單範本.md')}.querySelector('.kb-badges').innerText.replace(/\\s+/g, ' ').trim()`), '只搜原文，不整理 請 AI 整理', `A ${tag} 清單狀態＋請 AI 整理`);
    assert.ok(await js("[...document.querySelectorAll('#kb-results p')].some(p => p.innerText === '「只搜原文，不整理」：AI 搜得到原文、回答附出處，但沒有知識頁。')"), 'A 清單下面小字');
    assert.equal(await js(`!!${row('報價單範本.md')}.querySelector('[data-kb-more]')`), false, 'A 沒整理的沒有 ⋯');
    // ---------- C ⋯ 選單 ----------
    await js(`${row('員工手冊-2026版.md')}.querySelector('[data-kb-more]').click(); true`);
    assert.equal(await js(`${row('員工手冊-2026版.md')}.querySelector('.pm-more-menu').innerText.replace(/\\s+/g, ' ').trim()`), '⬇ 下載原檔 改成不整理 移出知識庫', `C ${tag} ⋯ 三項`);
    assert.ok(!(await hscroll()), `D ${tag} 不橫向捲動`);
    await shot(`02-${tag}-清單-只搜原文-已整理的選單`);
    await js(`${row('員工手冊-2026版.md')}.querySelector('[data-kb-act="stop"]').click(); true`);
    await until(() => js("!!document.querySelector('.confirm-root')"), 5000, 'C 確認視窗');
    assert.equal(await text('.confirm-root .modal-title, .confirm-root h2'), '改成不整理？', 'C 確認標題');
    assert.equal(await text('.confirm-root .confirm-msg'), '「員工手冊-2026版.md」已寫好的 1 頁知識頁會留著，但之後原文換新版也不會自動更新。這份照樣搜得到原文。', 'C 確認內文');
    await shot(`03-${tag}-改成不整理-確認`);
    if (tag === '1280') await js("document.querySelector('.confirm-root [data-close]').click(); true");
    else {
      await js("document.querySelector('.confirm-root [data-ok]').click(); true");
      await toastIs('已改成不整理，知識頁保留。');
      assert.equal((await docsOf()).get('員工手冊-2026版.md').kb.org, 'off', 'C 改成不整理');
    }
  }

  // ---------- B 從專案文件加入：同一個勾選，不勾 ----------
  for (const [w, h, tag] of [[1280, 900, '1280'], [375, 812, '375']]) {
    await size(w, h);
    await tab(liu.token, 'docs');
    await js(`[...document.querySelectorAll('.doc-row')].find(r => r.innerText.includes('會議紀錄-1121.md')).querySelector('[data-kb-pick]').click(); true`);
    await js("document.querySelector('[data-kb-add]').click(); true");
    await until(() => js("!!document.querySelector('.confirm-root [data-kb-curate-box]')"), 5000, 'B 加入視窗');
    assert.equal(await text('.confirm-root .modal-title, .confirm-root h2'), '加入知識庫（1 份）', 'B 標題');
    assert.equal(await text('.confirm-root .kb-curate-box'), box, 'B 勾選文字');
    assert.equal(await js("document.querySelector('.confirm-root [data-kb-curate-box]').checked"), true, 'B 預設勾');
    assert.ok(!(await hscroll()), `D ${tag} 加入視窗不橫向捲動`);
    await shot(`04-${tag}-加入知識庫視窗`);
    if (tag === '1280') { await js("document.querySelector('.confirm-root [data-close]').click(); true"); continue; }
    await js("document.querySelector('.confirm-root [data-kb-curate-box]').click(); document.querySelector('.confirm-root [data-ok]').click(); true");
    await toastIs('已加入知識庫，只抽字、不整理。');
    await until(async () => (await docsOf()).get('會議紀錄-1121.md').kb.org === 'off', 8000, 'B 不勾加入：off');
  }

  // ---------- A2 請 AI 整理 ----------
  await size(1280, 900);
  await tab(liu.token, 'kb');
  await js(`${row('報價單範本.md')}.querySelector('[data-kb-curate]').click(); true`);
  await until(() => js("/^已排進整理，整理助手會接手（/.test(document.querySelector('#toast')?.innerText || '')"), 8000, 'A2 請 AI 整理提示');
  await shot('06-1280-請AI整理-提示');
  assert.equal((await docsOf()).get('報價單範本.md').kb.org, 'todo', 'A2 請 AI 整理：排進整理卡');

  // 說明第 6 章第 5 步加的那條
  await login(liu.token, '/help/6');
  await until(() => js("[...document.querySelectorAll('li')].some(l => l.innerText.includes('表單、報價單'))"), 10000, '說明第 6 章');
  assert.ok(await js("[...document.querySelectorAll('li')].some(l => l.innerText === '不需要寫成知識頁的（例如表單、報價單），放進去時取消勾選「讓 AI 整理成知識頁」：一樣搜得到原文，不花整理的 token。')"), '說明第 6 章第 5 步有新的一條');
  await js("[...document.querySelectorAll('li')].find(l => l.innerText.includes('表單、報價單')).scrollIntoView({ block: 'center' }); true");
  await shot('07-1280-說明第6章-表單報價單可以不勾');

  // ---------- D 一般成員 ----------
  await tab(chen.token, 'kb');
  assert.equal(await js("document.querySelectorAll('[data-kb-curate], [data-kb-more]').length"), 0, 'D 一般成員沒有「請 AI 整理」與 ⋯');
  assert.ok(await js(`${row('會議紀錄-1121.md')}.innerText.includes('只搜原文，不整理')`), 'D 一般成員看得到狀態');

  // ---------- E 英文介面 ----------
  await up('Quote form.md', '# Form\nFill in the date.');
  await login(liu.token, '/');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await login(liu.token, '/p/main/files');
  await until(() => js("document.documentElement.lang === 'en' && !document.documentElement.classList.contains('i18n-wait')"), 15000, 'E 英文介面');
  await js("document.querySelector('[data-files-tab=\"kb\"]').click(); true");
  await until(() => js("!!document.querySelector('.kb-docs')"), 8000, 'E 知識庫');
  await sleep(400);
  assert.equal(await js(`${row('會議紀錄-1121.md')}.querySelector('.kb-badges').innerText.replace(/\\s+/g, ' ').trim()`), 'Text search only, not curated Ask AI to curate', 'E 狀態與按鈕');
  assert.ok(await js("[...document.querySelectorAll('#kb-results p')].some(p => p.innerText === '\"Text search only\": AI can search the original text and cite it, but there are no knowledge pages.')"), 'E 小字');
  await js(`(() => { const i = document.querySelector('#kb-input'), dt = new DataTransfer(); dt.items.add(new File(['# x'], 'x.md')); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await until(() => js("!!document.querySelector('.modal [data-kb-curate-box]')"), 5000, 'E 上傳視窗');
  await sleep(400);
  assert.equal(await text('.modal .kb-curate-box'), 'Let AI write knowledge pages If unchecked, the text is still read and searchable by everyone and every AI, but no knowledge pages are written and no tokens are spent on curation. You can click "Ask AI to curate" later.', 'E 勾選');
  await js("document.querySelector('#modal-root [data-close]').click(); true");
  await until(() => js("!document.querySelector('#modal-root [data-kb-curate-box]')"), 5000, 'E 上傳視窗關掉');
  await js("document.querySelector('[data-files-tab=\"docs\"]').click(); true");
  await until(() => js("!!document.querySelector('[data-kb-pick]')"), 8000, 'E 專案文件');
  await js(`[...document.querySelectorAll('.doc-row')].find(r => r.innerText.includes('Quote form.md')).querySelector('[data-kb-pick]').click(); true`);
  await js("document.querySelector('[data-kb-add]').click(); true");
  await until(() => js("!!document.querySelector('.confirm-root [data-kb-curate-box]')"), 5000, 'E 加入視窗');
  await sleep(400);
  assert.equal(await text('.confirm-root h2'), 'Add to knowledge base (1)', 'E 加入視窗標題');
  assert.equal(await text('.confirm-root [data-ok]'), 'Add to knowledge base', 'E 加入按鈕');
  await shot('05-1280-英文-加入知識庫');
  await js("document.querySelector('.confirm-root [data-close]').click(); true");

  // Help chapter 6 step 5 (English)
  await login(liu.token, '/help/6');
  await until(() => js("[...document.querySelectorAll('li')].some(l => l.innerText.includes('forms or quotes'))"), 10000, 'E 說明第 6 章');
  const enItem = `For files that don't need knowledge pages (like forms or quotes), uncheck "Let AI write knowledge pages" when adding them. They stay searchable and cost no curation tokens.`;
  assert.ok(await js(`[...document.querySelectorAll('li')].some(l => l.innerText === ${JSON.stringify(enItem)})`), 'E 說明第 6 章第 5 步英文');
  await js("[...document.querySelectorAll('li')].find(l => l.innerText.includes('forms or quotes')).scrollIntoView({ block: 'center' }); true");
  await shot('07-1280-英文-說明第6章');

  console.log('kb-no-curate-ui-test：全部通過（上傳／加入的勾選、只搜原文狀態與小字、請 AI 整理、⋯ 改成不整理確認、一般成員看不到按鈕、1280／375 不橫向捲動）');
} finally {
  await kit.stop();
}
