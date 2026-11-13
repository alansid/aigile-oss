// 驗收測試：收件匣「要你回覆」的預覽：收合 2 行；點預覽就地展開全文（保留換行）、再點收合；
// 「到訊息回覆」「不用回」位置不動；頁面重畫（新訊息進來）後還開著；手機 375 一樣、不橫向捲動
// 修正前：預覽在 80 字切掉加「…」，點了沒反應，要到訊息頁才看得到全文
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。用法：node scripts/ask-preview-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('ask-preview-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('askpv');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body, L = boss.participant.participantId;
  const ai = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const long = '[完成] CARD-999 做完了，請看一下這幾點再決定要不要合：\n' + Array.from({ length: 8 }, (_, i) => `${i + 1}. 第 ${i + 1} 點說明，這一行故意寫長一點，讓收合時一定超過兩行。`).join('\n') + '\n最後一句 END-MARK';
  assert.equal((await kit.call(ai.token, '/api/messages', 'POST', { requestId: 'a1', project: '預設專案', text: long, recipientIds: [L], replyFrom: [L] })).status, 201);
  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const pv = '[data-ask-pv]', LONG = "[...document.querySelectorAll('[data-ask-pv]')].find(e => e.textContent.includes('END-MARK'))";
  const look = () => J(`(() => { const b = [...document.querySelectorAll('${pv}')].find(e => e.textContent.includes('END-MARK')), t = b.querySelector('.ask-pv-t'), row = b.closest('.sugg-row'), lh = parseFloat(getComputedStyle(t).lineHeight);
    const pos = s => { const r = row.querySelector(s).getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top)]; };
    return { open: b.getAttribute('aria-expanded') === 'true', text: t.textContent, h: t.getBoundingClientRect().height, lh, clamped: t.scrollHeight > t.clientHeight + 1,
      goto: pos('[data-note-goto]'), ack: pos('[data-note-ack]'), hscroll: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);

  for (const w of [1280, 375]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: w < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: w < 600 });
    await login(boss.token, '/p/main/inbox');
    await until(() => js(`!!document.querySelector('${pv}')`), 15000, '要你回覆');
    await sleep(300);
    // 收合：2 行、有截斷、不含換行
    const a = await look();
    assert.ok(!a.open && a.clamped && a.h <= a.lh * 2 + 2, `${w}：收合 2 行：` + JSON.stringify({ h: a.h, lh: a.lh, clamped: a.clamped }));
    assert.ok(a.text.startsWith('[完成] CARD-999 做完了') && !a.text.includes('\n'), `${w}：收合時換行併成一行`);
    const more = await J(`(() => { const e = ${LONG}.querySelector('.ask-more'); return [getComputedStyle(e).display, e.textContent]; })()`);
    assert.deepEqual(more, ['block', '… 展開'], `${w}：超過 2 行時尾端看得到「… 展開」`);
    // 點一下：就地展開全文、保留換行；按鈕位置不動
    await js(`${LONG}.click(); true`);
    await until(() => js(`${LONG}.getAttribute('aria-expanded') === 'true' && ${LONG}.textContent.includes('\\n')`), 5000, '展開全文');
    const b = await look();
    assert.ok(b.text.includes('\n8. 第 8 點說明') && !b.clamped && b.h > a.h * 2, `${w}：展開全文、保留換行：` + b.h);
    // 桌機按鈕在右邊、完全不動；手機按鈕在文字下面，展開只會跟著往下，左右不變
    if (w > 600) assert.deepEqual([b.goto, b.ack], [a.goto, a.ack], `${w}：「到訊息回覆」「不用回」位置不動`);
    else assert.deepEqual([b.goto[0], b.ack[0]], [a.goto[0], a.ack[0]], `${w}：按鈕左右不變`);
    assert.ok(!b.hscroll, `${w}：沒有橫向捲動`);
    // 新訊息進來、頁面重畫：開著的還開著
    assert.equal((await kit.call(ai.token, '/api/messages', 'POST', { requestId: 'b' + w, project: '預設專案', text: `第二個問題 ${w}`, recipientIds: [L], replyFrom: [L] })).status, 201);
    await until(() => js(`[...document.querySelectorAll('${pv}')].some(e => e.textContent.includes('第二個問題 ${w}'))`), 15000, '新訊息進來');
    const open = await J(`[...document.querySelectorAll('${pv}')].map(e => [e.textContent.includes('END-MARK'), e.getAttribute('aria-expanded')])`);
    assert.ok(open.some(([m, x]) => m && x === 'true'), `${w}：重畫後原本那則還開著：` + JSON.stringify(open));
    // 再點收合
    await js(`[...document.querySelectorAll('${pv}')].find(e => e.textContent.includes('END-MARK')).click(); true`);
    await until(() => js(`[...document.querySelectorAll('${pv}')].every(e => e.getAttribute('aria-expanded') === 'false')`), 5000, '收合');
    const c = await look();
    assert.ok(c.clamped && c.h <= c.lh * 2 + 2, `${w}：再點收合回 2 行`);
  }
  console.log('ask-preview-ui-test：全部通過');
} catch (e) {
  console.error('ask-preview-ui-test 失敗：', e.message); process.exitCode = 1;
} finally { await kit.stop(); }
