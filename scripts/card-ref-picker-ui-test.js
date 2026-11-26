// 畫面測試：訊息、卡片留言、交接欄與私訊輸入 # 跳出卡片選單（中／英文、1280／375）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('card-ref-picker-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('crdref');
try {
  const { call } = kit;
  const boss = (await call(null, '/api/join', 'POST', { name: '林小安', role: 'PO' })).body;
  const ai = (await call(boss.token, '/api/my-ais', 'POST', {
    projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '開發助手',
    duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x',
  })).body;
  const p2Res = await call(boss.token, '/api/projects', 'POST', { name: '其他測試專案', code: 'OTH' });
  assert.equal(p2Res.status, 201, '建第二專案');
  const P2 = p2Res.body.id;
  assert.equal((await call(boss.token, `/api/participants/${boss.participant.participantId}/projects`, 'PUT', { projects: [...(boss.participant.projects || ['預設專案']), P2] })).status, 200, '加入第二專案');
  assert.equal((await call(boss.token, '/api/projects/' + encodeURIComponent('預設專案') + '/dm', 'PUT', { on: true })).status, 200, '開啟預設專案私訊');

  const c1 = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c1', project: '預設專案', title: 'Login failure unclear', reason: 'r1' })).body;
  await call(boss.token, `/api/cards/${c1.cardId}`, 'PATCH', { status: '進行中', version: c1.version });
  const c2 = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c2', project: '預設專案', title: '拖曳上傳', reason: 'r2', ownerId: ai.participantId })).body;
  assert.equal((await call(boss.token, `/api/cards/${c2.cardId}`, 'PATCH', { status: '待確認', waitForId: boss.participant.participantId, version: c2.version })).status, 200, 'c2 改成待確認、等我驗收');
  const cArch = (await call(boss.token, '/api/cards', 'POST', { requestId: 'c3', project: '預設專案', title: 'Archived item', reason: 'r3' })).body;
  await call(boss.token, `/api/cards/${cArch.cardId}`, 'PATCH', { status: '已封存', version: cArch.version });
  const cOtherRes = await call(boss.token, '/api/cards', 'POST', { requestId: 'c4', project: P2, title: 'Other project task', reason: 'r4' });
  assert.equal(cOtherRes.status, 201, JSON.stringify(cOtherRes.body));
  const cOther = cOtherRes.body;
  await call(boss.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'm1', text: '測試訊息串。' });

  const { js, login, cdp } = await kit.browser(1280, 860);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const shotDir = process.env.CARDREF_SHOTS;
  const shot = async name => {
    if (!shotDir) return;
    fs.mkdirSync(shotDir, { recursive: true });
    await sleep(220);
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const typeIn = async (sel, val) => {
    await js(`(() => {
      const ta = document.querySelector(${JSON.stringify(sel)});
      ta.focus();
      ta.value = ${JSON.stringify(val)};
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  };
  const keyIn = async (sel, key) => {
    await js(`(() => {
      const ta = document.querySelector(${JSON.stringify(sel)});
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
      return true;
    })()`);
  };

  // 中文 1280：觸發規則、搜尋與無結果＋Esc、卡片四模式＋交接欄、私訊跨專案
  await size(1280, 860);
  await login(boss.token, '/p/main/messages');
  await until(() => js("!!document.querySelector('#input') && document.querySelectorAll('#messages .msg').length >= 1"), 15000, '進訊息頁');
  await sleep(250);

  await typeIn('#input', 'C#');
  assert.equal(await js("document.querySelector('#mention-list').hidden"), true, 'C# 不觸發');
  await typeIn('#input', '#');
  await until(() => js("!document.querySelector('#mention-list').hidden"), 3000, '開選單');
  const ids = await J("[...document.querySelectorAll('#mention-list .card-pick-row .cid')].map(x => x.textContent)");
  assert.ok(ids.includes(c1.cardId) && !ids.includes(cArch.cardId) && !ids.includes(cOther.cardId), '只列本專案未封存卡');

  await typeIn('#input', '#MAIN');
  await until(() => js("document.querySelector('#mention-list .card-pick-row .cid mark')?.textContent === 'MAIN'"), 3000, '大寫 #MAIN 卡號標黃');

  await typeIn('#input', '#xyz');
  await until(() => js("!document.querySelector('#mention-list').hidden && !!document.querySelector('#mention-list .card-pick-empty')"), 3000, '無結果不關');
  await keyIn('#input', 'Escape');
  assert.equal(await js("document.querySelector('#mention-list').hidden"), true, 'Esc 關選單');
  await typeIn('#input', '#xyz123');
  assert.equal(await js("document.querySelector('#mention-list').hidden"), true, '同一 # 不再開');

  await typeIn('#input', '請看 #9999');
  await until(() => js("!!document.querySelector('#mention-list .card-pick-empty')"), 3000, '#9999 無結果');
  await keyIn('#input', 'Enter');
  await until(() => js("document.querySelector('#mention-list').hidden && document.querySelector('#messages').textContent.includes('請看 #9999')"), 8000, '無結果時 Enter 照常送出並關選單');

  await typeIn('#input', '看 #');
  await until(() => js("!document.querySelector('#mention-list').hidden"), 3000, '重開 #');
  await keyIn('#input', 'Enter');
  const ins = await js("document.querySelector('#input').value");
  assert.match(ins, /^看 MAIN-\d+ $/, '插入卡號加空白');
  const cardKey = ins.trim().split(/\s+/).pop();
  await js("document.querySelector('#send').click(); true");
  await until(() => js(`!!document.querySelector('#messages [data-cap="${cardKey}"]')`), 8000, '送出變膠囊');
  await js(`document.querySelector('#messages .cg-head[data-cap="${cardKey}"]')?.click(); true`);
  await until(() => js(`!!document.querySelector('#messages .cap[data-cap="${cardKey}"]')`), 5000, '展開群組卡片膠囊');

  // 卡片抽屜四模式
  await js("document.querySelector('[data-nav=\"work\"]').click(); true");
  await until(() => js(`!!document.querySelector('[data-card="${c2.cardId}"]')`), 8000, '看 c2');
  await js(`document.querySelector('[data-card="${c2.cardId}"]').click(); true`);
  await until(() => js("!!document.querySelector('#card-drawer .dcompose [data-cmode=\"back\"]')"), 8000, 'c2 四模式');
  for (const [mode, sel] of [
    ['reply', `#card-drawer [data-inl-text="k:${c2.cardId}"]`],
    ['note', '#note-text'],
    ['handover', `#card-drawer [data-cdraft="h:${c2.cardId}"]`],
    ['handover', `#card-drawer [data-cdraft="hn:${c2.cardId}"]`],
    ['back', `#card-drawer [data-cdraft="r:${c2.cardId}"]`],
  ]) {
    await js(`document.querySelector('#card-drawer [data-cmode="${mode}"]').click(); true`);
    await typeIn(sel, '#');
    await until(() => js("!!document.querySelector('#card-drawer .mention-list:not([hidden]) .card-pick-row')"), 3000, mode + ' 開選單');
    await keyIn(sel, 'Enter');
    assert.match(await js(`document.querySelector(${JSON.stringify(sel)}).value`), /^MAIN-\d+ $/, mode + ' 插入');
  }
  await js("document.querySelector('#card-drawer [data-close-drawer]').click(); true");

  // 英文介面 1280（群組、搜尋、無結果、私訊）
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await login(boss.token, '/p/main/messages');
  await until(() => js("document.documentElement.lang === 'en' && !!document.querySelector('#input')"), 15000, '英文訊息頁');
  await sleep(250);

  await typeIn('#input', 'This is like #');
  await until(() => js("!document.querySelector('#mention-list').hidden"), 3000, '英文打 #');
  const enOpen = await J("({ head: document.querySelector('#mention-list .mention-grp')?.textContent, tip: document.querySelector('#mention-list .card-pick-tip')?.textContent, st: document.querySelector('#mention-list .card-pick-row .cst')?.textContent })");
  assert.match(enOpen.head, /^Recently updated cards · /, '英文標題：' + enOpen.head);
  assert.equal(enOpen.tip, '↑↓ to move · Enter to insert · Esc to close (type # as is)', '英文按鍵提示');
  assert.ok(['In progress', 'Done', 'To do', 'Triage', 'Awaiting confirmation'].includes(enOpen.st), '英文狀態籤：' + enOpen.st);
  await shot('card-ref-en-1280');

  await typeIn('#input', '#xyz');
  await until(() => js("!!document.querySelector('#mention-list .card-pick-empty')"), 3000, '英文無結果');
  assert.match(await js("document.querySelector('#mention-list .card-pick-empty').textContent"), /No cards match “xyz”\.[\s\S]*Press Esc to keep typing #xyz\./, '英文無結果說明');

  await js("document.querySelector('.topbar [data-dm-toggle]').click(); true");
  await until(() => js("!!document.querySelector('[data-dm-open], #dm-input')"), 5000, '英文私訊清單');
  await js("document.querySelector('[data-dm-open]')?.click(); true");
  await until(() => js("!!document.querySelector('#dm-input')"), 5000, '英文私訊輸入');
  await typeIn('#dm-input', '#');
  await until(() => js("!document.querySelector('#dm-card-list').hidden"), 3000, '英文私訊打 #');
  assert.equal(await js("document.querySelector('#dm-card-list .mention-grp')?.textContent"), 'Recently updated cards · your projects', '英文私訊標題');
  assert.ok(await js("[...document.querySelectorAll('#dm-card-list .card-pick-row .ptag')].length >= 2"), '英文私訊顯示專案標籤');
  await typeIn('#dm-input', 'see #9999');
  await until(() => js("!!document.querySelector('#dm-card-list .card-pick-empty')"), 3000, '英文私訊 #9999 無結果');
  await keyIn('#dm-input', 'Enter');
  await until(() => js("document.querySelector('#dm-card-list').hidden && document.querySelector('#dm-list').textContent.includes('see #9999')"), 8000, '私訊無結果 Enter 照常送出');
  await js("document.querySelector('[data-dm-close]').click(); true");

  // 手機 375（中文）
  await js("localStorage.setItem('aigile-lang', 'zh'); true");
  await size(375, 812);
  await login(boss.token, '/p/main/messages');
  await until(() => js("!!document.querySelector('#input')"), 15000, '手機 375 訊息頁');
  await sleep(250);
  await typeIn('#input', '#');
  await until(() => js("!document.querySelector('#mention-list').hidden"), 3000, '375 開選單');
  assert.equal(await js("getComputedStyle(document.querySelector('#mention-list .card-pick-tip')).display"), 'none', '375 不顯示按鍵提示');
  assert.ok(await js("document.querySelector('#mention-list .card-pick-row').getBoundingClientRect().height >= 44"), '375 列高 >= 44px');

  console.log('card-ref-picker-ui-test：全部通過');
} finally {
  await kit.stop();
}
