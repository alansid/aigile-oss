// 畫面測試（真的瀏覽器）：卡片抽屜打字／開選單時背景更新卡片，保留文字游標與選單，失焦後再補畫
import assert from 'node:assert/strict';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('drawer-typing-bg-refresh-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('drwbg');
try {
  const { call } = kit;
  const PJ = '預設專案';
  const boss = (await call(null, '/api/join', 'POST', { name: '林小安', role: 'PO' })).body;
  const mate = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const helper = (await call(null, '/api/join', 'POST', { name: '張小美', role: 'PG' })).body;
  await call(boss.token, `/api/participants/${mate.participant.participantId}/projects`, 'PUT', { projects: [PJ] });
  await call(boss.token, `/api/participants/${helper.participant.participantId}/projects`, 'PUT', { projects: [PJ] });
  const c1 = (await call(boss.token, '/api/cards', 'POST', { requestId: 'bg_c1', project: PJ, title: '原本標題', reason: '測背景更新', ownerId: mate.participant.participantId })).body;
  const c2 = (await call(boss.token, '/api/cards', 'POST', { requestId: 'bg_c2', project: PJ, title: '被標記的卡', reason: 'r2' })).body;
  await call(mate.token, '/api/messages', 'POST', { project: PJ, requestId: 'bg_m1', cardId: c1.cardId, text: '測試長訊息內容 '.repeat(25) });

  const { js, login, cdp } = await kit.browser(1280, 860);
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true });
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
  const mouseClick = async sel => {
    const pos = await js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  };

  await login(boss.token, '/p/main/work');
  await until(() => js(`!!document.querySelector('[data-card="${c1.cardId}"]')`), 15000, '看板看到 c1');
  await js(`document.querySelector('[data-card="${c1.cardId}"]').click(); true`);
  const replySel = `#card-drawer [data-inl-text="k:${c1.cardId}"]`;
  await until(() => js(`!!document.querySelector(${JSON.stringify(replySel)}) && !!document.querySelector('#card-drawer [data-dmsg-toggle]')`), 10000, '抽屜打開且含長訊息');

  // A. 觸發一般重畫（點展開長訊息）時保留文字、焦點與中間游標位置
  await js(`(() => {
    const ta = document.querySelector(${JSON.stringify(replySel)});
    ta.focus();
    ta.value = '前半 後半';
    ta.setSelectionRange(2, 2);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.setSelectionRange(2, 2);
    return true;
  })()`);
  await js("document.querySelector('#card-drawer [data-dmsg-toggle]').click(); true");
  await until(() => js("document.querySelector('#card-drawer [data-dmsg-toggle]')?.getAttribute('aria-expanded') === 'true'"), 5000, '長訊息展開觸發重畫');
  const afterRedraw = await js(`(() => {
    const ta = document.querySelector(${JSON.stringify(replySel)});
    return { val: ta.value, active: document.activeElement === ta, s: ta.selectionStart, e: ta.selectionEnd };
  })()`);
  assert.deepEqual(afterRedraw, { val: '前半 後半', active: true, s: 2, e: 2 }, '重畫保留文字、焦點與游標位置');

  // B/C. # 選單開著時，另一人更新卡片標題與狀態 → 抽屜資料即時更新，選單與輸入區原封不動
  await js(`(() => { document.querySelector('#card-drawer .dcompose').__keep = 1; document.querySelector(${JSON.stringify(replySel)}).__keep = 1; return true; })()`);
  await typeIn(replySel, '請看 #');
  await until(() => js("!!document.querySelector('#card-drawer .mention-list:not([hidden]) .card-pick-row')"), 5000, '打開 # 選單');
  const patch1 = await call(mate.token, `/api/cards/${c1.cardId}`, 'PATCH', { title: '背景更新後標題', status: '進行中', version: c1.version });
  assert.equal(patch1.status, 200, '陳大文背景改卡成功');
  await until(() => js("document.querySelector('#drawer-title')?.textContent === '背景更新後標題' && document.querySelector('#card-drawer .drawer-status .cst-pill')?.textContent === '進行中'"), 10000, '抽屜標題與狀態即時更新');
  const duringHash = await js(`(() => {
    const dc = document.querySelector('#card-drawer .dcompose'), ta = document.querySelector(${JSON.stringify(replySel)}), m = document.querySelector('#card-drawer .mention-list');
    return { dcKeep: dc.__keep, taKeep: ta.__keep, open: !!m && !m.hidden && m.querySelectorAll('.card-pick-row').length >= 1, val: ta.value, active: document.activeElement === ta, pos: ta.selectionStart };
  })()`);
  assert.deepEqual(duringHash, { dcKeep: 1, taKeep: 1, open: true, val: '請看 #', active: true, pos: 4 }, '# 選單與文字游標未被背景更新清掉');
  await keyIn(replySel, 'Enter');
  assert.equal(await js(`document.querySelector(${JSON.stringify(replySel)}).value`), `請看 ${c2.cardId} `, '背景更新後仍可用 Enter 從原選單插入卡號');

  // @ 選單開著時再次背景更新（改負責人為林小安，會改變可通知人）→ 選單還在；失焦後自動補畫輸入區
  await typeIn(replySel, '麻煩 @');
  await until(() => js("!!document.querySelector('#card-drawer .mention-list:not([hidden])')"), 5000, '打開 @ 選單');
  const patch2 = await call(mate.token, `/api/cards/${c1.cardId}`, 'PATCH', { title: '第二次背景更新', ownerId: boss.participant.participantId, version: patch1.body.version });
  assert.equal(patch2.status, 200, '陳大文背景改負責人成功');
  await until(() => js("document.querySelector('#drawer-title')?.textContent === '第二次背景更新'"), 10000, '抽屜標題第二次即時更新');
  assert.equal(await js("document.querySelector('#card-drawer .dcompose').__keep"), 1, '@ 選單開著時不重畫 .dcompose');
  assert.equal(await js("!document.querySelector('#card-drawer .mention-list').hidden"), true, '@ 選單仍保持開啟');
  assert.equal(await js(`document.querySelector(${JSON.stringify(replySel)}).value`), '麻煩 @', '@ 打到一半的字還在');

  // 打開抽屜 body 的「改狀態 ▾」觸發失焦補畫：只補畫 .dcompose，不關掉 .st-menu，且通知對象與草稿同步保留
  await mouseClick('#card-drawer details.st-menu summary');
  assert.equal(await js("document.querySelector('#card-drawer details.st-menu').open"), true, '點改狀態可打開選單');
  await until(() => js("!document.querySelector('#card-drawer .dcompose')?.__keep"), 5000, '失焦後自動補畫輸入區');
  assert.equal(await js("document.querySelector('#card-drawer details.st-menu').open"), true, '補畫 .dcompose 不會把改狀態選單關掉');
  await js("document.querySelector('#card-drawer details.st-menu').open = false; true");
  assert.match(await js("document.querySelector('#card-drawer .dcompose [data-inl-to]').innerText"), /你是負責人/, '補畫後顯示最新卡片通知對象');
  assert.equal(await js(`document.querySelector(${JSON.stringify(replySel)}).value`), '麻煩 @', '補畫後草稿文字仍在');

  // pending 期間若背景改了負責人，按下交接必須中止並提示，不可默默交給舊畫面以外的新對象
  await js("document.querySelector('#card-drawer [data-cmode=\"handover\"]').click(); true");
  const hoSel = `#card-drawer [data-cdraft="h:${c1.cardId}"]`;
  await until(() => js(`!!document.querySelector(${JSON.stringify(hoSel)})`), 5000, '切到交接分頁');
  await typeIn(hoSel, '做到一半請接手');
  assert.match(await js("document.querySelector('#card-drawer [data-act=\"ho-go\"]').textContent"), /陳大文/, '背景更新前按鈕仍是陳大文');
  const patch3 = await call(mate.token, `/api/cards/${c1.cardId}`, 'PATCH', { ownerId: mate.participant.participantId, version: patch2.body.version });
  assert.equal(patch3.status, 200, '背景把負責人改為陳大文');
  await until(() => js("document.querySelector('#card-drawer .drawer-status').innerText.includes('陳大文')"), 10000, '抽屜狀態區已更新為陳大文');
  assert.match(await js("document.querySelector('#card-drawer [data-act=\"ho-go\"]').textContent"), /陳大文/, 'pending 期間交接按鈕尚未重畫');
  await js("document.querySelector('#card-drawer [data-act=\"ho-go\"]').click(); true");
  await until(() => js("!!document.querySelector('#card-drawer #cmp-err')?.textContent.trim()"), 5000, '過時交接顯示錯誤提示');
  assert.match(await js("document.querySelector('#card-drawer #cmp-err').textContent"), /背景更新/, '提示卡片已在背景更新');
  assert.match(await js("document.querySelector('#card-drawer [data-act=\"ho-go\"]').textContent"), /張小美/, '補畫後按鈕已更新為新候選人張小美');
  assert.equal(await js(`document.querySelector(${JSON.stringify(hoSel)}).value`), '做到一半請接手', '過時中止後交接草稿仍在');
  assert.equal((await call(boss.token, `/api/cards/${c1.cardId}`)).body.owner?.participantId, mate.participant.participantId, '伺服器負責人未被誤交接');

  // pending 期間送出（網路延遲 > 180ms）不可被 focusout 補畫重啟按鈕導致重複送出
  await js("document.querySelector('#card-drawer [data-cmode=\"reply\"]').click(); true");
  await until(() => js(`!!document.querySelector(${JSON.stringify(replySel)})`), 5000, '切回回覆分頁');
  await typeIn(replySel, '準備送出的回覆');
  const patch4 = await call(mate.token, `/api/cards/${c1.cardId}`, 'PATCH', { title: '慢送出期間標題', version: patch3.body.version });
  assert.equal(patch4.status, 200, '背景再次更新標題');
  await until(() => js("document.querySelector('#drawer-title')?.textContent === '慢送出期間標題'"), 10000, '抽屜更新為慢送出期間標題');
  await js(`(() => {
    document.querySelector('#card-drawer .dcompose').__sendKeep = 1;
    window.__msgPosts = 0;
    const origFetch = window.fetch;
    window.fetch = async (url, init) => {
      if (String(url).includes('/api/messages') && init?.method === 'POST') {
        window.__msgPosts++;
        await new Promise(r => setTimeout(r, 380));
      }
      return origFetch(url, init);
    };
    document.querySelector('#card-drawer [data-inl-act="send"]').click();
    return true;
  })()`);
  await sleep(250);
  const midSend = await js(`(() => {
    const dc = document.querySelector('#card-drawer .dcompose'), btn = document.querySelector('#card-drawer [data-inl-act="send"]');
    btn?.click();
    return { sendKeep: dc?.__sendKeep, disabled: btn?.disabled, text: btn?.textContent };
  })()`);
  assert.deepEqual(midSend, { sendKeep: 1, disabled: true, text: '送出中…' }, '250ms 時不應重畫或解鎖送出鈕');
  await until(() => js(`document.querySelector(${JSON.stringify(replySel)})?.value === ''`), 8000, '慢速送出完成後清空草稿');
  assert.equal(await js('window.__msgPosts'), 1, '只送出一次 POST，無重複送出');
  console.log('drawer-typing-bg-refresh-ui-test：全部通過');
} finally {
  await kit.stop();
}
