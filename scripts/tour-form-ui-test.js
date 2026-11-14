// 聚光燈導覽第 1 章：新增 AI 表單裡分 4 小步帶（平台 PLAT-316／317／319 搬過來；開源版沒有「所在環境」）
// 表單一打開就進「第 1 章 · 第 2 步 › 表單 · N / 4」：角色範本 → 所屬專案 → 六題 → 取消＋建立 AI；小步 1 沒有上一步、小步 4「下一步」不能按；
// 換小步先捲到欄位再框，欄位捲出表單就藏亮塊；寬 ≥1240 說明框放表單旁邊（寬 288），放不下放上下；
// 取消／Esc 回主路線第 2 步；說明框 × 結束導覽、表單留著；縮到 1000 以下結束、表單留著；
// 建好後跳出的「已建立 AI」視窗也算表單：說明框只放說明、不加亮塊，關掉視窗後接第 3 步、展開剛建好那隻（用建立時拿到的 ID）；
// 建立被擋下（名稱重複、沒勾專案）：捲到出錯的欄位、游標放進去，錯誤字寫在那一欄底下；導覽停在 4/4。中文、英文介面都驗
// 本機暫存資料庫＋無頭 Chrome／Edge，不連任何站。用法：node scripts/tour-form-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('tour-form-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('tourF');
try {
  const { call, sql } = kit;
  const P = '預設專案';
  const join = async (name, role = 'PG') => (await call(null, '/api/join', 'POST', { name, role })).body;
  const lin = await join('林志明', 'PO');
  const chen = await join('陳大文'), C = chen.participant.participantId;
  await call(lin.token, `/api/participants/${C}/projects`, 'PUT', { projects: [P] });
  const mk = async (t, name) => (await call(t, '/api/my-ais', 'POST', { projects: [P], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  await mk(lin.token, '林的助手'); // 別人的 AI：名稱拿來撞
  const myAis = async () => (await call(chen.token, '/api/my-ais')).body.items;

  const { js, login, cdp, key, goto } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h = 900) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await size(1280);
  const setLang = async l => { await goto('/', '首頁'); await js(`localStorage.setItem('aigile-lang', '${l}'); true`); };
  const toHelp = async ch => { await login(chen.token, `/help/${ch}`); await until(() => js(`document.querySelector('.help-ch')?.dataset.helpCh === '${ch}'`), 30000, `說明第 ${ch} 章`); };
  const pop = () => J(`(() => { const p = document.querySelector('.tour-pop'); if (!p) return null; const hh = document.querySelector('.tour-hole'), h = hh.getBoundingClientRect(), pr = p.getBoundingClientRect();
    return { meta: p.querySelector('.tour-meta')?.textContent || '', title: p.querySelector('.tour-title')?.textContent || '', text: p.querySelector('.tour-text')?.textContent || '', tip: p.querySelector('.tour-tip')?.textContent || '',
      btns: [...p.querySelectorAll('.tour-foot .btn')].map(b => b.textContent + (b.disabled ? '(停用)' : '')), dots: p.querySelectorAll('.tour-dots i').length,
      loading: p.classList.contains('loading'), holeShown: getComputedStyle(hh).display !== 'none' && getComputedStyle(hh).visibility !== 'hidden',
      side: ['top', 'bottom', 'left', 'right', 'center'].find(s => p.classList.contains('at-' + s)) || '', box: { l: pr.left, r: pr.right, w: pr.width },
      hole: { l: h.left, t: h.top, r: h.right, b: h.bottom } }; })()`);
  const covers = (h, sel) => J(`(() => { const es = [].concat(${sel}).filter(Boolean); if (!es.length) return false; const h = ${JSON.stringify(h)};
    return es.every(e => { const b = e.getBoundingClientRect(); return b.right > b.left && b.left >= h.l - 8 && b.top >= h.t - 8 && b.right <= h.r + 8 && b.bottom <= h.b + 8; }); })()`);
  const metaIs = async (m, label) => { await until(async () => { const p = await pop(); return p && !p.loading && p.meta === m; }, 8000, label); await sleep(350); return pop(); };
  const sub = (n, label) => metaIs(`第 1 章 · 第 2 步 › 表單 · ${n} / 4`, label);
  const step = (n, label) => metaIs(`第 1 章　讓你的 AI 加入 · ${n} / 4`, label);
  const mouse = async sel => { const r = await J(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }); };
  const popInView = () => js("(() => { const r = document.querySelector('.tour-pop').getBoundingClientRect(), d = document.documentElement; return r.left >= 0 && r.top >= 0 && r.right <= d.clientWidth && r.bottom <= d.clientHeight; })()");
  const esc = async () => { for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); };
  const noTour = () => js("!document.querySelector('.tour-pop') && !document.querySelector('.tour-hole')");
  const formOpen = () => js("!!document.querySelector('#modal-root #ai-form[data-new]')");
  const F = sel => `document.querySelector('#modal-root #ai-form ${sel}')`;
  const err = () => J(`(() => { const e = document.querySelector('#modal-root .field-err'); if (!e) return null; const b = e.getBoundingClientRect(), c = document.querySelector('#modal-root .modal-body').getBoundingClientRect();
    const a = document.activeElement; return { text: e.textContent, seen: b.top >= c.top && b.bottom <= c.bottom && b.height > 0, focus: a?.name || '' }; })()`);
  const startTo2 = async () => {
    await js("document.querySelector('[data-tour-start=\"1\"]').click(); true");
    await step(1, '第 1 步'); await mouse('.tour-foot [data-tour="next"]');
    return step(2, '第 2 步');
  };
  const nextTo = async n => { for (let k = 2; k <= n; k++) { await mouse('.tour-foot [data-tour="next"]'); await sub(k, `表單 ${k}/4`); } };

  await setLang('zh');
  // 1. 還沒有 AI：第 2 步自己按「＋ 新增 AI」→ 表單 1/4 → 一路到 4/4
  await toHelp(1);
  await startTo2();
  await mouse('#ai-new');
  let p = await sub(1, '表單 1/4');
  assert.deepEqual([p.title, p.tip, p.btns, p.dots], ['先選角色範本', '「角色顯示名稱」和「頭像」可以先不改。', ['下一步'], 4], '表單 1/4');
  assert.ok(await covers(p.hole, `${F('select[name="roleKey"]')}.closest('label')`), '框「角色範本」');
  assert.equal(p.box.w, 288, '說明框寬 288');
  assert.ok(['left', 'right'].includes(p.side) && await popInView(), '寬 1280：說明框放表單旁邊、在畫面內：' + p.side);
  await mouse('.tour-foot [data-tour="next"]');
  p = await sub(2, '表單 2/4');
  assert.equal(p.text, '至少勾一個。AI 只會在勾了的專案裡收訊息、做事。');
  assert.ok(await covers(p.hole, `${F('.new-ai-proj')}.closest('.field')`), '框「所屬專案」');
  await mouse('.tour-foot [data-tour="next"]');
  p = await sub(3, '表單 3/4');
  assert.equal(p.title, '六題是 AI 的工作守則', '開源版沒有所在環境：第 3 小步就是六題');
  assert.ok(await covers(p.hole, `[${F('.group-title')}.parentElement, ${F('input[name="name"]')}.closest('label'), ${F('textarea')}.closest('label')]`), '框六題標題到第 2 題');
  await mouse('.tour-foot [data-tour="next"]');
  p = await sub(4, '表單 4/4');
  assert.deepEqual([p.title, p.btns], ['確認後按「建立 AI」', ['上一步', '下一步(停用)']], '表單 4/4');
  assert.ok(await covers(p.hole, "[...document.querySelectorAll('#modal-root .modal-foot .btn')]"), '框「取消」＋「建立 AI」');
  // 真滑鼠上一步 4 → 1
  for (let n = 3; n >= 1; n--) { await mouse('.tour-foot [data-tour="prev"]'); await sub(n, `上一步回 ${n}/4`); await sleep(800); assert.equal((await pop()).meta, `第 1 章 · 第 2 步 › 表單 · ${n} / 4`, `停在 ${n}/4`); }
  // 捲走藏亮塊
  await js("document.querySelector('#modal-root .modal-body').scrollTop = 99999; true"); await sleep(500);
  assert.equal((await pop()).holeShown, false, '欄位捲出表單：亮塊藏起來');
  // Esc 交給表單：回第 2 步、沒建 AI
  await esc();
  p = await step(2, 'Esc 回第 2 步');
  assert.equal(await formOpen(), false, 'Esc 關的是表單');
  assert.equal((await myAis()).length, 0, '沒有建立');
  // 說明框 ×：導覽結束、表單留著
  await mouse('#ai-new'); await sub(1, '再開表單');
  await mouse('.tour-pop .tour-x');
  await until(noTour, 5000, '× 結束');
  assert.ok(await formOpen(), '表單留著');
  await esc(); await until(async () => !(await formOpen()), 3000, '自己關表單');

  // 2. 被擋下：名稱重複、沒勾專案 → 捲到那一欄、游標放進去；導覽停在 4/4
  await toHelp(1); await startTo2(); await mouse('#ai-new'); await sub(1, '擋下：表單 1/4'); await nextTo(4);
  await js(`${F('input[name="name"]')}.value = '林的助手'; true`);
  await mouse('#modal-root .modal-foot button[type="submit"]');
  await until(async () => !!(await err()), 5000, '名稱重複：欄位錯誤');
  let e = await err();
  assert.ok(e.seen && e.focus === 'name' && e.text === '名稱「林的助手」已被使用', '名稱重複捲到名稱欄：' + JSON.stringify(e));
  assert.equal((await pop()).meta, '第 1 章 · 第 2 步 › 表單 · 4 / 4', '導覽停在 4/4');
  await js(`${F('input[name="name"]')}.value = '陳的新助手'; document.querySelectorAll('#modal-root #ai-form input[name="proj"]').forEach(c => { c.checked = false; }); true`);
  await mouse('#modal-root .modal-foot button[type="submit"]');
  await until(async () => (await err())?.text === '請至少選一個所屬專案', 5000, '沒勾專案：欄位錯誤');
  e = await err();
  assert.ok(e.seen && e.focus === 'proj', '沒勾專案：捲到所屬專案、游標在勾選框');
  assert.equal((await myAis()).length, 0, '都沒有建立');
  await mouse('.tour-pop .tour-x'); await esc();

  // 3. 建好：「已建立 AI」視窗也算表單（只放說明、不加亮塊）；關掉後接第 3 步，展開剛建好那隻（先放一隻加入時間在未來的誘餌，照「最新」猜會猜錯）
  const decoy = (await mk(chen.token, '誘餌助手')).participantId;
  sql('UPDATE participants SET created_at = ? WHERE id = ?', '2099-01-01T00:00:00.000Z', decoy);
  assert.equal((await call(chen.token, `/api/my-ais/${decoy}`, 'PATCH', { duties: 'y' })).status, 200, '讓平台重讀成員表');
  await toHelp(1);
  p = await startTo2();
  assert.deepEqual(p.btns, ['上一步', '下一步(停用)'], '有 AI：下一步也停用（平台 PLAT-319）');
  await mouse('#ai-new'); await sub(1, '建立：表單 1/4'); await nextTo(4);
  const beforeIds = (await myAis()).map(a => a.participantId);
  await mouse('#modal-root .modal-foot button[type="submit"]');
  await until(() => js("!!document.querySelector('#modal-root .modal[data-tour-created]')"), 8000, '跳出「已建立 AI」視窗');
  await until(async () => (await pop())?.text === 'AI 建好了。先關掉這個視窗，導覽接著帶你看怎麼接上它。', 8000, '視窗上的說明');
  p = await pop();
  assert.equal(p.holeShown, false, '「已建立 AI」視窗：不加亮塊');
  assert.equal(p.meta, '第 1 章 · 第 2 步 › 表單 · 4 / 4');
  assert.deepEqual(p.btns, ['下一步(停用)'], '視窗開著：要先關掉才往下');
  assert.ok(await popInView(), '說明框在畫面內');
  const created = (await myAis()).map(a => a.participantId).filter(id => !beforeIds.includes(id));
  assert.equal(created.length, 1, '建了一隻');
  await mouse('#modal-root .modal-x');
  p = await step(3, '關掉視窗接第 3 步');
  assert.equal(await js(`document.querySelector('#ai-list [data-ma="${created[0]}"]')?.classList.contains('open')`), true, '展開的是剛建好的那隻');
  assert.equal(await js(`document.querySelector('#ai-list [data-ma="${decoy}"]')?.classList.contains('open') || false`), false, '不是照加入時間猜的那隻');
  assert.ok(await covers(p.hole, `document.querySelector('#ai-list [data-ma="${created[0]}"] .ma-tool').closest('.ma-f')`), '框剛建好那隻的「工具」列');
  await esc(); await until(noTour, 5000, '結束');

  // 4. 縮到 1000 以下：結束、表單留著
  await toHelp(1); await startTo2(); await mouse('.tour-skipline [data-tour="skip"]'); await step(3, '跳過連結到第 3 步');
  await mouse('.tour-foot [data-tour="prev"]'); await step(2, '回第 2 步');
  await mouse('#ai-new'); await sub(1, '縮窄前');
  await size(999); await until(noTour, 5000, '縮窄結束');
  assert.ok(await formOpen(), '縮窄：表單留著');
  await esc(); await size(1280);
  console.log('tour-form-ui-test：中文通過');

  // 5. 英文：寬 1100 放上下；小步、視窗說明都是英文
  await setLang('en');
  await size(1100);
  await toHelp(1);
  await js("document.querySelector('[data-tour-start=\"1\"]').click(); true");
  await metaIs('Chapter 1: Bring your AI on board · 1 / 4', '英文第 1 步'); await mouse('.tour-foot [data-tour="next"]');
  await metaIs('Chapter 1: Bring your AI on board · 2 / 4', '英文第 2 步');
  await mouse('#ai-new');
  p = await metaIs('Chapter 1 · Step 2 › Form · 1 / 4', '英文表單 1/4');
  assert.ok(['top', 'bottom'].includes(p.side), '寬 1100：說明框放上下：' + p.side);
  assert.equal(p.title, 'Pick a role template first');
  for (const [n, t] of [[2, 'Tick the projects it should join'], [3, "The six questions are the AI's working rules"], [4, 'When you\'re ready, click "Create AI"']]) {
    await mouse('.tour-foot [data-tour="next"]');
    p = await metaIs(`Chapter 1 · Step 2 › Form · ${n} / 4`, `英文表單 ${n}/4`);
    assert.equal(p.title, t);
    assert.ok(!/[㐀-鿿]/.test(p.meta + p.title + p.text + p.tip + p.btns.join('').replace(/(停用)/g, '')), `英文表單 ${n}/4 沒有中文：` + JSON.stringify(p));
  }
  await js(`${F('input[name="name"]')}.value = 'chen-new-ai'; true`);
  await mouse('#modal-root .modal-foot button[type="submit"]');
  await until(async () => (await pop())?.text === 'Your AI is created. Close this window first, and the tour will show you how to connect it.', 8000, '英文：視窗說明');
  console.log('tour-form-ui-test：全部通過');
} catch (e) {
  console.error('tour-form-ui-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('tour-form-ui-test.js')) || ''); process.exitCode = 1;
} finally { await kit.stop(); }
