// 畫面測試：訊息顯示改版（現有「精簡／完整」照定案圖改）
// A. 共用：（頂端「等你回」橫條已拿掉）上次看到的地方畫「以下是新訊息」；時間只寫時分＋換日分隔；
//    收件人併進標頭（📣 全體、→ 你）、沒有角色那行；需確認選項只在按鈕區；卡片串內文不重寫卡號
// B. 精簡：連續 AI 簽到收一行；卡片串只露最新一則，前面收成「▸ 前面 N 則：…」，點開看全部、可再收起
// C. 完整：卡片串全部顯示；接單、簽到變細行
// D. 精簡／完整切換照舊記在裝置；流程訊息照舊收一行灰字
// E. 英文介面（aigile-lang=en）：紅線、換日、收件人、AI 上線那一行、卡片串收起都是英文
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 MSG_VIEW_SHOTS=資料夾 會另外截圖（精簡／完整 × 電腦／手機 × 淺色／深色）
// 用法：node scripts/message-view-ui-test.js（找不到瀏覽器就略過）
import './test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('message-view-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const PJ = '預設專案';
const kit = await startKit('msgview');
try {
  const { call } = kit;
  const lin = (await call(null, '/api/join', 'POST', { name: '林小安', role: 'PO' })).body;
  const LIN = lin.participant.participantId;
  const mk = async (name, roleKey) => { const a = (await call(lin.token, '/api/my-ais', 'POST', { projects: [PJ], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; assert.ok(a.participantId, JSON.stringify(a)); return { id: a.participantId, t: kit.aiToken(a.participantId) }; };
  const pg = await mk('小安的程式開發助手', 'PG'), po = await mk('claude-PO', 'PO'), ux = await mk('UX', 'UX');
  let n = 0;
  const post = async (t, body) => { const r = await call(t, '/api/messages', 'POST', { project: PJ, requestId: 'mv_' + n++, ...body }); assert.ok(r.status < 300, JSON.stringify(r.body)); return r.body; };
  for (const [a, r] of [[pg, 'PG'], [po, 'PO'], [ux, 'UX']]) await post(a.t, { text: `[AI 簽到] 我是林小安的助手，角色為 ${r}。已成功連線，目前可接受指定任務。` });
  await post(lin.token, { text: '大家好，這週目標是把技能同步做完，再整體驗收一次畫面。', audience: 'all' });
  const c1 = (await call(lin.token, '/api/cards', 'POST', { requestId: 'c1', project: PJ, title: '登入頁手機版跑版', ownerId: po.id, status: '待處理' })).body;
  assert.ok(c1.cardId, JSON.stringify(c1));
  const ho = await call(po.t, `/api/cards/${c1.cardId}/handover`, 'POST', { toId: pg.id, progress: '登入頁手機版跑版', nextStep: '請程式開發助手處理' });
  assert.equal(ho.status, 200, JSON.stringify(ho.body));
  const take = await post(pg.t, { text: `[接單] ${c1.cardId} 收到，先重現再修。`, cardId: c1.cardId, replyFrom: [] });
  const prog = await post(pg.t, { text: `[進度] ${c1.cardId} 已修好，等驗收。`, cardId: c1.cardId, replyFrom: [] });
  const ask = await post(pg.t, { text: '[需確認] 搜尋框要不要支援模糊比對？\n\n問題1：要不要做模糊比對？\nA. 要，打錯一個字也找得到\nB. 不要，維持完全比對\n\n問題2：結果要不要高亮？\nA. 要\nB. 不要', recipientIds: [LIN], replyFrom: [LIN] });
  await post(ux.t, { text: '[完成] 上傳技能視窗改版驗收通過；桌機、手機、淺色、深色都看過。', replyFrom: [] });
  const seqOf = async id => (await call(lin.token, '/api/messages?limit=50')).body.items.find(m => m.messageId === id)?.sequence;
  const takeSeq = await seqOf(take.messageId);
  assert.ok(takeSeq > 1, '拿得到接單那則的序號');

  const { js, goto, cdp } = await kit.browser(1280, 1000);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const open = async (view, { w = 1280, seen = takeSeq - 1, theme = 'light', lang = 'zh' } = {}) => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: w < 700 ? 1100 : 1000, deviceScaleFactor: 1, mobile: w < 700 });
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
    // 在同源的靜態 JSON 頁設定上次讀到的位置，避免上一個訊息頁捲動時又把它推到最新。
    await goto('/api/health');
    await js(`localStorage.setItem('aigile-switch-token', ${JSON.stringify(lin.token)});
      localStorage.setItem('aigile-lang', '${lang}');
      localStorage.setItem('aigile-switch-view', '${view}');
      ${seen ? `localStorage.setItem('aigile-seen:${PJ}', '${seen}')` : `localStorage.removeItem('aigile-seen:${PJ}')`}; true`);
    await goto('/p/main/messages');
    await until(() => js("!!document.querySelector('.av-btn') && document.querySelectorAll('#messages .msg, #messages .flow-line').length > 3"), 20000, `訊息（${view}、${lang}）`);
    await sleep(300);
  };
  const grpOf = `[...document.querySelectorAll('#messages .cgrp')].find(g => g.querySelector('#msg-${prog.messageId}'))`;

  // ---------- 完整（電腦） ----------
  await open('full');
  // A 頂端「等你回」橫條拿掉了，改成「給我的」上的數字（見 ask-for-me-ui-test）
  assert.equal(await js("!!document.querySelector('#ask-bar')"), false, '沒有黃色橫條');
  // A 上次看到的地方
  const seenLine = await J(`(() => { const l = document.querySelector('#seen-line'); return l ? { text: l.innerText.trim(), next: l.nextElementSibling?.id || '' } : null; })()`);
  assert.ok(seenLine, '有「以下是新訊息」'); assert.equal(seenLine.text, '以下是新訊息');
  assert.equal(seenLine.next, 'msg-' + take.messageId, '紅線畫在上次看到之後的第一則前面');
  // A 時間只寫時分、換日分隔
  const times = await J(`[...document.querySelectorAll('#messages .msg-time')].map(t => t.textContent.trim())`);
  assert.ok(times.length >= 5 && times.every(t => /^\d{2}:\d{2}$/.test(t)), '時間只寫時分：' + times.join(','));
  assert.match(await js("document.querySelector('#messages .day-div')?.innerText || ''"), /^今天 \d+\/\d+$/, '換日分隔寫「今天 M/D」');
  // A 收件人併進標頭、沒有角色那行
  assert.equal(await js("document.querySelectorAll('#messages .msg-line2, #messages .recipients').length"), 0, '沒有角色那行、沒有另一行收件人');
  assert.match(await js("[...document.querySelectorAll('#messages .msg-line1 .to-all')].map(x => x.textContent).join()"), /📣 全體/, '全體通知寫在標頭');
  const askHead = await js(`document.querySelector('#msg-${ask.messageId} .msg-line1')?.innerText || ''`);
  assert.match(askHead, /→ 你/, '給你的寫在標頭'); assert.doesNotMatch(askHead, /要你回覆/, '標頭不重複「要你回覆」');
  // A 需確認：選項只在按鈕區
  const askMsg = await J(`(() => { const el = document.getElementById('msg-${ask.messageId}'); return { text: el.querySelector('.msg-text').innerText, btns: [...el.querySelectorAll('.q-opt')].map(b => b.innerText) }; })()`);
  assert.ok(askMsg.btns.some(b => /打錯一個字也找得到/.test(b)), '按鈕區有選項');
  assert.doesNotMatch(askMsg.text, /打錯一個字也找得到|維持完全比對|問題1/, '內文不重複選項');
  assert.match(askMsg.text, /搜尋框要不要支援模糊比對/, '結論還在');
  // A 卡片串內文不重寫卡號；C 全部顯示、接單變細行
  const grp = await J(`(() => { const s = ${grpOf}; return { n: s.querySelectorAll('article.msg').length, more: !!s.querySelector('.cg-more'), take: !!s.querySelector('#msg-${take.messageId}.thin'), prog: s.querySelector('#msg-${prog.messageId} .msg-text').innerText, takeText: s.querySelector('#msg-${take.messageId}').innerText, head: s.querySelector('.cg-head').innerText }; })()`);
  assert.equal(grp.more, false, '完整：卡片串全部顯示，沒有「前面 N 則」');
  assert.ok(grp.n >= 3, '完整：卡片串的每則都在');
  assert.ok(grp.take, '完整：接單是細行');
  assert.doesNotMatch(grp.prog, new RegExp(c1.cardId), '卡片串內文不重寫卡號'); assert.match(grp.prog, /已修好，等驗收/);
  assert.doesNotMatch(grp.takeText, new RegExp(c1.cardId), '細行也不重寫卡號');
  assert.match(grp.head, /\d+ 則 · \d{2}:\d{2}/, '卡片串標頭有則數與最後時間');
  // C 簽到變細行（每則一條）
  assert.equal(await js("document.querySelectorAll('#messages > .msg.thin').length"), 3, '完整：三則簽到各一條細行');
  assert.equal(await js("document.querySelectorAll('#messages .ci-line').length"), 0);
  // 「回覆」滑過才出現（有滑鼠時）
  assert.ok(await js("[...document.styleSheets].some(s => { try { return [...s.cssRules].some(r => r.conditionText === '(hover: hover)' && /reply-btn/.test(r.cssText)); } catch { return false; } })"), '有滑鼠的裝置「回覆」滑過才出現');

  // ---------- 精簡（電腦） ----------
  await open('slim');
  assert.ok(await js("document.querySelector('#messages').classList.contains('slim-view')"), '精簡：訊息區標成精簡');
  const ci = await J(`[...document.querySelectorAll('#messages .ci-line')].map(x => x.innerText)`);
  assert.equal(ci.length, 1, '精簡：連續簽到收成一行'); assert.match(ci[0], /3 個 AI 上線：小安的程式開發助手、claude-PO、UX/);
  const sgrp = await J(`(() => { const s = ${grpOf}; return { n: s.querySelectorAll('article.msg').length, more: s.querySelector('.cg-more')?.innerText || '' }; })()`);
  assert.equal(sgrp.n, 1, '精簡：卡片串只露最新一則');
  assert.match(sgrp.more, /^▸ 前面 \d+ 則：.*claude-PO 交接/, '前面收成「▸ 前面 N 則：誰 標籤」');
  await js(`${grpOf}.querySelector('.cg-more').click(); true`);
  await until(() => js(`${grpOf}.querySelectorAll('article.msg').length > 2`), 5000, '點開看全部');
  await js(`document.querySelector('[data-grp-close]').click(); true`);
  await until(() => js(`${grpOf}.querySelectorAll('article.msg').length === 1`), 5000, '可以再收起');
  await js("document.querySelector('#messages .ci-line').click(); true");
  await until(() => js("document.querySelectorAll('#messages .ci-line').length === 0"), 5000, '點 AI 上線那一行逐則展開');
  // D 切換照舊記在裝置
  await js("document.querySelector('[data-msg-view=\"full\"]').click(); true");
  await until(() => js("localStorage.getItem('aigile-switch-view') === 'full' && !document.querySelector('#messages').classList.contains('slim-view')"), 5000, '切到完整並記住');

  // ---------- E 英文介面 ----------
  const HAN = /[㐀-鿿]/;
  await open('slim', { lang: 'en' });
  await until(() => js("document.documentElement.lang === 'en' && /^Today /.test(document.querySelector('#messages .day-div')?.innerText || '')"), 15000, '英文介面');
  await until(() => js("/New messages below/.test(document.querySelector('#seen-line')?.innerText || '')"), 15000, '英文紅線');
  const en = await J(`(() => { const t = s => document.querySelector(s)?.innerText.trim() || ''; return { seen: t('#seen-line'), day: t('#messages .day-div'), ci: t('#messages .ci-line'), ciB: t('#messages .ci-line b'), all: t('#messages .to-all'), more: t('#messages .cg-more'), meta: t('#messages .cg-meta') }; })()`);
  assert.equal(en.seen, 'New messages below', '英文：紅線');
  assert.match(en.day, /^Today \d+\/\d+$/, '英文：換日分隔：' + en.day);
  assert.equal(en.ciB, '3 AIs online', '英文：AI 上線那一行：' + en.ci);
  assert.match(en.ci, /^🤖\s*3 AIs online: 小安的程式開發助手, claude-PO, UX \d{2}:\d{2}$/, '英文：AI 上線那一行除了名字都是英文：' + en.ci);
  assert.equal(en.all, '📣 Everyone', '英文：全體通知寫在標頭');
  assert.match(en.more, /^▸ \d+ earlier messages?: .*claude-PO Handover/i, '英文：卡片串收起：' + en.more);
  assert.match(en.meta, /^\d+ messages · \d{2}:\d{2} ›$/, '英文：卡片串標頭：' + en.meta);
  for (const [k, v] of Object.entries({ seen: en.seen, day: en.day, ciB: en.ciB, all: en.all, meta: en.meta })) assert.ok(!HAN.test(v), `英文：${k} 沒有中文：${v}`);
  // 完整：收件人「→ you」
  await open('full', { lang: 'en' });
  await until(() => js(`/→ you/.test(document.querySelector('#msg-${ask.messageId} .msg-line1')?.innerText || '')`), 8000, '英文：給你的寫「→ you」');
  assert.equal(await js("document.querySelector('#seen-line')?.innerText.trim()"), 'New messages below', '英文：完整也有紅線');

  // 沒記過上次看到的就沒有紅線
  await call(lin.token, '/api/messages', 'POST', { project: PJ, requestId: 'mv_ans', text: 'A、A', replyToMessageId: ask.messageId });
  await open('full', { seen: 0 });
  assert.equal(await js("!!document.querySelector('#seen-line')"), false, '第一次看沒有紅線');

  // 手機也看一次（精簡、深色）
  await open('slim', { w: 390, theme: 'dark' });
  assert.equal(await js("document.querySelectorAll('#messages .ci-line').length"), 1, '手機精簡：簽到一行');
  assert.ok(await js("document.querySelector('#messages').scrollWidth <= document.querySelector('#messages').clientWidth + 1"), '手機不橫向捲動');

  if (process.env.MSG_VIEW_SHOTS) {
    const dir = process.env.MSG_VIEW_SHOTS; fs.mkdirSync(dir, { recursive: true });
    for (const [name, view, w, theme, lang] of [['slim-pc', 'slim', 1280, 'light', 'zh'], ['full-pc', 'full', 1280, 'light', 'zh'], ['slim-phone', 'slim', 390, 'light', 'zh'], ['full-phone', 'full', 390, 'light', 'zh'], ['full-pc-dark', 'full', 1280, 'dark', 'zh'], ['slim-pc-en', 'slim', 1280, 'light', 'en']]) {
      await open(view, { w, seen: takeSeq - 1, theme, lang });
      await js("document.querySelector('#messages').scrollTop = 0; true"); await sleep(300);
      fs.writeFileSync(path.join(dir, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));
    }
  }
  console.log('message-view-ui-test：全部通過');
} catch (e) {
  console.error('message-view-ui-test 失敗：', e.message); process.exitCode = 1;
} finally { await kit.stop(); }
