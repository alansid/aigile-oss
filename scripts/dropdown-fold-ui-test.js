// 共用元件回歸測試（真的瀏覽器）：設計系統自訂下拉（搜尋、人/AI 分組、✓、分隔線、鍵盤操作、375px、英文）與展開／收起小箭頭＋「再看 N → 收起」
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('dropdown-fold-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }

const SHOTS = process.env.PLAT490_SHOTS ? path.resolve(process.env.PLAT490_SHOTS) : '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const kit = await startKit('dfold');
try {
  const { call } = kit;
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const proj = (await call(liu.token, '/api/projects')).body.items[0];
  const PJ = proj.id;
  const mei = (await call(null, '/api/join', 'POST', { name: '林美玲', role: 'UX' })).body;
  const chen = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  for (const u of [mei, chen]) {
    await call(liu.token, `/api/participants/${u.participant.participantId}/projects`, 'PUT', { projects: [PJ] });
  }

  const aiIds = [];
  for (let i = 1; i <= 7; i++) {
    const a = (await call(liu.token, '/api/my-ais', 'POST', {
      name: `Worker-${i}`,
      projects: [PJ],
      roleKey: i <= 4 ? 'PG' : 'QA',
      role: i <= 4 ? 'PG' : 'QA',
      duties: '開發與測試',
      style: '簡潔',
      autonomy: '自測',
      mustConfirm: '提交',
      handoff: '審查',
    })).body;
    assert.ok(a.participantId, `應成功建立 AI Worker-${i}：${JSON.stringify(a)}`);
    aiIds.push(a.participantId);
  }

  const owners = [mei.participant.participantId, chen.participant.participantId, aiIds[0], aiIds[1], aiIds[2]];
  let editCard = null;
  for (let i = 0; i < owners.length; i++) {
    const c = (await call(liu.token, '/api/cards', 'POST', {
      requestId: `dfold_blk_${i}`,
      project: PJ,
      type: '阻塞',
      status: '受阻',
      title: `阻塞驗證工作 ${i + 1}`,
      ownerId: owners[i],
      blocker: '等前置介面確認',
    })).body;
    if (i === 0) editCard = c;
  }

  const noteCard = (await call(liu.token, '/api/cards', 'POST', {
    requestId: 'dfold_note',
    project: PJ,
    type: '人類紀錄',
    title: '私有筆記',
    ownerId: liu.participant.participantId,
  })).body;

  await call(liu.token, '/api/messages', 'POST', {
    project: PJ,
    requestId: 'dfold_m1',
    text: '[進度] 驗證下拉與展開收合',
  });

  const { js, login, cdp, key } = await kit.browser(1280, 860);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const snap = async name => {
    if (!SHOTS) return;
    await sleep(160);
    const r = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const hscroll = () => js('document.documentElement.scrollWidth > document.documentElement.clientWidth + 1');

  await login(liu.token, `/p/${encodeURIComponent(proj.slug || 'main')}/messages`);
  await until(() => js('!!document.querySelector("[data-tb-filter]")'), 10000, '登入訊息頁');

  // 1. 桌面 1280：訊息篩選成員下拉
  await js('document.querySelector("[data-tb-filter]").click(); true');
  await until(() => js('!!document.querySelector("#msg-flt-drawer:not([hidden]) [data-flt-member]")'), 5000, '展開篩選列');
  await js('document.querySelector("#msg-flt-drawer [data-flt-member]").closest(".flt-sel-pill").querySelector(".ui-sel-hit").click(); true');
  await until(() => js('!document.querySelector("#ui-sel-menu")?.hidden'), 3000, '開啟成員選單');

  const memStats = await js(`(() => {
    const m = document.querySelector('#ui-sel-menu');
    const search = m.querySelector('.ui-sel-search');
    const opts = [...m.querySelectorAll('.ui-sel-opt')];
    return {
      radius: getComputedStyle(m).borderRadius,
      hasSearch: !!search,
      placeholder: search?.placeholder || '',
      grps: [...m.querySelectorAll('.ui-sel-grp')].map(x => x.textContent.trim()),
      hasHr: !!m.querySelector('hr.ui-sel-hr'),
      minRowH: Math.min(...opts.map(o => o.getBoundingClientRect().height)),
      selChk: m.querySelector('.ui-sel-opt[aria-selected="true"] .ui-sel-chk')?.textContent.trim() || '',
    };
  })()`);
  assert.equal(memStats.radius, '10px');
  assert.ok(memStats.hasSearch && memStats.placeholder === '找成員…', `memStats=${JSON.stringify(memStats)}`);
  assert.deepEqual(memStats.grps, ['人', 'AI']);
  assert.ok(memStats.hasHr);
  assert.ok(memStats.minRowH >= 39.5);
  assert.equal(memStats.selChk, '✓');

  await js(`(() => { const q = document.querySelector('#ui-sel-menu .ui-sel-search'); q.value = '查無此人xyz'; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal(await js('document.querySelector("#ui-sel-menu .ui-sel-empty")?.textContent.trim()'), '沒有符合的成員');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  assert.ok(await js('document.querySelector("#ui-sel-menu").hidden'));

  // Tab 移焦選取回歸測試
  await js('document.querySelector("#msg-flt-drawer [data-flt-member]").closest(".flt-sel-pill").querySelector(".ui-sel-hit").click(); true');
  await until(() => js('!document.querySelector("#ui-sel-menu")?.hidden && document.activeElement?.classList?.contains("ui-sel-search")'), 3000, '聚焦搜尋框');
  await key('Tab');
  await key('Tab');
  const focusedMemberVal = await js('document.activeElement?.closest(".ui-sel-opt")?.textContent.trim() || ""');
  assert.ok(focusedMemberVal && focusedMemberVal !== '所有成員');
  await key('Enter');
  assert.ok(await js('document.querySelector("#ui-sel-menu").hidden'));
  assert.equal(await js('document.querySelector("#msg-flt-drawer [data-flt-member] option:checked")?.textContent.trim()'), focusedMemberVal);
  await js('document.querySelector("#msg-flt-drawer [data-flt-clear]")?.click(); true');

  // 分類下拉（<= 8 項不顯示搜尋框）+ 鍵盤選取
  await js('document.querySelector("#msg-flt-drawer [data-flt-tag]").closest(".flt-sel-pill").querySelector(".ui-sel-hit").click(); true');
  await until(() => js('!document.querySelector("#ui-sel-menu")?.hidden'), 3000, '開啟分類選單');
  assert.equal(await js('document.querySelectorAll("#ui-sel-menu .ui-sel-search").length'), 0);
  await key('ArrowDown');
  await key('Enter');
  assert.ok(await js('document.querySelector("#ui-sel-menu").hidden && !!document.querySelector("#msg-flt-drawer [data-flt-tag]").value'));
  await js('document.querySelector("#msg-flt-drawer [data-flt-clear]")?.click(); true');

  // 2. 團隊頁「再看 N → 收起」＋ .ui-fold 16px SVG
  await js('document.querySelector(\'[data-nav="team"]\').click(); true');
  await until(() => js('!!document.querySelector("[data-alerts-more]")'), 5000, '團隊頁載入');

  assert.equal(await js('!!document.querySelector(".project-alerts details")'), false);
  assert.equal(await js('document.querySelector("[data-alerts-more]").textContent.trim()'), '再看 2');
  assert.equal(await js('document.querySelector("[data-alerts-more] .ui-chev").getBoundingClientRect().width'), 16);
  await js('document.querySelector("[data-alerts-more]").click(); true');
  assert.equal(await js('document.querySelector("[data-alerts-more]").textContent.trim()'), '收起');
  assert.ok(await js('(() => { const b = document.querySelector("[data-alerts-more]"), r = document.querySelector(".project-alerts-rest"), t = [...document.querySelectorAll(".project-alerts>.team-alert")], rr = [...r.querySelectorAll(".team-alert")]; return !r.hidden && b.getBoundingClientRect().top >= r.getBoundingClientRect().bottom - 2 && Math.abs(t[0].getBoundingClientRect().height - rr[0].getBoundingClientRect().height) <= 1; })()'));

  // 3. 卡片編輯與人類紀錄鎖頭行
  await js('document.querySelector(\'[data-nav="work"]\').click(); true');
  await until(() => js(`!!document.querySelector('[data-card="${noteCard.cardId}"]')`), 5000, '工作頁');
  await js(`document.querySelector('[data-card="${noteCard.cardId}"]').click(); true`);
  await until(() => js('!!document.querySelector("#card-drawer .lock-line")'), 5000, '人類紀錄');
  assert.ok(await js('document.querySelector("#card-drawer .lock-line").classList.contains("ui-fold") && !!document.querySelector("#card-drawer .lock-line > summary > .ui-chev")'));
  await js('document.querySelector("#card-drawer [data-close-drawer]")?.click(); true');
  await js(`document.querySelector('[data-card="${editCard.cardId}"]').click(); true`);
  await until(() => js('!!document.querySelector("#card-drawer [data-act=\\"edit\\"]")'), 5000, '開工作卡');
  await js('document.querySelector("#card-drawer [data-act=\\"edit\\"]").click(); true');
  await until(() => js('!!document.querySelector("#card-edit")'), 5000, '開編輯');
  assert.ok((await js('document.querySelectorAll("#card-edit .ui-sel .ui-sel-btn").length')) >= 4);
  await js('document.querySelector("#card-drawer [data-close-drawer]")?.click(); true');

  // 4. 手機 375 寬度
  await js('document.querySelector(\'[data-nav="messages"]\').click(); true');
  await until(() => js('!!document.querySelector("[data-tb-filter]")'), 5000, '切回訊息頁');
  await size(375, 812);
  await until(() => js('!!document.querySelector(".m-flt-btn[data-flt-toggle]")'), 5000, '375 篩選鈕');
  await js('document.querySelector(".m-flt-btn[data-flt-toggle]").click(); true');
  await until(() => js('!!document.querySelector("#msg-flt-drawer:not([hidden]) [data-flt-member]")'), 5000, '375 篩選');
  await js('document.querySelector("#msg-flt-drawer [data-flt-member]").closest(".flt-sel-pill").querySelector(".ui-sel-hit").click(); true');
  await until(() => js('!document.querySelector("#ui-sel-menu")?.hidden'), 3000, '375 成員選單');
  const mRect = await js(`(() => { const r = document.querySelector('#ui-sel-menu').getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width) }; })()`);
  assert.equal(mRect.left, 16);
  assert.ok(Math.abs(mRect.width - 343) <= 2);
  assert.ok(!(await hscroll()));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);

  // 5. 英文介面
  await size(1280, 860);
  await js("localStorage.setItem('aigile-lang', 'en'); location.reload(); true");
  await until(() => js('document.documentElement.lang === "en" && !!document.querySelector("[data-tb-filter]")'), 15000, '英文介面');
  await sleep(250);
  await js('document.querySelector("[data-tb-filter]").click(); true');
  await until(() => js('!!document.querySelector("#msg-flt-drawer:not([hidden]) [data-flt-member]")'), 5000, '英文版篩選');
  await js('document.querySelector("#msg-flt-drawer [data-flt-member]").closest(".flt-sel-pill").querySelector(".ui-sel-hit").click(); true');
  await until(() => js('!document.querySelector("#ui-sel-menu")?.hidden'), 3000, '英文版選單');
  assert.equal(await js('document.querySelector("#ui-sel-menu .ui-sel-search")?.placeholder'), 'Find a member…');
  assert.deepEqual(await js('[...document.querySelectorAll("#ui-sel-menu .ui-sel-grp")].map(x => x.textContent.trim())'), ['People', 'AI']);
  await snap('06-msg-filter-en-1280');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);

  await js('document.querySelector(\'[data-nav="team"]\').click(); true');
  await until(() => js('!!document.querySelector("[data-alerts-more]")'), 5000, '英文 Show more');
  assert.equal(await js('document.querySelector("[data-alerts-more]").textContent.trim()'), 'Show more 2');
  await js('document.querySelector("[data-alerts-more]").click(); true');
  assert.equal(await js('document.querySelector("[data-alerts-more]").textContent.trim()'), 'Show less');
  await snap('07-team-en-1280');

  console.log('dropdown-fold-ui-test：全部通過');
} finally {
  await kit.stop();
}
