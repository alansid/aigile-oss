// 「要你處理」頁「要你回覆」：每則前面有勾選框、上方「全選」與「不用回（N）」（跟單則一致）；沒勾時按鈕不能按；標題列也能勾
// 按下先跳確認：只清你的清單、不會回覆提問的人、不會叫醒 AI、還在等你的 AI 會繼續等；取消就不動
// 確定後只 ack 自己的通知：不產生任何訊息或通知，別人的清單不受影響；清單與計數跟著更新；手機 375 一樣能用、不橫向捲動
// 修正前：要一則一則按「不用回」
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。用法：node scripts/batch-done-ui-test.js（找不到瀏覽器就略過）
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('batch-done-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('batchdone');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body, L = boss.participant.participantId;
  const ux = (await kit.call(null, '/api/join', 'POST', { name: '王小美', role: 'UX' })).body, U = ux.participant.participantId;
  await kit.call(boss.token, `/api/participants/${U}/projects`, 'PUT', { projects: ['預設專案'] });
  const ai = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const post = (n, to) => kit.call(ai.token, '/api/messages', 'POST', { requestId: 'p346-' + n, project: '預設專案', text: `[完成] 第 ${n} 則做好了，請看一下 MARK${n}`, recipientIds: [to], replyFrom: [to] });
  for (const n of [1, 2, 3]) assert.equal((await post(n, L)).status, 201, '給使用者 ' + n);
  assert.equal((await post(9, U)).status, 201, '給別人一則（不能被清掉）');
  const count = async () => ({ msgs: (kit.get('SELECT COUNT(*) AS n FROM messages')).n, notes: (kit.get('SELECT COUNT(*) AS n FROM notifications')).n,
    liuPending: (kit.get("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND status = 'pending'", L)).n,
    uxPending: (kit.get("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND status = 'pending'", U)).n });
  const before = await count();
  assert.ok(before.liuPending >= 3 && before.uxPending >= 1, '一開始的待處理：' + JSON.stringify(before));

  const { js, login, cdp } = await kit.browser(1280, 900);
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const st = () => J(`(() => { const btn = document.querySelector('[data-ask-done]'), rows = [...document.querySelectorAll('.ask-row-item')];
    return { rows: rows.length, checks: document.querySelectorAll('[data-ask-check]').length, all: !!document.querySelector('[data-ask-all]'), btn: btn ? { off: btn.disabled, t: btn.textContent.trim() } : null,
      marks: rows.map(r => (r.textContent.match(/MARK\\d/) || [''])[0]), hscroll: document.documentElement.scrollWidth > innerWidth + 1 }; })()`);
  const clickChk = sel => js(`(() => { const e = document.querySelector('${sel}'); e.click(); return true; })()`);

  for (const w of [375, 1280]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: w < 600 ? 812 : 900, deviceScaleFactor: 1, mobile: w < 600 });
    await login(boss.token, '/p/main/inbox');
    await until(() => js(`!document.querySelector('#app').hidden && document.querySelectorAll('.ask-row-item').length === 3`), 15000, `${w}：要你回覆 3 則`);
    await sleep(200);
    // A. 每則一個勾選框、全選、沒勾時按鈕不能按
    let s = await st();
    assert.ok(s.checks === 3 && s.all && s.btn && s.btn.off && s.btn.t === '不用回（0）', `${w}：勾選框、全選、按鈕停用：` + JSON.stringify(s));
    assert.ok(!s.marks.includes('MARK9'), `${w}：別人的不在我的清單`);
    assert.ok(!s.hscroll, `${w}：沒有橫向捲動`);
    // 勾一則 → 1；全選 → 3；取消全選 → 0
    await clickChk('[data-ask-check]');
    await until(async () => (await st()).btn?.t === '不用回（1）', 5000, `${w}：勾一則`);
    assert.equal((await st()).btn.off, false, `${w}：勾了就能按`);
    assert.ok(await js(`document.activeElement?.matches('[data-ask-check]')`), `${w}：重畫後焦點留在勾選框`);
    const blue = await js(`(() => { const b = document.querySelector('[data-ask-done]'), p = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(), c = getComputedStyle(b).color; const t = document.createElement('span'); t.style.color = p; document.body.append(t); const pc = getComputedStyle(t).color; t.remove(); return c === pc; })()`);
    assert.ok(blue, `${w}：可按時按鈕是藍字`);
    await js(`document.querySelectorAll('.ask-head')[1].click(); true`);
    await until(async () => (await st()).btn?.t === '不用回（2）', 5000, `${w}：點標題列也能勾`);
    await js(`document.querySelectorAll('.ask-head')[1].click(); true`);
    await until(async () => (await st()).btn?.t === '不用回（1）', 5000, `${w}：再點取消`);
    if (w < 600) {
      const same = await J(`(() => { const r = document.querySelector('.ask-row-item'), c = r.querySelector('.sugg-check').getBoundingClientRect(), h = r.querySelector('.ask-head').getBoundingClientRect(); return Math.abs(c.top - h.top) < 12 && c.right <= h.left + 2; })()`);
      assert.ok(same, `${w}：手機勾選框跟標籤同一行、在左邊`);
    }
    await clickChk('[data-ask-all]');
    await until(async () => (await st()).btn?.t === '不用回（3）', 5000, `${w}：全選`);
    await clickChk('[data-ask-all]');
    await until(async () => (await st()).btn?.t === '不用回（0）', 5000, `${w}：取消全選`);
    if (w < 600) {
      const tall = await J(`[...document.querySelectorAll('.ask-batch .btn, .ask-row-item .sugg-check, .ask-batch .sugg-check')].map(e => Math.round(e.getBoundingClientRect().height))`);
      assert.ok(tall.every(h => h >= 44), `${w}：手機上按鈕、勾選框夠大（≥44）：` + tall);
    }
  }

  // B. 按下先跳確認，文字寫清楚；取消就不動
  await clickChk('[data-ask-all]');
  await until(async () => (await st()).btn?.t === '不用回（3）', 5000, '全選');
  await js(`document.querySelector('[data-ask-done]').click(); true`);
  await until(() => js(`!!document.querySelector('.confirm-root .confirm-msg')`), 5000, '確認框');
  const msg = await js(`document.querySelector('.confirm-root').textContent`);
  for (const k of ['這 3 則都不用回？', '只會從你的「要你回覆」清單移走', '不會回覆提問的人', '不會叫醒任何 AI', '還在等你回覆的 AI 會繼續等', '別人的清單不受影響'])
    assert.ok(msg.includes(k), '確認框寫：' + k + '｜實得：' + msg);
  await js(`document.querySelector('.confirm-root [data-close]').click(); true`);
  await sleep(300);
  assert.equal((await st()).rows, 3, '取消就不動');
  assert.equal((await count()).liuPending, before.liuPending, '取消不 ack');

  // C. 確定：清單與計數更新、只 ack 自己的、不產生任何訊息或通知
  await js(`document.querySelector('[data-ask-done]').click(); true`);
  await until(() => js(`!!document.querySelector('.confirm-root [data-ok]')`), 5000, '確認框');
  await js(`document.querySelector('.confirm-root [data-ok]').click(); true`);
  await until(() => js(`document.querySelectorAll('.ask-row-item').length === 0`), 5000, '清單清空');
  await until(async () => (await count()).liuPending === before.liuPending - 3, 5000, '使用者的 3 則 ack 了');
  const after = await count();
  assert.equal(after.msgs, before.msgs, '沒有發任何訊息（不回覆、不叫醒 AI）');
  assert.equal(after.notes, before.notes, '沒有產生任何通知');
  assert.equal(after.uxPending, before.uxPending, '別人的清單不受影響');
  assert.equal((kit.get("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND status = 'pending'", ai.participantId)).n, 0, 'AI 沒被叫醒（沒有新通知）');
  // 重新整理也還是空的（伺服器真的確認了）
  await login(boss.token, '/p/main/inbox');
  await sleep(1500);
  assert.equal((await st()).rows, 0, '重新整理後仍已處理');

  // D.「[需確認] 訊息」那區：勾選、全選、批次「已處理」＝全團隊移掉；確認框寫清楚；不發文、不產生通知
  for (const n of [1, 2]) assert.equal((await kit.call(ai.token, '/api/messages', 'POST', { requestId: 'p346q-' + n, project: '預設專案', recipientIds: [L], replyFrom: [L], text: `[需確認] 第 ${n} 題 QMARK${n}\n選項：\nA. 好\nB. 不好` })).status, 201, '[需確認] ' + n);
  const before2 = await count();
  await login(boss.token, '/p/main/inbox');
  await until(() => js(`!document.querySelector('#app').hidden && document.querySelectorAll('[data-conf-check]').length === 2`), 15000, '[需確認] 兩則有勾選框');
  assert.ok(await js(`document.querySelector('[data-conf-done]').disabled`), '[需確認]：沒勾時按鈕不能按');
  await clickChk('[data-conf-all]');
  await until(() => js(`document.querySelector('[data-conf-done]').textContent.trim() === '標為已處理（2）'`), 5000, '[需確認] 全選');
  assert.ok(await js(`document.activeElement?.matches('[data-conf-all]')`), '重畫後焦點留在全選：' + await js(`(document.activeElement?.outerHTML || 'none').slice(0, 160)`));
  await js(`document.querySelector('[data-conf-done]').click(); true`);
  await until(() => js(`!!document.querySelector('.confirm-root .confirm-msg')`), 5000, '[需確認] 確認框');
  const msg2 = await js(`document.querySelector('.confirm-root').textContent`);
  for (const k of ['把 2 則 [需確認] 標為已處理？', '所有人', '不會回覆提問的 AI，也不會叫醒它', '已處理（未回覆）', '當成暫緩，不再等、不重問'])
    assert.ok(msg2.includes(k), '[需確認] 確認框寫：' + k + '｜實得：' + msg2);
  await js(`document.querySelector('.confirm-root [data-ok]').click(); true`);
  await until(() => js(`document.querySelectorAll('[data-conf-check]').length === 0`), 8000, '[需確認] 清單清空');
  assert.equal(kit.get('SELECT COUNT(*) AS n FROM decision_resolutions').n, 2, '兩則都記了已處理');
  const after2 = await count();
  assert.equal(after2.msgs, before2.msgs, '[需確認] 批次：沒有發任何訊息');
  assert.equal(after2.notes, before2.notes, '[需確認] 批次：沒有產生任何通知');
  const q = (await kit.call(ai.token, '/api/messages?limit=5')).body.items.filter(m => /QMARK/.test(m.text));
  assert.ok(q.length === 2 && q.every(m => m.resolution?.state === '已處理（未回覆）' && m.resolution.by.name === '王大明'), '提問的 AI 讀得到已處理：' + JSON.stringify(q.map(m => m.resolution)));
  // 訊息頁上那兩則標「已處理（未回覆）」，滑過去看得到誰按的
  await login(boss.token, '/p/main/messages');
  await until(() => js(`document.querySelectorAll('.tag.resolved').length === 2`), 15000, '訊息頁兩則有已處理標記');
  const look = await J(`[...document.querySelectorAll('.tag.resolved')].map(t => { const a = t.closest('article'); return { text: t.textContent, yellow: a.classList.contains('to-me') || a.classList.contains('need-me'), ask: !!a.querySelector('.apill.ask.me'), box: !!a.querySelector('.auth-box'), reopen: !!a.querySelector('[data-ans-reopen]'), id: a.id }; })`);
  assert.ok(look.length === 2 && look.every(x => /^已處理（未回覆）· 王大明 /.test(x.text) && !x.yellow && !x.ask && !x.box && x.reopen), '已處理那則：灰色標籤寫誰、幾點；不黃底、沒有「要你回覆」、選項收起只留「還是要回答」：' + JSON.stringify(look));
  await js(`document.querySelector('#${look[0].id} [data-ans-reopen]').click(); true`);
  await until(() => js(`!!document.querySelector('#${look[0].id} .auth-box [data-q-send]')`), 5000, '按「還是要回答」才展開選項');
  console.log('batch-done-ui-test：全部通過');
} catch (e) {
  console.error('batch-done-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
