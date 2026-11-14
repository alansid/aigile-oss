// 聚光燈導覽（二）：說明第 1 章路線 B「讓你的 AI 加入」＋新手上路「帶我走」（真的瀏覽器，中文、英文介面都驗）
// 第 1 章章首有入口，選「不會帶 AI」時變灰、寫「不帶 AI 可跳過」；路線 B 四步：頭像選單「我的 AI」→「＋ 新增 AI」→
//   最新那隻接入分頁的「工具」（Claude Code｜Codex｜其他）→「複製」那一列（「複製接入文字」）；
//   第 2 步「下一步」一律停用、有 AI 時給「已經有 AI 了，跳過這步」連結（平台 PLAT-319）；自己開新增表單就進表單小步（細節在 tour-form-ui-test）；
//   其他彈窗（例：編輯 AI）蓋住時暫停，灰底只寫「表單關掉後就能繼續。」；沒有 AI 時寫「建好 AI 後就能繼續」；
//   Token 過期改框「重發 Token」，標題「先重發 Token」、灰底「重發要你自己按…」
// 新手上路第 1、2 項加「帶我走」（寬 ≥1000），直接開始那一章；結束回總覽、焦點回「帶我走」；導覽不碰 Token、不替人按「複製」、走完不算完成
// 本機暫存資料庫＋無頭 Chrome／Edge，不連任何站。用法：node scripts/tour-ai-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('tour-ai-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('tourB');
try {
  const { call, sql } = kit;
  const P = '預設專案';
  const join = async (name, role = 'PG') => (await call(null, '/api/join', 'POST', { name, role })).body;
  const lin = await join('林志明', 'PO');
  const chen = await join('陳大文'), C = chen.participant.participantId;
  await call(lin.token, `/api/participants/${C}/projects`, 'PUT', { projects: [P] });
  const newAi = async (t, name) => (await call(t, '/api/my-ais', 'POST', { projects: [P], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const snap = async t => JSON.stringify({ m: (await call(t, '/api/messages?limit=50')).body.items.map(m => m.messageId), ais: (await call(t, '/api/my-ais')).body.items.map(a => [a.participantId, a.status, a.expiresAt]) });

  const { js, login, cdp, key, goto } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h = 900) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await size(1280);
  const setLang = async l => { await goto('/', '首頁'); await js(`localStorage.setItem('aigile-lang', '${l}'); true`); };
  const toHelp = async (t, ch) => { await login(t, `/help/${ch}`); await until(() => js(`document.querySelector('.help-ch')?.dataset.helpCh === '${ch}'`), 30000, `說明第 ${ch} 章`); };
  const pop = () => J(`(() => { const p = document.querySelector('.tour-pop'); if (!p) return null; const hh = document.querySelector('.tour-hole'), h = hh.getBoundingClientRect();
    return { meta: p.querySelector('.tour-meta')?.textContent || '', title: p.querySelector('.tour-title')?.textContent || '', text: p.querySelector('.tour-text')?.textContent || '', tip: p.querySelector('.tour-tip')?.textContent || '',
      block: p.querySelector('.tour-block')?.textContent || '', btns: [...p.querySelectorAll('.tour-foot .btn')].map(b => b.textContent + (b.disabled ? '(停用)' : '')),
      loading: p.classList.contains('loading'), paused: p.classList.contains('paused'), holeShown: getComputedStyle(hh).display !== 'none',
      hole: { l: h.left, t: h.top, r: h.right, b: h.bottom }, page: decodeURIComponent(location.pathname) }; })()`);
  const covers = (h, sel) => J(`(() => { let els = ${sel}; els = (Array.isArray(els) ? els : [els]).filter(Boolean); if (!els.length) return false; const h = ${JSON.stringify(h)};
    return els.every(e => { const b = e.getBoundingClientRect(); const r = { left: Math.max(0, b.left), top: Math.max(0, b.top), right: Math.min(innerWidth, b.right), bottom: Math.min(innerHeight, b.bottom) };
      return r.right > r.left && r.left >= h.l - 8 && r.top >= h.t - 8 && r.right <= h.r + 8 && r.bottom <= h.b + 8; }); })()`);
  const stepIs = async (n, label, ch = /^(第 1 章|Chapter 1)/) => { await until(async () => { const p = await pop(); return p && !p.loading && p.meta.endsWith(`${n} / 4`) && ch.test(p.meta); }, 8000, label); await sleep(350); return pop(); };
  const noTour = () => js("!document.querySelector('.tour-pop') && !document.querySelector('.tour-hole')");
  const esc = async () => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
  const start = n => js(`document.querySelector('[data-tour-start="${n}"]').click(); true`);

  // 1. 第 1 章入口；選「不會帶 AI」時變灰
  await setLang('zh');
  await toHelp(chen.token, 1);
  let entry = await J("(() => { const e = document.querySelector('.help-head .help-tour'); return e && { shown: e.getClientRects().length > 0, dim: e.classList.contains('dim'), btn: e.querySelector('button').textContent, skip: e.querySelector('.ht-skip')?.textContent || '' }; })()");
  assert.deepEqual(entry, { shown: true, dim: false, btn: '▶ 帶我在畫面上走一次', skip: '' }, '第 1 章入口');
  await js("localStorage.setItem('aigile-help-mode', 'work'); true");
  await toHelp(chen.token, 1);
  entry = await J("(() => { const e = document.querySelector('.help-head .help-tour'); return { dim: e.classList.contains('dim'), skip: e.querySelector('.ht-skip')?.textContent || '' }; })()");
  assert.deepEqual(entry, { dim: true, skip: '不帶 AI 可跳過' }, '不帶 AI 時入口變灰');
  await js("localStorage.setItem('aigile-help-mode', 'ai'); true");
  await toHelp(chen.token, 1);

  // 2. 還沒有 AI：第 1 步打開頭像選單框「我的 AI」；第 2 步「下一步」不能按；自己開表單＝暫停
  const before0 = await snap(chen.token);
  await start(1);
  let p = await stepIs(1, '第 1 步');
  assert.equal(p.meta, '第 1 章　讓你的 AI 加入 · 1 / 4');
  assert.equal(p.title, '你的 AI 都在「我的 AI」');
  assert.equal(await js("document.querySelector('#av-menu').hidden"), false, '頭像選單展開');
  assert.ok(await covers(p.hole, "document.querySelector('#av-menu [data-av=\"myai\"]')"), '框選單裡「我的 AI」');
  await js("document.querySelector('.tour-pop [data-tour=\"next\"]').click(); true");
  p = await stepIs(2, '第 2 步');
  assert.match(p.page, /my-ai/, '帶到我的 AI');
  assert.equal(await js("document.querySelector('#av-menu').hidden"), true, '選單收起來');
  assert.ok(await covers(p.hole, "document.querySelector('#ai-new')"), '框「＋ 新增 AI」');
  assert.equal(p.title, '按「＋ 新增 AI」建一隻');
  assert.deepEqual([p.block, p.tip], ['建好 AI 後就能繼續', ''], '還沒有 AI：寫「建好 AI 後就能繼續」，不同時寫「可以直接按下一步」');
  assert.deepEqual(p.btns, ['上一步', '結束', '下一步(停用)'], '下一步不能按、可以結束');
  // 平台 PLAT-313：用真的滑鼠（CDP）按「上一步」，會觸發頁面上「點選單外就關選單」；回第 1 步後頭像選單要開著、1 秒後還停在第 1 步
  const mouse = async sel => { const r = await J(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); };
  await mouse('.tour-foot [data-tour="prev"]');
  await stepIs(1, '滑鼠按上一步回第 1 步'); await sleep(1000);
  assert.ok((await pop()).meta.endsWith('1 / 4'), '1 秒後還停在第 1 步（不會跳回第 2 步）');
  assert.equal(await js("document.querySelector('#av-menu').hidden"), false, '回第 1 步：頭像選單開著');
  await mouse('.tour-foot [data-tour="next"]');
  p = await stepIs(2, '滑鼠按下一步回第 2 步');
  assert.equal(await js("document.querySelector('#av-menu').hidden"), true, '回第 2 步：頭像選單收起來，不蓋住「＋ 新增 AI」');
  await key('ArrowRight'); await sleep(400);
  assert.ok((await pop()).meta.endsWith('2 / 4'), '方向鍵也不會往下');
  assert.ok(await js("!document.querySelector('.tour-skipline')"), '還沒有 AI：不給跳過連結');
  await mouse('#ai-new'); // 自己開新增表單：進表單小步
  await until(async () => { const q = await pop(); return q && !q.loading && q.meta === '第 1 章 · 第 2 步 › 表單 · 1 / 4'; }, 8000, '表單打開進表單 1/4');
  assert.ok(await js("!!document.querySelector('#modal-root .modal')"), '表單真的打開了（導覽沒有擋）');
  await esc(); // Esc 給表單
  await until(async () => { const q = await pop(); return q && !q.paused && q.holeShown && q.meta.endsWith('2 / 4'); }, 5000, '表單關掉回到第 2 步');
  assert.equal(await js("!!document.querySelector('#modal-root .modal')"), false, 'Esc 關的是表單');
  await js("document.querySelector('.tour-foot [data-tour=\"close\"]').click(); true");
  await until(noTour, 5000, '按結束');
  await until(() => js("document.querySelector('.help-ch')?.dataset.helpCh === '1'"), 5000, '回到說明第 1 章');
  assert.equal(await snap(chen.token), before0, '一路沒有動資料');

  // 3. 有 AI：第 3 步展開最新那隻的接入分頁、框「工具」；第 4 步框「複製」；導覽不替人選工具、不按複製、不動 Token
  await newAi(chen.token, '舊助手'); await sleep(30);
  const N = (await newAi(chen.token, '新助手')).participantId;
  await toHelp(chen.token, 1);
  const before = await snap(chen.token);
  await start(1);
  await stepIs(1, '有 AI 第 1 步');
  await key('ArrowRight');
  p = await stepIs(2, '有 AI 第 2 步');
  const TIP2 = '按「＋ 新增 AI」開始；已經有 AI 的話按下面的連結跳過。';
  assert.deepEqual([p.block, p.tip, p.btns], ['', TIP2, ['上一步', '下一步(停用)']], '有 AI：下一步也停用，要先走完新增 AI');
  assert.equal(await js("document.querySelector('.tour-skipline [data-tour=\"skip\"]')?.textContent || ''"), '已經有 AI 了，跳過這步', '有 AI：給跳過連結');
  await key('ArrowRight'); await sleep(400);
  assert.ok((await pop()).meta.endsWith('2 / 4'), '→ 鍵也不能跳過第 2 步');
  // 新增表單以外的彈窗（例：編輯某隻 AI）：照舊暫停，灰底換成「表單關掉後就能繼續」；關掉回到第 2 步，灰底恢復
  await js(`document.querySelector('#ai-list .ma-more[data-id="${N}"]').click(); true`); // 說明框可能蓋住「⋯」，這裡只是要打開編輯表單，用程式點
  await until(() => js(`!!document.querySelector('#ai-list .ma-menu [data-act="edit"]')`), 5000, '「⋯」選單');
  await js(`document.querySelector('#ai-list .ma-menu [data-act="edit"]').click(); true`);
  await until(async () => { const q = await pop(); return q?.paused && !q.holeShown; }, 5000, '有 AI：編輯表單打開時暫停');
  p = await pop();
  assert.deepEqual([p.tip, p.btns], ['表單關掉後就能繼續。', ['上一步(停用)', '下一步(停用)']], '有 AI 暫停時');
  await esc();
  await until(async () => { const q = await pop(); return q && !q.paused && q.meta.endsWith('2 / 4'); }, 5000, '有 AI：表單關掉回到第 2 步');
  p = await pop();
  assert.deepEqual([p.tip, p.btns], [TIP2, ['上一步', '下一步(停用)']], '關掉表單灰底恢復');
  await mouse('.tour-skipline [data-tour="skip"]'); // 已經有 AI 了，跳過這步
  p = await stepIs(3, '第 3 步');
  assert.equal(p.title, '先選你的 AI 用哪個工具');
  assert.match(p.text, /opencode 等其他工具選「其他」/, '說明 opencode 選其他');
  assert.equal(await js(`document.querySelector('#ai-list [data-ma="${N}"]')?.classList.contains('open')`), true, '展開的是最新那隻');
  assert.equal(await js(`document.querySelector('#ai-list [data-ma="${N}"] .ma-tabs [aria-selected="true"]')?.dataset.tab`), 'conn', '接入分頁');
  assert.ok(await covers(p.hole, `document.querySelector('#ai-list [data-ma="${N}"] .ma-tool').closest('.ma-f')`), '框「工具」那一列');
  assert.equal(await js(`document.querySelectorAll('#ai-list [data-ma="${N}"] .ma-tool [aria-pressed="true"]').length`), 0, '導覽不替人選工具');
  await key('ArrowRight');
  p = await stepIs(4, '第 4 步');
  assert.equal(p.title, '複製接入文字，貼給你的 AI');
  assert.equal(await js(`document.querySelector('#ai-list [data-ma="${N}"] .ma-btns .btn.primary').textContent`), '複製接入文字', '主要按鈕是「複製接入文字」');
  assert.equal(p.tip, '複製要你自己按；導覽不會碰你的 Token。');
  assert.deepEqual(p.btns, ['上一步', '完成']);
  assert.ok(await covers(p.hole, `document.querySelector('#ai-list [data-ma="${N}"] .ma-btns').closest('.ma-f')`), '框「複製」那一列');
  await js("document.querySelector('.tour-pop [data-tour=\"next\"]').click(); true");
  await until(noTour, 5000, '完成不留遮罩');
  await until(() => js("document.querySelector('.help-ch')?.dataset.helpCh === '1'"), 5000, '完成回到說明第 1 章');
  await until(() => js("document.activeElement?.matches('.help-head [data-tour-start=\"1\"]')"), 3000, '焦點回到入口');
  assert.equal(await snap(chen.token), before, '沒有送訊息、沒有改 AI、Token 沒動');
  assert.equal(await js("localStorage.getItem('aigile-ai-tools')"), null, '沒有記下任何工具');
  assert.equal(await js("document.querySelector('#toast').textContent"), '導覽結束。想再看一次，回說明第 1 章按「帶我在畫面上走一次」');

  // 4. Token 過期：第 4 步改框「重發 Token」，標題、灰底跟著換
  sql('UPDATE participants SET token_expires_at = ? WHERE id = ?', Date.now() - 60_000, N);
  assert.equal((await call(chen.token, `/api/my-ais/${N}`, 'PATCH', { duties: 'y' })).status, 200, '讓平台重讀成員表（直接改資料庫有快取）');
  await toHelp(chen.token, 1);
  await start(1);
  await stepIs(1, '過期 第 1 步'); await key('ArrowRight'); await stepIs(2, ''); await mouse('.tour-skipline [data-tour="skip"]'); await stepIs(3, ''); await key('ArrowRight');
  p = await stepIs(4, '過期 第 4 步');
  assert.deepEqual([p.title, p.text, p.tip], ['先重發 Token', '這隻 AI 的 Token 過期了，先按「重發 Token」，再複製接入文字貼給它。', '重發要你自己按；導覽不會碰你的 Token。'], 'Token 過期：' + JSON.stringify(p));
  assert.ok(await covers(p.hole, `document.querySelector('#ai-list [data-ma="${N}"] .ma-row [data-act="reissue"]')`), '框「重發 Token」');
  await esc();
  await until(noTour, 5000, 'Esc 結束');

  // 5. 新手上路「帶我走」：第 1、2 項有，按了直接開始那章；結束回總覽、焦點回「帶我走」；寬不到 1000 不顯示；走完不算完成
  const hub = async () => { await login(chen.token, '/'); await until(() => js("!!document.querySelector('.ob .ob-list')"), 15000, '新手上路'); await sleep(300); };
  await hub();
  const ob = await J("[...document.querySelectorAll('.ob-item')].map(li => [li.dataset.obStep, [...li.querySelectorAll('.btn, .ob-tour')].map(b => b.textContent), li.querySelector('.ob-tour')?.getClientRects().length > 0])");
  assert.deepEqual(ob, [['ai', ['到我的 AI ›', '帶我走'], true], ['walk', ['開始 ›', '帶我走'], true], ['todo', [], false]], '第 1、2 項加「帶我走」，原本的按鈕不變');
  await js("document.querySelector('[data-ob-step=\"walk\"] .ob-tour').click(); true");
  p = await stepIs(1, '帶我走 → 第 2 章', /^第 2 章/);
  assert.equal(p.meta, '第 2 章　跟著走一遍 · 1 / 4');
  await esc();
  await until(noTour, 5000, '結束');
  await until(() => js("location.pathname === '/'"), 5000, '回到總覽（從哪開始就回哪）');
  await until(() => js("document.activeElement?.matches('.ob .ob-tour[data-tour-start=\"2\"]')"), 3000, '焦點回到新手上路的「帶我走」');
  await until(() => js("!!document.querySelector('.ob .ob-list')"), 8000, '總覽畫好');
  await js("document.querySelector('[data-ob-step=\"ai\"] .ob-tour').click(); true");
  await stepIs(1, '帶我走 → 第 1 章');
  await esc(); await until(noTour, 5000, '結束');
  const st = (await call(chen.token, '/api/me')).body.onboard.steps;
  assert.deepEqual([st.ai, st.walk], [false, false], '走完導覽不算新手上路完成');
  await size(999); await hub();
  assert.equal(await js("[...document.querySelectorAll('.ob-tour')].filter(b => b.getClientRects().length).length"), 0, '寬 999 不顯示「帶我走」');
  await size(1280);
  console.log('tour-ai-ui-test：中文通過');

  // ================= 英文 =================
  sql('UPDATE participants SET token_expires_at = ? WHERE id = ?', Date.now() + 7 * 86400_000, N);
  await call(chen.token, `/api/my-ais/${N}`, 'PATCH', { duties: 'z' });
  await setLang('en');
  await hub();
  assert.deepEqual(await J("[...document.querySelectorAll('.ob-tour')].map(b => b.textContent)"), ['Show me', 'Show me'], '英文「帶我走」');
  await js("document.querySelector('[data-ob-step=\"ai\"] .ob-tour').click(); true");
  p = await stepIs(1, '英文第 1 步');
  assert.deepEqual([p.meta, p.title], ['Chapter 1: Bring your AI on board · 1 / 4', 'Your AIs live in My AIs'], '英文第 1 步：' + JSON.stringify(p));
  await key('ArrowRight');
  p = await stepIs(2, '英文第 2 步');
  assert.deepEqual([p.title, p.tip, p.btns], ['Click "+ Add AI" to create one', 'Click "+ Add AI" to start; if you already have an AI, use the link below to skip.', ['Back', 'Next(停用)']], '英文第 2 步');
  assert.equal(await js("document.querySelector('.tour-skipline [data-tour=\"skip\"]')?.textContent || ''"), 'I already have an AI, skip this step', '英文跳過連結');
  await mouse('#ai-new');
  await until(async () => { const q = await pop(); return q && !q.loading && q.meta === 'Chapter 1 · Step 2 › Form · 1 / 4'; }, 8000, '英文：表單 1/4');
  p = await pop();
  assert.deepEqual([p.title, p.tip], ['Pick a role template first', 'You can leave "Role display name" and "Avatar" as they are for now.'], '英文表單 1/4：' + JSON.stringify(p));
  assert.ok(!/[㐀-鿿]/.test(p.meta + p.title + p.text + p.tip), '英文表單小步沒有中文');
  await esc();
  await until(async () => { const q = await pop(); return q && !q.paused && q.meta.endsWith('2 / 4'); }, 5000, '英文：表單關掉');
  await mouse('.tour-skipline [data-tour="skip"]');
  p = await stepIs(3, '英文第 3 步');
  assert.equal(p.title, 'First pick the tool your AI uses');
  assert.match(p.text, /For opencode and other tools, pick "Other"/);
  await key('ArrowRight');
  p = await stepIs(4, '英文第 4 步');
  assert.deepEqual([p.title, p.tip, p.btns], ['Copy the onboarding text and paste it to your AI', 'You do the copying yourself; the tour never touches your token.', ['Back', 'Done']], '英文第 4 步');
  assert.ok(!/[㐀-鿿]/.test(p.meta + p.title + p.text + p.tip), '英文說明框沒有中文');
  await esc(); await until(noTour, 5000, '英文結束');
  assert.equal(await js("document.querySelector('#toast').textContent"), 'Tour finished. To see it again, go to Help chapter 1 and click "Show me on screen"');
  console.log('tour-ai-ui-test：全部通過');
} catch (e) {
  console.error('tour-ai-ui-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('tour-ai-ui-test.js')) || ''); process.exitCode = 1;
} finally { await kit.stop(); }
