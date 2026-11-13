// 聚光燈導覽（一）：共用框架＋說明第 2 章入口＋路線 A「跟著走一遍」（真的瀏覽器，中文、英文介面都驗）
// 第 2 章章首「▶ 帶我在畫面上走一次」（寬 ≥1000 才顯示）；按下去帶到專案訊息頁，4 步依序框訊息框 → 最新一張卡 → 側欄「要你處理」 → 「等你驗收」
// 遮罩不攔點擊、不送出不動資料、不記錄走過導覽；Esc／×／← → 照設計；自己點到別頁、縮到 1000 以下就結束且不留遮罩；
// 亮塊貼邊時白框四邊都看得到；結束後焦點回入口；找不到元素時改成說明（不默默跳過）；還沒加入專案只說明＋「知道了」
// 英文介面：說明框上的字（章名、標題、說明、按鈕、步數）都是英文
// 本機暫存資料庫＋無頭 Chrome／Edge，不連任何站。用法：node scripts/tour-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import fs from 'node:fs';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

assert.match(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), /<script src="\/tour\.js"><\/script>\s*<script src="\/app\.js">/, 'index.html 先載 tour.js 再載 app.js');
if (!findBrowser()) { console.log('tour-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }

const kit = await startKit('tourA');
try {
  const { call } = kit;
  const P = '預設專案';
  const join = async (name, role = 'PG') => (await call(null, '/api/join', 'POST', { name, role })).body;
  const lin = await join('林志明', 'PO');
  const chen = await join('陳大文'), C = chen.participant.participantId;
  await call(lin.token, `/api/participants/${C}/projects`, 'PUT', { projects: [P] });
  const ai = (await call(lin.token, '/api/my-ais', 'POST', { projects: [P], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const AI = ai.participantId, AT = kit.aiToken(AI);
  // 一張 AI 接單的卡（卡片串），一張等陳大文驗收的卡
  const c1 = (await call(lin.token, '/api/cards', 'POST', { requestId: 'c1', project: P, title: '匯出報名名單加日期', ownerId: AI, status: '待處理' })).body;
  await call(chen.token, '/api/messages', 'POST', { requestId: 'm1', project: P, text: `@程式助手 ${c1.cardId} 匯出報名名單加日期`, recipientIds: [AI], replyFrom: [AI], cardId: c1.cardId });
  await call(AT, '/api/messages', 'POST', { requestId: 'm2', project: P, text: '[接單] 匯出報名名單加日期，今天做完', cardId: c1.cardId, replyFrom: [] });
  const c2 = (await call(lin.token, '/api/cards', 'POST', { requestId: 'c2', project: P, title: '登入頁改字', ownerId: AI, status: '待處理' })).body;
  const ho = await call(AT, `/api/cards/${c2.cardId}/handover`, 'POST', { toId: C, progress: '改好了', nextStep: '請驗收', verify: true });
  assert.equal(ho.status, 200, '交給陳大文驗收：' + JSON.stringify(ho.body));
  const snap = async () => JSON.stringify({ m: (await call(chen.token, '/api/messages?limit=50')).body.items.map(m => m.messageId), c: (await call(chen.token, '/api/cards?limit=50')).body.items?.map(c => [c.cardId, c.status, c.owner?.participantId]) });
  const before = await snap();

  const { js, login, cdp, key } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h = 900) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await size(1280);
  // 診斷用：每個頁面一載入就記下錯誤和沒接住的 Promise（CI 上說明頁卡在「載入中」，要看是不是有錯誤）
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: "window.__errs = []; addEventListener('error', e => __errs.push('error: ' + e.message)); addEventListener('unhandledrejection', e => __errs.push('rejection: ' + (e.reason?.stack || e.reason)));" });
  const setLang = async l => { await cdp('Page.navigate', { url: kit.BASE + '/' }); await until(() => js('document.readyState === "complete"'), 15000, '首頁'); await js(`localStorage.setItem('aigile-lang', '${l}'); true`); };
  // 等不到時把當下畫面印出來（CI 上英文段曾固定等不到第 2 章，本機重現不出來）
  const helpDiag = () => js(`(async () => JSON.stringify({ path: location.pathname, lang: document.documentElement.lang, help: document.querySelector('.help-ch')?.dataset.helpCh ?? null,
    pages: [...document.querySelectorAll('[id^="page-"]')].filter(e => !e.hidden).map(e => e.id), work: (document.querySelector('#page-work')?.innerText || '').slice(0, 160), toast: document.querySelector('#toast')?.textContent || '', errs: window.__errs || [],
    fetch: await Promise.race([fetch('/help.json', { cache: 'no-store' }).then(r => r.status + ' ' + r.headers.get('content-type')).catch(e => 'fetch 失敗：' + e.message), new Promise(r => setTimeout(() => r('fetch 5 秒沒回'), 5000))]) }))()`).catch(e => 'diag 失敗：' + e.message);
  const toHelp = async (t, ch = 2) => {
    await login(t, `/help/${ch}`);
    await until(() => js(`document.querySelector('.help-ch')?.dataset.helpCh === '${ch}'`), 30000, `說明第 ${ch} 章`).catch(async e => { throw new Error(`${e.message}；畫面：${await helpDiag()}`); });
  };
  const pop = () => J(`(() => { const p = document.querySelector('.tour-pop'); if (!p) return null; const h = document.querySelector('.tour-hole').getBoundingClientRect();
    return { meta: p.querySelector('.tour-meta')?.textContent || '', title: p.querySelector('.tour-title')?.textContent || '', text: p.querySelector('.tour-text')?.textContent || '', tip: p.querySelector('.tour-tip')?.textContent || '',
      btns: [...p.querySelectorAll('.tour-foot .btn')].map(b => b.textContent), focus: document.activeElement?.dataset?.tour || '', loading: p.classList.contains('loading'), dots: p.querySelector('.tour-dots')?.getAttribute('aria-label') || '', x: p.querySelector('.tour-x')?.getAttribute('aria-label') || '',
      hole: { l: h.left, t: h.top, r: h.right, b: h.bottom }, path: decodeURIComponent(location.pathname), page: document.querySelector('#page-messages').hidden ? 'work' : 'messages' }; })()`);
  // 亮塊有沒有框住某個元素（元素先裁到畫面內；亮塊夾在畫面內留 6px）
  const covers = (h, sel) => J(`(() => { const e = ${sel}; if (!e) return false; const b = e.getBoundingClientRect(); const h = ${JSON.stringify(h)};
    const r = { left: Math.max(0, b.left), top: Math.max(0, b.top), right: Math.min(innerWidth, b.right), bottom: Math.min(innerHeight, b.bottom) };
    return r.left >= h.l - 8 && r.top >= h.t - 8 && r.right <= h.r + 8 && r.bottom <= h.b + 8; })()`);
  // 亮塊移動有 .18s 動畫：出現後等動畫跑完再量
  const stepIs = async (n, label) => { await until(async () => { const p = await pop(); return p && !p.loading && p.meta.endsWith(`${n} / 4`); }, 8000, label); await sleep(350); return pop(); };
  const noTour = () => js("!document.querySelector('.tour-pop') && !document.querySelector('.tour-hole')");
  const esc = async () => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
  const start = () => js("document.querySelector('[data-tour-start=\"2\"]').click(); true");

  // 1. 入口：第 2 章章首有；第 3 章沒有；寬不到 1000 不顯示
  await setLang('zh');
  await toHelp(chen.token);
  const entry = await J(`(() => { const e = document.querySelector('.help-head .help-tour'); return e && { shown: e.getClientRects().length > 0, btn: e.querySelector('button').textContent, note: e.querySelector('.muted').textContent }; })()`);
  assert.deepEqual(entry, { shown: true, btn: '▶ 帶我在畫面上走一次', note: '約 1 分鐘、4 步。只框出要按的地方，不會替你按、不會動到資料；隨時按 Esc 結束。' }, '第 2 章入口');
  await js("document.querySelector('.help-pager a[href=\"/help/3\"]').click(); true");
  await until(() => js("document.querySelector('.help-ch')?.dataset.helpCh === '3'"), 8000, '第 3 章');
  assert.equal(await js("!!document.querySelector('.help-tour')"), false, '第 3 章沒有入口');
  await size(999); await toHelp(chen.token);
  assert.equal(await js("document.querySelector('.help-tour').getClientRects().length"), 0, '寬 999 不顯示入口');
  await size(1280); await toHelp(chen.token);

  // 2. 第 1 步：帶到專案訊息頁、框訊息框、焦點在「下一步」、沒有「上一步」；貼邊的白框四邊看得到；不攔點擊
  await start();
  let p = await stepIs(1, '第 1 步');
  assert.equal(p.meta, '第 2 章　跟著走一遍 · 1 / 4');
  assert.equal(p.title, '在這裡交辦一件事');
  assert.equal(p.text, '開頭打 @，選你要交給的 AI，再寫要做什麼。導覽不會幫你送出，想試就自己按「送出」。');
  assert.deepEqual([p.btns, p.focus, p.dots, p.x], [['下一步'], 'next', '第 1 步，共 4 步', '結束導覽'], '第 1 步按鈕、焦點、步數');
  assert.ok(p.page === 'messages' && /\/messages$/.test(p.path) && /預設專案/.test(await js("document.querySelector('#crumbs')?.textContent || ''")), '帶到專案的訊息頁：' + p.path);
  assert.ok(await covers(p.hole, "document.querySelector('.composer')"), '框住整個訊息框');
  const vis = await J('({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight })');
  assert.ok(p.hole.l >= 3 && p.hole.t >= 3 && p.hole.r <= vis.w - 3 && p.hole.b <= vis.h - 3, '白框四邊都看得到：' + JSON.stringify({ hole: p.hole, vis }));
  assert.ok(await js("(() => { const r = document.querySelector('#input').getBoundingClientRect(); const e = document.elementFromPoint(r.left + 20, r.top + r.height / 2); return !!e && !!e.closest('.composer'); })()"), '亮塊可以點');
  assert.ok(await js("(() => { const e = document.elementFromPoint(640, 120); return !!e && !e.closest('.tour-hole'); })()"), '暗的地方也不攔點擊');
  await js("document.querySelector('#input').focus(); true");
  await key('ArrowRight'); await sleep(300);
  assert.ok((await pop()).meta.endsWith('1 / 4'), '打字中方向鍵不換步');
  await js("document.activeElement.blur(); true");

  // 3. 第 2 步：框最新一張卡的卡號列；← 回、→ 前進
  await key('ArrowRight');
  p = await stepIs(2, '第 2 步');
  assert.equal(p.title, 'AI 接單後，事情都串在這張卡下');
  assert.deepEqual(p.btns, ['上一步', '下一步']);
  assert.ok(await covers(p.hole, "[...document.querySelectorAll('#messages .cgrp')].pop().querySelector('.cg-head')"), '框卡號那一列');
  await key('ArrowLeft'); await stepIs(1, '← 回第 1 步');
  await key('ArrowRight'); await stepIs(2, '→ 第 2 步');
  await key('ArrowRight');
  p = await stepIs(3, '第 3 步');
  assert.equal(p.title, '紅色數字＝有事等你');
  assert.equal(p.text, 'AI 做完交給你、或有事要問你，這裡就會加一。點進去就是所有要你處理的事。', '有件數：照原說明');
  assert.ok(await covers(p.hole, "document.querySelector('.sidebar [data-nav=\"inbox\"]')"), '框側欄「要你處理」（含紅色數字）');

  // 4. 「下一步」換頁到要你處理，框「等你驗收」；最後一步「完成」＋灰底
  await js("document.querySelector('.tour-pop [data-tour=\"next\"]').click(); true");
  p = await stepIs(4, '第 4 步');
  assert.equal(p.title, '看過回報，再按驗收通過');
  assert.equal(p.tip, '導覽到這裡結束，按鈕要你自己按。');
  assert.deepEqual(p.btns, ['上一步', '完成']);
  assert.ok(await covers(p.hole, "document.querySelector('#page-work .wverify .ver-row')"), '框第一張等你驗收的卡與按鈕');
  assert.ok(await covers(p.hole, "document.querySelector('#page-work .wverify [data-ver-ok]')"), '驗收通過按鈕在框內');
  // 5. 完成：不留遮罩、回到說明第 2 章、結束提示、焦點回入口；沒送訊息、卡片沒變；不記錄走過導覽
  await js("document.querySelector('.tour-pop [data-tour=\"next\"]').click(); true");
  await until(noTour, 5000, '完成後不留遮罩');
  await until(() => js("document.querySelector('.help-ch')?.dataset.helpCh === '2'"), 5000, '回到說明第 2 章');
  assert.equal(await js("document.querySelector('#toast').textContent"), '導覽結束。想再看一次，回說明第 2 章按「帶我在畫面上走一次」');
  await until(() => js("document.activeElement?.matches('.help-head [data-tour-start=\"2\"]')"), 3000, '完成後焦點回到入口按鈕');
  assert.equal(await snap(), before, '導覽沒有送出訊息、沒有改卡片');
  assert.equal((await call(chen.token, '/api/me')).body.onboard.steps.walk, false, '不記錄走過導覽');

  // 6. Esc、× 結束
  await start(); await stepIs(1, 'Esc 前');
  await key('ArrowRight'); await stepIs(2, 'Esc 前第 2 步');
  await esc();
  await until(noTour, 5000, 'Esc 結束');
  await until(() => js("document.querySelector('.help-ch')?.dataset.helpCh === '2'"), 5000, 'Esc 後回說明');
  await until(() => js("document.activeElement?.matches('.help-head [data-tour-start=\"2\"]')"), 3000, 'Esc 後焦點回到入口按鈕');
  await start(); await stepIs(1, '× 前');
  await js("document.querySelector('.tour-x').click(); true");
  await until(noTour, 5000, '× 結束');

  // 7. 第 3 步自己點「要你處理」：接著走第 4 步；再自己點到別頁：結束、留在那頁
  await start();
  await stepIs(1, '點亮塊前'); await key('ArrowRight'); await stepIs(2, ''); await key('ArrowRight'); await stepIs(3, '');
  await js("document.querySelector('.sidebar [data-nav=\"inbox\"]').click(); true");
  await stepIs(4, '自己點「要你處理」接著第 4 步');
  await js("document.querySelector('.sidebar [data-nav=\"work\"]').click(); true");
  await until(noTour, 5000, '自己點到別頁就結束');
  assert.match(await js('decodeURIComponent(location.pathname)'), /\/work$/, '留在使用者點的那頁');

  // 8. 縮到 1000 以下：自動結束、不留遮罩
  await toHelp(chen.token);
  await start(); await stepIs(1, '縮窄前');
  await size(990);
  await until(noTour, 5000, '縮到 1000 以下自動結束');
  await size(1280);

  // 9. 空專案：第 2～4 步改成說明，不跳過、不用等滿 3 秒
  const pj = (await call(lin.token, '/api/projects', 'POST', { name: '空專案' })).body.id;
  const wu = await join('吳小安'), Wu = wu.participant.participantId;
  await call(lin.token, `/api/participants/${Wu}/projects`, 'PUT', { projects: [pj] });
  await toHelp(wu.token);
  await start(); await stepIs(1, '空專案第 1 步');
  let t0 = Date.now();
  await key('ArrowRight');
  p = await stepIs(2, '空專案第 2 步');
  assert.ok(Date.now() - t0 < 3000, `第 2 步不用等滿 3 秒（${Date.now() - t0}ms）`);
  assert.equal(p.text, 'AI 接單後，這裡會出現一張卡，事情都串在卡下面。你還沒交辦過，所以現在是空的。');
  await key('ArrowRight');
  p = await stepIs(3, '空專案第 3 步');
  assert.equal(p.text, '現在沒有事等你。AI 交件或問你時，這裡會出現紅色數字。');
  assert.ok(await covers(p.hole, "document.querySelector('.sidebar [data-nav=\"inbox\"]')"), '照樣框「要你處理」');
  t0 = Date.now();
  await key('ArrowRight');
  p = await stepIs(4, '空專案第 4 步');
  assert.ok(Date.now() - t0 < 3500, `第 4 步不用等滿 3 秒（${Date.now() - t0}ms）`);
  assert.equal(p.text, 'AI 交件後，會出現在這裡的「等你驗收」，按「看回報」再決定通過或退回。');
  assert.equal(p.tip, '現在沒有要驗收的，等第一件交回來再試。');
  assert.ok(await covers(p.hole, "document.querySelector('#page-work .work-head')"), '框頁首標題');
  await key('ArrowRight');
  await until(noTour, 5000, '空專案完成');

  // 10. 還沒加入任何專案：不開始，只說明＋「知道了」
  const zhang = await join('張三');
  await toHelp(zhang.token);
  const path0 = await js('location.pathname');
  await start();
  await until(() => js("!!document.querySelector('.tour-pop [data-tour-ok]')"), 5000, '沒有專案的說明');
  assert.equal(await js("document.querySelector('.tour-pop .tour-text').textContent"), '你還沒加入專案。先到左側「申請加入專案」，加入後再回來。');
  assert.deepEqual(await J("[...document.querySelectorAll('.tour-pop button')].map(b => b.textContent)"), ['知道了'], '只有「知道了」');
  assert.equal(await js('location.pathname'), path0, '沒有換頁');
  await js("document.querySelector('.tour-pop [data-tour-ok]').click(); true");
  await until(noTour, 5000, '知道了關掉');
  console.log('tour-ui-test：中文通過');

  // ================= 英文 =================
  await setLang('en');
  await toHelp(chen.token);
  assert.equal(await js("document.querySelector('.help-head .help-tour button').textContent"), '▶ Show me on screen');
  await start();
  p = await stepIs(1, '英文第 1 步');
  assert.deepEqual([p.meta, p.title, p.btns, p.dots, p.x], ['Chapter 2: Walk through it · 1 / 4', 'Hand off a task here', ['Next'], 'Step 1 of 4', 'End tour'], '英文第 1 步：' + JSON.stringify(p));
  assert.equal(p.text, 'Start with @, pick the AI you\'re handing it to, then write what needs doing. The tour won\'t send anything; to try it, click "Send" yourself.');
  for (const n of [2, 3]) { await key('ArrowRight'); p = await stepIs(n, `英文第 ${n} 步`); assert.ok(!/[㐀-鿿]/.test(p.meta + p.title + p.text + p.btns.join('')), `英文第 ${n} 步沒有中文：` + JSON.stringify(p)); }
  assert.equal(p.title, 'Red number = something is waiting for you');
  await key('ArrowRight');
  p = await stepIs(4, '英文第 4 步');
  assert.deepEqual([p.title, p.tip, p.btns], ['Read the report, then verify', 'The tour ends here; the buttons are yours to press.', ['Back', 'Done']], '英文第 4 步');
  // 英文的字比較長：說明框整個在畫面內
  assert.ok(await js("(() => { const r = document.querySelector('.tour-pop').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()"), '英文說明框在畫面內');
  await js("document.querySelector('.tour-pop [data-tour=\"next\"]').click(); true");
  await until(noTour, 5000, '英文完成');
  await until(() => js("document.querySelector('#toast').textContent.startsWith('Tour finished.')"), 3000, '英文結束提示');
  assert.equal(await js("document.querySelector('#toast').textContent"), 'Tour finished. To see it again, go to Help chapter 2 and click "Show me on screen"');
  await toHelp(zhang.token);
  await start();
  await until(() => js("!!document.querySelector('.tour-pop [data-tour-ok]')"), 5000, '英文：沒有專案的說明');
  assert.deepEqual(await J("[document.querySelector('.tour-pop .tour-text').textContent, document.querySelector('.tour-pop [data-tour-ok]').textContent]"),
    ["You haven't joined a project yet. Use \"Request to join a project\" on the left first, then come back once you're in.", 'Got it'], '英文：沒有專案');
  console.log('tour-ui-test：全部通過');
} catch (e) {
  console.error('tour-ui-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('tour-ui-test.js')) || ''); process.exitCode = 1;
} finally { await kit.stop(); }
