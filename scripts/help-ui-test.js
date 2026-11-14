// 說明頁＋新手上路（真的瀏覽器，中文、英文介面都驗）
// 說明頁：右上角「？ 說明」（手機在選單「說明與教學」）進去，/help 目錄、/help/1～5 每章有自己的網址；
//   目錄問「你會帶自己的 AI 嗎？」（預設會、選不會時第 1 章變淡）、桌機兩欄；≥1100 左邊章節清單；上一章／下一章；
//   第 5 章 /help/5#題號、複製連結；圖先留位置、圖下只寫「畫面 2-1」、點圖開原尺寸；說明頁時側欄不亮、「？ 說明」亮
//   第 2 章（跟著走一遍）看到最後就記走完（新手上路打勾）；英文介面整章是英文、圖用英文那套
// 新手上路：總覽最上面 3 項（AI 加入 → 走一遍 → 回覆）、0 件時的寫法、收合、不用了；1280／375
// 本機暫存資料庫＋無頭 Chrome／Edge，不連任何站。用法：node scripts/help-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('help-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('helpui');
try {
  const { call } = kit;
  const join = async (name, role = 'PG') => (await call(null, '/api/join', 'POST', { name, role })).body;
  const lin = await join('林志明', 'PO');
  const ai = (await call(lin.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const AT = kit.aiToken(ai.participantId);
  const { js, login, cdp, goto } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  const path_ = () => js('location.pathname + location.hash');
  const noHScroll = () => js('document.documentElement.scrollWidth <= innerWidth + 1 && [...document.querySelectorAll(".help-ch, .help-toc")].every(e => e.scrollWidth <= e.clientWidth + 1)');
  const crumbs = () => js("document.querySelector('#crumbs').textContent.replace(/\\s+/g, '')");
  const chIs = n => until(() => js(`document.querySelector('.help-ch')?.dataset.helpCh === '${n}'`), 20000, `第 ${n} 章`);
  const go = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) throw new Error('找不到 ' + ${JSON.stringify(sel)}); e.click(); return true; })()`);
  const setLang = async l => { await goto('/', '首頁'); await js(`localStorage.setItem('aigile-lang', '${l}'); true`); };
  const hub = async t => { await login(t, '/'); await until(() => js("!!document.querySelector('.hub .work-head') && !document.querySelector('#app').hidden"), 15000, '總覽'); await sleep(400); };

  // ================= 中文 =================
  const wang = await join('王小明'), W = wang.participant.participantId;
  await call(lin.token, `/api/participants/${W}/projects`, 'PUT', { projects: ['預設專案'] });
  await size(1280, 900); await setLang('zh');
  await hub(wang.token);
  // 1. 新手上路：最上面、3 項、0 件寫法、底下一行（1280／375）
  const card = () => J(`(() => { const o = document.querySelector('.ob'); if (!o) return null; const r = o.getBoundingClientRect(), g = document.querySelector('.hub-grid').getBoundingClientRect();
    return { prog: o.querySelector('.ob-prog').textContent, foot: o.querySelector('.ob-foot')?.innerText.trim() || '', collapsed: o.classList.contains('collapsed'), above: r.bottom <= g.top, hscroll: document.documentElement.scrollWidth > innerWidth + 1,
      items: [...o.querySelectorAll('.ob-item')].map(li => [li.dataset.obStep, li.classList.contains('done'), li.querySelector('.ob-txt .small').textContent, li.querySelector('.btn')?.textContent || '', li.querySelector('a.btn')?.getAttribute('href') || '']) }; })()`);
  for (const w of [1280, 375]) {
    await size(w, w < 600 ? 812 : 900); await hub(wang.token);
    const c = await card();
    assert.ok(c && c.above && !c.collapsed && !c.hscroll, `${w}：總覽最上面、展開、不橫向捲動：` + JSON.stringify(c));
    assert.equal(c.prog, '0/3 完成');
    assert.deepEqual(c.items.map(x => x.slice(0, 2)), [['ai', false], ['walk', false], ['todo', false]], `${w}：3 項、順序 AI 加入 → 走一遍 → 回覆`);
    assert.equal(c.items[0][3], '到我的 AI ›');
    assert.deepEqual(c.items[1].slice(3), ['開始 ›', '/help/2'], '走一遍連說明第 2 章');
    assert.deepEqual(c.items[2].slice(2, 4), ['等第一件「要你處理」來了再回。', ''], '0 件：不放按鈕');
    assert.equal(c.foot, w < 900 ? '做完會自動收起；之後隨時從「選單 › 說明與教學」再打開。' : '做完會自動收起；之後隨時從右上角「？ 說明」再打開。', `${w}：底下一行寫怎麼再打開`);
    assert.ok(await js("document.querySelector('[data-ob-step=\"ai\"]').textContent.includes('要帶 AI 才需要')"), '標要帶 AI 才需要');
  }
  await size(1280, 900);

  // 2. 桌機：右上角「？ 說明」在搜尋右邊、同一列
  await hub(wang.token);
  const pos = await J(`(() => { const h = document.querySelector('.topbar .help-btn').getBoundingClientRect(), s = document.querySelector('.topbar .tb-search').getBoundingClientRect(); return { hw: h.width, right: h.left >= s.right, top: Math.abs((h.top + h.bottom) / 2 - (s.top + s.bottom) / 2) < 4, text: document.querySelector('.topbar .help-btn').textContent.trim() }; })()`);
  assert.ok(pos.hw > 0 && pos.right && pos.top, '桌機：說明在搜尋右邊、同一列：' + JSON.stringify(pos));
  assert.equal(pos.text, '？說明');
  await go('.topbar .help-btn');
  await until(() => js("document.querySelectorAll('.help-toc li').length === 5"), 10000, '目錄');
  assert.equal(await path_(), '/help');
  assert.equal(await crumbs(), '說明', '目錄頁麵包屑');
  assert.equal(await js("document.querySelectorAll('.sidebar .hs-item.on, .sidebar [aria-current=\"page\"]').length"), 0, '說明頁時側欄不亮');
  assert.equal(await js("document.querySelector('.topbar .help-btn').getAttribute('aria-current')"), 'page', '「？ 說明」亮起');
  const toc = await J(`(() => { const ask = document.querySelector('.help-ask').getBoundingClientRect(), list = document.querySelector('.help-toc').getBoundingClientRect(), h = document.querySelector('.help-index h2').getBoundingClientRect(), li = [...document.querySelectorAll('.help-toc li')].map(x => x.getBoundingClientRect());
    return { sub: document.querySelector('.help-index .work-title .muted').textContent, q: document.querySelector('.help-ask').textContent.replace(/\\s+/g, ''), order: h.bottom <= ask.top && ask.bottom <= list.top,
      pressed: document.querySelector('[data-help-mode][aria-pressed="true"]').textContent, twoCol: Math.abs(li[0].top - li[1].top) < 2 && li[1].left > li[0].right, meta: document.querySelector('.ht-n').textContent, dim: document.querySelectorAll('.help-toc li.dim').length }; })()`);
  assert.equal(toc.sub, '新來的先看第 1、2 章；遇到問題看第 5 章');
  assert.equal(toc.q, '你會帶自己的AI嗎？會不會');
  assert.ok(toc.order && toc.twoCol, '問句在標題下、清單上；桌機兩欄：' + JSON.stringify(toc));
  assert.deepEqual([toc.pressed, toc.meta, toc.dim], ['會', '第 1 章 · 5 分鐘 · 要帶自己的 AI 的人', 0], '預設選「會」、章首小字');
  await go('[data-help-mode="work"]');
  assert.deepEqual(await J("[...document.querySelectorAll('.help-toc li')].map(li => li.classList.contains('dim'))"), [true, false, false, false, false], '不會：第 1 章變淡');
  assert.equal(await js("document.querySelector('.help-toc li.dim .ht-skip')?.textContent"), '不帶 AI 可跳過');
  await go('[data-help-mode="ai"]');
  assert.equal(await js("localStorage.getItem('aigile-help-mode')"), 'ai', '選擇記在這台');

  // 3. 第 2 章：左邊章節清單、內文最寬 720、四步四圖（先留位置）、圖下只寫畫面編號；看到最後就記走完
  assert.equal((await call(wang.token, '/api/me')).body.onboard.steps.walk, false);
  await go('.help-toc a[href="/help/2"]');
  await chIs(2);
  assert.equal(await path_(), '/help/2');
  assert.equal(await crumbs(), '說明▸第2章', '章節頁麵包屑');
  const early = await J(`[...document.querySelectorAll('.help-fig img')].map(i => [Math.round(i.getBoundingClientRect().height), Math.round(i.getBoundingClientRect().width * i.getAttribute('height') / i.getAttribute('width'))])`);
  assert.ok(early.length === 4 && early.every(([h, want]) => Math.abs(h - want) <= 2), '圖載入前先留好位置：' + JSON.stringify(early));
  const c2 = await J(`(() => { const side = document.querySelector('.help-side'), art = document.querySelector('.help-ch'), sr = side.getBoundingClientRect(), ar = art.getBoundingClientRect(), img = document.querySelector('.help-fig img').getBoundingClientRect();
    return { side: sr.width, sideLeft: sr.right <= ar.left, cur: side.querySelector('[aria-current="page"]').textContent, art: Math.round(ar.width), img: Math.round(img.width),
      caps: [...document.querySelectorAll('.help-fig figcaption')].map(x => x.textContent), note: document.querySelector('.help-note b').textContent, tryBtn: document.querySelector('[data-help-try]').textContent,
      step3: document.querySelectorAll('.help-step')[2].innerText, src: document.querySelector('.help-fig img').getAttribute('src'), href: document.querySelector('.help-fig a').getAttribute('href'), target: document.querySelector('.help-fig a').target,
      pager: [...document.querySelectorAll('.help-pager a')].map(a => [a.className, a.querySelector('.hp-dir').textContent]) }; })()`);
  assert.ok(c2.side === 200 && c2.sideLeft && c2.cur.endsWith('跟著走一遍：從交辦到驗收'), '左邊 200px 章節清單、目前這章亮：' + JSON.stringify(c2));
  assert.ok(c2.art <= 720 && Math.abs(c2.img - c2.art) <= 1, '內文最寬 720、圖跟內文同寬：' + JSON.stringify([c2.art, c2.img]));
  assert.deepEqual(c2.caps, ['畫面 2-1', '畫面 2-2', '畫面 2-3', '畫面 2-4'], '圖下只寫畫面編號');
  assert.deepEqual([c2.note, c2.tryBtn], ['只有人能做的事', '去訊息']);
  assert.deepEqual([c2.src, c2.href, c2.target], ['/help-img/zh/2-1.webp', '/help-img/zh/2-1.webp', '_blank'], '中文圖；點圖在新分頁開原尺寸');
  assert.match(c2.step3, /左邊「要你處理」出現紅色數字/, '桌機寫法');
  assert.deepEqual(c2.pager, [['hp-prev', '‹ 上一章'], ['hp-next', '下一章 ›']], '上一章、下一章兩格');
  assert.ok(await noHScroll(), '1280 第 2 章不橫向捲動');
  await until(() => js("[...document.querySelectorAll('.help-fig img')].slice(0, 2).every(i => i.complete && i.naturalWidth > 0)"), 8000, '圖載入');
  await js("document.querySelector('.help-try').scrollIntoView(); true");
  await until(async () => (await call(wang.token, '/api/me')).body.onboard.steps.walk === true, 8000, '看到第 2 章最後就記走完');

  // 4. 第 1 章只有下一章；上一頁回第 2 章；試試看「去訊息」帶到訊息框
  await go('.help-side a[href="/help/1"]');
  await chIs(1);
  assert.deepEqual(await J("[...document.querySelectorAll('.help-pager a')].map(a => a.className)"), ['hp-next'], '第 1 章只有下一章');
  assert.equal(await js("document.querySelector('.help-after').textContent"), '接好了？下一章交第一件事給它。');
  await js('history.back(); true');
  await chIs(2);
  await go('[data-help-try]');
  await until(() => js("location.pathname.startsWith('/p/') && location.pathname.endsWith('/messages') && document.activeElement?.id === 'input'"), 8000, '去訊息：專案訊息框、游標在輸入框');
  assert.equal(await js("document.querySelector('.topbar .help-btn').hasAttribute('aria-current')"), false, '離開說明頁「？ 說明」不亮');

  // 5. /help/5#3 直接打開：跳到那一題；複製連結
  await login(wang.token, '/help/5#3');
  await until(() => js("document.getElementById('3')?.classList.contains('hit')"), 10000, '第 5 章第 3 題');
  assert.equal(await path_(), '/help/5#3', '題號留在網址');
  assert.ok(await js("document.getElementById('3').querySelector('h3').textContent.includes('訊息太多，找不到')"));
  assert.equal(await js("getComputedStyle(document.getElementById('6').querySelector('.help-copy')).visibility"), 'hidden', '複製連結平常不顯示');
  await go('[id="6"] .help-copy');
  await until(() => js("/已複製這一題的連結|\\/help\\/5#6/.test(document.querySelector('#toast')?.textContent || '')"), 3000, '複製連結提示');
  assert.equal(await js("!!document.querySelector('[data-help-try]')"), false, '第 5 章沒有試試看');
  await size(1000, 900); await sleep(200);
  const mid = await J("(() => { const a = document.querySelector('.help-ch').getBoundingClientRect(), w = document.querySelector('.help-wrap').getBoundingClientRect(); return { side: getComputedStyle(document.querySelector('.help-side')).display, gap: Math.abs((a.left - w.left) - (w.right - a.right)) }; })()");
  assert.ok(mid.side === 'none' && mid.gap <= 2, '不到 1100 只有內文、置中：' + JSON.stringify(mid));

  // 6. 手機 375：選單裡「說明與教學」；手機寫法；只有桌機圖的格子不顯示
  await size(375, 812);
  await hub(wang.token);
  await go('#menu-btn');
  await until(() => js("!document.querySelector('#sheet').hidden"), 5000, '選單');
  assert.equal(await js("(() => { const h = document.querySelector('#sheet .sheet-help'); return h.getBoundingClientRect().height > 0 ? h.textContent.trim() : ''; })()"), '？說明與教學', '手機：選單有說明與教學');
  await go('#sheet .sheet-help');
  await until(() => js("document.querySelectorAll('.help-toc li').length === 5 && document.querySelector('#sheet').hidden"), 8000, '手機目錄、選單收起');
  assert.ok(await noHScroll(), '375 目錄不橫向捲動');
  await go('.help-toc a[href="/help/2"]');
  await chIs(2);
  const m2 = await J(`({ step3: document.querySelectorAll('.help-step')[2].innerText, step4: document.querySelectorAll('.help-step')[3].innerText, title: document.querySelector('#m-title').textContent,
    figs: [...document.querySelectorAll('.help-fig')].map(f => getComputedStyle(f).display), side: getComputedStyle(document.querySelector('.help-side')).display, tour: document.querySelector('.help-tour').getClientRects().length })`);
  assert.ok(/右上角「選單」出現紅色數字/.test(m2.step3) && !/左邊「要你處理」/.test(m2.step3), '手機寫法：' + m2.step3);
  assert.ok(/打開「選單 › 要你處理」/.test(m2.step4), '手機寫法第 4 步：' + m2.step4);
  assert.equal(m2.title, '說明');
  assert.ok(m2.figs.every(d => d === 'none') && m2.side === 'none' && m2.tour === 0, '手機：只有桌機圖的格子不顯示、沒有左邊清單、沒有導覽入口');
  assert.ok(await noHScroll(), '375 第 2 章不橫向捲動');
  for (const n of [3, 4, 5]) { await go(`.help-pager a[href="/help/${n}"]`); await chIs(n); assert.ok(await noHScroll(), `375 第 ${n} 章不橫向捲動`); }

  // 7. 有一件要你處理：寫件數＋去處理；收合；不用了
  await size(1280, 900);
  await call(AT, '/api/messages', 'POST', { requestId: 'w1', project: '預設專案', text: '王小明你好，這個怎麼做？', recipientIds: [W], replyFrom: [W] });
  await hub(wang.token);
  await until(() => js("document.querySelector('[data-ob-step=\"todo\"] .small')?.textContent === '你現在有 1 件。'"), 10000, '寫出件數');
  assert.equal(await js("document.querySelector('[data-ob-step=\"todo\"] .btn').textContent"), '去處理 ›');
  assert.deepEqual(await J("[...document.querySelectorAll('.ob-item')].map(li => li.classList.contains('done'))"), [false, true, false], '走過說明第 2 章打勾');
  await go('[data-ob-toggle]');
  await until(() => js("document.querySelector('.ob.collapsed') && !document.querySelector('.ob-list')"), 5000, '收合');
  assert.ok((await js("document.querySelector('.ob').getBoundingClientRect().height")) <= 60, '收成一行');
  await sleep(500); await hub(wang.token);
  assert.ok(await js("!!document.querySelector('.ob.collapsed')"), '重新整理後還是收著');
  await go('[data-ob-dismiss]');
  await until(() => js("!document.querySelector('.ob')"), 5000, '不用了');
  await sleep(500); await hub(wang.token);
  assert.ok(!(await js("!!document.querySelector('.ob')")), '不用了之後不再出現');
  console.log('help-ui-test：中文通過');

  // ================= 英文 =================
  const sam = await join('Sam'), S = sam.participant.participantId;
  await call(lin.token, `/api/participants/${S}/projects`, 'PUT', { projects: ['預設專案'] });
  await size(1280, 900); await setLang('en');
  await hub(sam.token);
  const e = await card();
  assert.equal(e.prog, '0/3 done', '英文進度');
  assert.deepEqual(e.items.map(x => [x[0], x[3]]), [['ai', 'Go to My AIs ›'], ['walk', 'Start ›'], ['todo', '']], '英文按鈕');
  assert.equal(e.items[2][2], 'Answer it when your first item arrives.');
  assert.equal(e.foot, "This folds away when you're done; reopen Help anytime from \"? Help\" at the top right.");
  assert.ok(!/[㐀-鿿]/.test(await js("document.querySelector('.ob').innerText")), '新手上路沒有中文：' + await js("document.querySelector('.ob').innerText"));
  assert.deepEqual(await J("[document.querySelector('.topbar .help-btn').textContent.trim(), document.querySelector('.topbar .help-btn').getAttribute('aria-label')]"), ['？Help', 'Help'], '英文「？ Help」（不是交接的 Notes）');
  await go('.topbar .help-btn');
  await until(() => js("document.querySelectorAll('.help-toc li').length === 5"), 10000, '英文目錄');
  const etoc = await J(`({ h: document.querySelector('.help-index h2').textContent, q: document.querySelector('#help-ask-q').textContent, btns: [...document.querySelectorAll('[data-help-mode]')].map(b => b.textContent), meta: document.querySelector('.ht-n').textContent, t: document.querySelector('.ht-t').textContent, crumbs: document.querySelector('#crumbs').textContent.trim(), all: document.querySelector('.help-index').innerText })`);
  assert.deepEqual([etoc.h, etoc.q, etoc.btns, etoc.meta, etoc.t, etoc.crumbs], ['Help', 'Will you bring your own AI?', ['Yes', 'No'], 'Chapter 1 · 5 min · If you bring your own AI', 'Bring your AI on board', 'Help'], '英文目錄：' + JSON.stringify(etoc));
  assert.ok(!/[㐀-鿿]/.test(etoc.all), '英文目錄沒有中文');
  await go('.help-toc a[href="/help/2"]');
  await chIs(2);
  await until(() => js("[...document.querySelectorAll('.help-fig img')].slice(0, 1).every(i => i.complete && i.naturalWidth > 0)"), 8000, '英文圖載入');
  const e2 = await J(`({ crumbs: document.querySelector('#crumbs').textContent.replace(/\\s+/g, ''), title: document.querySelector('.help-head h2').textContent, meta: document.querySelector('.help-meta').textContent, caps: [...document.querySelectorAll('.help-fig figcaption')].map(x => x.textContent),
    src: document.querySelector('.help-fig img').getAttribute('src'), step3: document.querySelectorAll('.help-step')[2].innerText, pager: [...document.querySelectorAll('.help-pager .hp-dir')].map(x => x.textContent), side: document.querySelector('.help-side .hsd-top').textContent,
    tour: document.querySelector('.help-tour').innerText.replace(/\\s+/g, ' ').trim(), tryT: document.querySelector('.help-try').innerText.replace(/\\s+/g, ' ').trim(), note: document.querySelector('.help-note').innerText.replace(/\\s+/g, ' ').trim(), lang: document.querySelector('.help-ch').lang, all: document.querySelector('.help-wrap').innerText })`);
  assert.deepEqual([e2.crumbs, e2.title, e2.meta, e2.src, e2.side, e2.lang], ['Help▸Chapter2', 'Walk through it: from request to verification', 'Chapter 2 · 3 min · Everyone', '/help-img/en/2-1.webp', 'Help contents', 'en'], '英文第 2 章：' + JSON.stringify(e2));
  assert.deepEqual(e2.caps, ['Screen 2-1', 'Screen 2-2', 'Screen 2-3', 'Screen 2-4']);
  assert.deepEqual(e2.pager, ['‹ Previous chapter', 'Next chapter ›']);
  assert.match(e2.step3, /red number appears on "Needs your attention" on the left/, '英文桌機寫法');
  assert.match(e2.tour, /^▶ Show me on screen About 1 minute, 4 steps\./, '英文導覽入口：' + e2.tour);
  assert.match(e2.tryT, /^Try it: Go to the message box/, '英文試試看：' + e2.tryT);
  assert.match(e2.note, /^Only people can do these: Verify or send back/, '英文冒號：' + e2.note);
  assert.ok(!/[㐀-鿿]/.test(e2.all), '英文第 2 章整頁沒有中文：' + (e2.all.match(/.{0,20}[㐀-鿿].{0,20}/) || [''])[0]);
  for (const n of [1, 3, 4, 5]) { await login(sam.token, `/help/${n}`); await chIs(n); assert.ok(!/[㐀-鿿]/.test(await js("document.querySelector('.help-wrap').innerText")), `英文第 ${n} 章沒有中文`); }
  await js("document.getElementById('6').querySelector('.help-copy').click(); true");
  await until(() => js("/Link to this question copied|\\/help\\/5#6/.test(document.querySelector('#toast')?.textContent || '')"), 3000, '英文複製連結提示');
  await size(375, 812);
  await login(sam.token, '/help/2'); await chIs(2);
  assert.match(await js("document.querySelectorAll('.help-step')[2].innerText"), /"Menu" at the top right/, '英文手機寫法');
  assert.equal(await js("document.querySelector('#m-title').textContent"), 'Help');
  await go('#menu-btn');
  await until(() => js("!document.querySelector('#sheet').hidden"), 5000, '英文選單');
  assert.equal(await js("document.querySelector('#sheet .sheet-help').textContent.trim()"), '？Help & tutorials');
  console.log('help-ui-test：全部通過');
} catch (e) {
  console.error('help-ui-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('help-ui-test.js')) || ''); process.exitCode = 1;
} finally { await kit.stop(); }
