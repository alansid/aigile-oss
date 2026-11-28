// 畫面測試（UX 文字 v1.2）：審查者要多不一樣（三段）＋模型
// A. 專案 ⚙ › 審查：「審查者要多不一樣」三個單選卡片（預設不限）＋底下小字；不限時「現在符合的審查者」照舊列（AI · 工具 · 模型，不明標黃）
//    不同模型／不同家：選一位 AI 當作者，看誰可以審；不符合的劃掉寫原因（同一個模型／同一家），模型不明寫「模型不明，當作不一樣」，人一律可以；儲存寫紀錄
// B. 卡片審查欄：審查者那行帶「AI · 工具 · 模型」，下面灰字說明規則有沒有符合；模型不明時寫「這隻 AI 沒回報模型，當作跟作者不一樣。」；不限時不寫這行
//    歷次紀錄每列帶當時的「工具 · 模型」
// C. 1280、375 不橫向捲動
// D. 團隊頁 AI 詳情：「工具・模型」帶回報的時間與時機；沒回報標黃「模型不明」；列表不顯示模型
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。設 REVIEW_MODEL_SHOTS=資料夾 會另外截圖。用法：node scripts/review-model-ui-test.js
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('review-model-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('rvm');
const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5', GPT = 'gpt-5.1-codex';
try {
  const { call } = kit;
  const PJ = encodeURIComponent('預設專案'), SET = `/api/projects/${PJ}/review-settings`;
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('劉昱志', 'PO'), hua = await join('小華', 'PG');
  await call(liu.token, `/api/participants/${hua.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  const mkAi = async (owner, name, tl, model) => {
    const a = (await call(owner.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    if (tl) kit.sql('INSERT INTO skill_syncs (ai_id, tool) VALUES (?, ?)', a.participantId, tl);
    if (model) assert.equal((await call(a.token, '/api/me/model', 'PUT', { model })).status, 200, '回報模型 ' + name);
    return a;
  };
  const pg = await mkAi(liu, '示範PG', 'claude', OPUS);
  const pg2 = await mkAi(liu, '示範PG2', 'claude', OPUS);
  const po = await mkAi(liu, '示範PO', 'claude', SONNET);
  const cx = await mkAi(hua, '示範Codex', 'codex', GPT);
  const ag = await mkAi(hua, '示範AG', 'antigravity', null);
  await call(liu.token, SET, 'PUT', { cards: 'code' });
  let rq = 0;
  const mkCard = async title => (await call(pg.token, '/api/cards', 'POST', { project: '預設專案', title, ownerId: pg.participantId, requestId: 'c' + (++rq) })).body.cardId;
  const request = (key, body) => call(pg.token, `/api/cards/${key}/review-request`, 'POST', { version: SHA1, note: '報價單匯出多一欄幣別；跑了 export-test，全過。', model: OPUS, ...body });
  const review = (tok, key, body) => call(tok, `/api/cards/${key}/review`, 'POST', { version: SHA1, result: 'pass', ...body });

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  const hscroll = () => js('document.documentElement.scrollWidth > innerWidth + 1');
  const shot = async name => { if (!process.env.REVIEW_MODEL_SHOTS) return; fs.mkdirSync(process.env.REVIEW_MODEL_SHOTS, { recursive: true }); await sleep(350); fs.writeFileSync(path.join(process.env.REVIEW_MODEL_SHOTS, name + '.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).result.data, 'base64')); };
  const text = sel => until(() => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (e && !e.getClientRects().length) return null; return [(e?.innerText || '').replace(/\\s+/g, ' ').trim()]; })()`), 5000, '畫出來 ' + sel).then(v => v[0]);
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const sizes = [[1280, 900, '1280'], [375, 812, '375']];
  const rowOf = label => `[...document.querySelectorAll('.rv-row')].find(r => r.querySelector('.rv-row-l b')?.textContent === ${JSON.stringify(label)})`;
  const rowText = label => until(() => js(`(() => { const r = ${rowOf(label)}; return r && r.getClientRects().length ? [r.innerText.replace(/\\s+/g, ' ').trim()] : null; })()`), 5000, '列 ' + label).then(v => v[0]);
  const cands = () => js(`[...document.querySelectorAll('.rv-cands li')].map(li => (li.classList.contains('rv-no') ? '✗ ' : '✓ ') + li.innerText.replace(/[✅⛔]/g, '').replace(/\\s+/g, ' ').trim())`);
  const pick = v => js(`(() => { const b = document.querySelector('[data-rv-set="differ"][data-v=\\'"${v}"\\']'); b.click(); return true; })()`);

  // ---------- A 專案 ⚙ › 審查 ----------
  const openSettings = async () => {
    await login(liu.token, '/p/main/files');
    await until(() => js("!!document.querySelector('[data-pset]')"), 15000, '專案 ⚙');
    await click('[data-pset]');
    await until(() => js("!!document.querySelector('#pset-menu [data-pset-act=\"review\"]')"), 5000, '⚙ 選單有審查');
    await click('#pset-menu [data-pset-act="review"]');
    await until(() => js("!!document.querySelector('.rv-differ')"), 8000, '審查設定');
  };
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    await openSettings();
    assert.equal(await rowText('要多不一樣'), '要多不一樣 不限 不是作者就好（預設） 不同模型 同一家也可以，新舊版本算不同 不同家 例如 Claude 寫、Codex 審', `A ${tag} 三段文字照 UX v2`);
    assert.deepEqual(await js("[...document.querySelectorAll('[data-rv-set=\"differ\"]')].map(b => b.getAttribute('role') + ':' + b.getAttribute('aria-checked'))"), ['radio:true', 'radio:false', 'radio:false'], `A ${tag} 單選、預設不限`);
    assert.equal(await js("document.querySelectorAll('[data-rv-author]').length"), 0, `A ${tag} 不限時不用選作者`);
    await click('[data-rv-eligible-fold] summary');
    const chips = await text('[data-rv-eligible-fold]');
    for (const c of [`示範PO AI · Claude · ${SONNET}`, `示範Codex AI · Codex · ${GPT}`, '示範AG AI · Antigravity · 模型不明', '小華 人']) assert.ok(chips.includes(c), `A ${tag} 現在符合的審查者標「AI · 工具 · 模型」：${c}｜${chips}`);
    assert.equal(await js("[...document.querySelectorAll('.rv-chip')].find(c => c.textContent.includes('示範AG')).querySelector('.rv-tag').className"), 'rv-tag unk', `A ${tag} 模型不明標黃`);
    assert.ok(!(await hscroll()), `C ${tag} 不橫向捲動`);
    await shot(`01-${tag}-審查設定-不限`);

    await pick('model');
    await until(() => js("!!document.querySelector('[data-rv-author]')"), 3000, 'A 不同模型：選作者');
    assert.equal(await js("document.querySelector('[data-rv-author]').selectedOptions[0].textContent"), `示範Codex · AI · Codex · ${GPT}`, `A ${tag} 預設挑第一位回報過模型的 AI`);
    await js(`(() => { const s = document.querySelector('[data-rv-author]'); s.value = ${JSON.stringify(pg.participantId)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await until(async () => (await cands()).some(x => x.includes('示範PG2')) && !(await cands()).some(x => x.startsWith('✓ 示範PG AI')), 3000, 'A 換作者');
    assert.deepEqual(await cands(), [`✓ 示範AG AI · Antigravity · 模型不明 模型不明，當作不一樣`, `✓ 示範Codex AI · Codex · ${GPT} 可以`, `✗ 示範PG2 AI · Claude · ${OPUS} 同一個模型`, `✓ 示範PO AI · Claude · ${SONNET} 可以`, '✓ 小華 人 人一律可以', '✓ 劉昱志 人 人一律可以'], `A ${tag} 不同模型：示範PG 寫的，誰可以審`);
    assert.equal(await js("document.querySelector('.rv-cands .rv-no s') !== null"), true, `A ${tag} 不符合的劃掉`);
    assert.ok(!(await hscroll()), `C ${tag} 不同模型不橫向捲動`);
    await js("document.querySelector('[data-rv-eligible-fold]')?.scrollIntoView({ block: 'center' }); true");
    await shot(`02-${tag}-審查設定-不同模型`);

    await pick('vendor');
    await until(async () => (await cands()).some(x => x.includes('同一家')), 3000, 'A 不同家');
    assert.deepEqual(await cands(), [`✓ 示範AG AI · Antigravity · 模型不明 模型不明，當作不一樣`, `✓ 示範Codex AI · Codex · ${GPT} 可以`, `✗ 示範PG2 AI · Claude · ${OPUS} 同一家`, `✗ 示範PO AI · Claude · ${SONNET} 同一家`, '✓ 小華 人 人一律可以', '✓ 劉昱志 人 人一律可以'], `A ${tag} 不同家：示範PG 寫的，誰可以審`);
    assert.ok(!(await hscroll()), `C ${tag} 不同家不橫向捲動`);
    await js("document.querySelector('[data-rv-eligible-fold]')?.scrollIntoView({ block: 'center' }); true");
    await shot(`03-${tag}-審查設定-不同家`);
  }
  await click('[data-rv-save]');
  await until(async () => (await call(liu.token, SET)).body.settings.differ === 'vendor', 5000, 'A 儲存');
  assert.equal((await call(liu.token, SET)).body.log[0].text, '審查者要多不一樣：不限 → 不同家', 'A 儲存寫審查紀錄');

  // ---------- B 卡片審查欄 ----------
  const openDrawer = async key => {
    await login(liu.token, '/p/main/work');
    await until(() => js(`!!document.querySelector('[data-card="${key}"]')`), 15000, '工作頁卡片');
    await js(`document.querySelector('[data-card="${key}"]').click(); true`);
    await until(() => js("!!document.querySelector('#card-drawer .rv-box')"), 8000, '審查欄');
    await js("document.querySelector('#card-drawer .rv-box').scrollIntoView({ block: 'center' }); true");
  };
  // 不同家：Claude 寫、Codex 審
  const Kv = await mkCard('報價單匯出加上幣別欄');
  assert.equal((await request(Kv, { reviewerId: cx.participantId })).status, 200, 'B 送審（不同家）');
  assert.equal((await review(cx.token, Kv, { model: GPT, comment: '可以。' })).status, 200, 'B 通過（不同家）');
  // 不同模型：Opus 寫、Sonnet 審；作者送審後換模型，紀錄照舊
  await call(liu.token, SET, 'PUT', { differ: 'model' });
  const Km = await mkCard('報價單加上匯率換算');
  assert.equal((await request(Km, { reviewerId: po.participantId })).status, 200, 'B 送審（不同模型）');
  await call(pg.token, '/api/me/model', 'PUT', { model: 'claude-fable-5-2' });
  assert.equal((await review(po.token, Km, { model: SONNET })).status, 200, 'B 通過（不同模型）');
  // 模型不明的 AI 審
  const Ku = await mkCard('匯出檔名加日期');
  await call(pg.token, '/api/me/model', 'PUT', { model: OPUS });
  assert.equal((await request(Ku, { reviewerId: ag.participantId })).status, 200, 'B 送審（模型不明的審查者）');
  assert.equal((await review(ag.token, Ku, {})).status, 200, 'B 通過（模型不明）');
  // 不限：不寫規則那行
  await call(liu.token, SET, 'PUT', { differ: 'any' });
  const Ka = await mkCard('匯出加總列');
  await request(Ka, { reviewerId: pg2.participantId });
  await review(pg2.token, Ka, { model: OPUS });

  for (const [w, h, tag] of sizes) {
    await size(w, h);
    await call(liu.token, SET, 'PUT', { differ: 'model' });
    await openDrawer(Km);
    const box = await text('#card-drawer .rv-box');
    assert.match(box, new RegExp(`^審查與程式變更 ✅ 已審查 程式卡 示範PO AI · Claude · ${SONNET} 通過 a1b2c3d · .+ 專案規則：不同模型。寫的是 ${OPUS}、審的是 ${SONNET}，符合。 下一步：整合上線；要上線的 SHA 跟審過的不同就要重審。 ${w === 375 ? '程式變更請在電腦上看' : '看程式變更 ›'} 歷次紀錄 .+ · 通過 · 示範PO · Claude · ${SONNET} · a1b2c3d .+ · 送審 · 示範PG · Claude · ${OPUS} · a1b2c3d$`), `B ${tag} 不同模型：審查者帶模型、規則說明、歷次紀錄（作者之後換模型不影響）｜${box}`);
    assert.ok(!(await hscroll()), `C ${tag} 卡片不橫向捲動`);
    await shot(`04-${tag}-卡片-不同模型`);
    await openDrawer(Ku);
    const unk = await text('#card-drawer .rv-box');
    assert.match(unk, /^審查與程式變更 ✅ 已審查 程式卡 示範AG AI · Antigravity · 模型不明 通過 a1b2c3d · .+ 這隻 AI 沒回報模型，當作跟作者不一樣。 下一步/, `B ${tag} 模型不明｜${unk}`);
    assert.equal(await js("document.querySelector('#card-drawer .rv-box .rv-tag').className"), 'rv-tag unk', `B ${tag} 模型不明標黃`);
    await shot(`05-${tag}-卡片-模型不明`);
    await call(liu.token, SET, 'PUT', { differ: 'vendor' });
    await openDrawer(Kv);
    assert.match(await text('#card-drawer .rv-box'), new RegExp(`示範Codex AI · Codex · ${GPT} 通過 a1b2c3d · .+ 專案規則：不同家。寫的是 Claude、審的是 Codex，符合。 意見：可以。`), `B ${tag} 不同家的規則說明`);
    await call(liu.token, SET, 'PUT', { differ: 'any' });
    await openDrawer(Ka);
    assert.equal(await js("document.querySelectorAll('#card-drawer .rv-rule').length"), 0, `B ${tag} 不限時不寫規則那行`);
    assert.match(await text('#card-drawer .rv-box'), new RegExp(`示範PG2 AI · Claude · ${OPUS} 通過`), `B ${tag} 不限時照樣標模型`);
  }

  // ---------- D 團隊頁 AI 詳情：工具・模型（幾點、什麼時候回報）；列表不顯示 ----------
  const teamDetail = async who => js(`(() => {
    const row = document.querySelector('.project-member[data-tm-id="${who.participantId}"]');
    if (!row.open) row.querySelector('summary').click();
    return { summary: row.querySelector('summary').innerText.replace(/\\s+/g, ' ').trim(), text: row.querySelector('section').innerText.replace(/\\s+/g, ' ').trim(), unk: row.querySelector('section .rv-tag.unk')?.textContent || '' };
  })()`);
  for (const [w, h, tag] of sizes) {
    await size(w, h);
    await login(liu.token, '/p/main/team');
    await until(() => js(`!!document.querySelector('.project-member[data-tm-id="${cx.participantId}"]')?.getClientRects().length`), 15000, 'D 團隊頁');
    const c = await teamDetail(cx);
    assert.match(c.text, new RegExp(`工具・模型：Codex · ${GPT.replace(/\./g, '\\.')}（\\d+/\\d+ \\d+:\\d+ 審查時回報）`), `D ${tag} 工具・模型（審查時回報）：${c.text}`);
    assert.ok(!c.summary.includes(GPT), `D ${tag} 列表不顯示模型：${c.summary}`);
    const a = await teamDetail(ag);
    assert.ok(a.text.includes('工具・模型：Antigravity · 模型不明 這隻 AI 還沒回報模型，更新接入後會自動帶上。') && a.unk === '模型不明', `D ${tag} 模型不明標黃：${a.text}`);
    assert.ok(!(await hscroll()), `C ${tag} 團隊頁不橫向捲動`);
    await js(`document.querySelector('.project-member[data-tm-id="${ag.participantId}"]').scrollIntoView({ block: 'center' }); true`);
    await shot(`08-${tag}-團隊頁-AI詳情`);
  }

  // ---------- F 英文介面（UX 文字 v1.2 的英文） ----------
  await size(1280, 900);
  await call(liu.token, SET, 'PUT', { differ: 'model' });
  await login(liu.token, '/');
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  const enReady = () => until(() => js("document.documentElement.lang === 'en' && !document.documentElement.classList.contains('i18n-wait')"), 15000, 'F 英文介面');
  await openSettings();
  await enReady();
  await sleep(400);
  assert.equal(await rowText('How different'), 'How different Any Anyone but the author (default) Different model Same vendor OK; versions count as different Different vendor e.g. Claude writes, Codex reviews', 'F 三段的英文');
  assert.ok(await js("document.querySelector('[data-rv-set=\"notOwner\"]')?.getAttribute('role') === 'switch'"), 'F 作者的主人英文是開關');
  await click('[data-rv-eligible-fold] summary');
  await until(() => js("!!document.querySelector('[data-rv-author]')"), 3000, 'F 展開作者選單');
  await js(`(() => { const s = document.querySelector('[data-rv-author]'); s.value = ${JSON.stringify(pg.participantId)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await until(async () => (await cands()).some(x => x.includes('Same model')), 5000, 'F 換作者（英文）');
  const enC = (await cands()).join('｜');
  for (const w of [`✗ 示範PG2 AI · Claude · ${OPUS} Same model`, '✓ 示範AG AI · Antigravity · Model unknown Model unknown, counts as different', '✓ 小華 Person People always qualify']) assert.ok(enC.includes(w), `F 誰可以審（英文）：${w}｜${enC}`);
  assert.ok(!/[㐀-鿿]/.test(enC.replace(/示範\w+|小華|劉昱志/g, '')), 'F 誰可以審沒有剩中文：' + enC);
  await js("document.querySelector('[data-rv-eligible-fold]')?.scrollIntoView({ block: 'center' }); true");
  await shot('06-1280-英文-審查設定');
  await openDrawer(Km);
  await enReady();
  await sleep(400);
  const enBox = await text('#card-drawer .rv-box');
  assert.ok(enBox.includes(`Project rule: different model. Written with ${OPUS}, reviewed with ${SONNET}: OK.`), 'F 規則說明（英文）：' + enBox);
  assert.ok(!/[㐀-鿿]/.test(enBox.replace(/示範\w+/g, '')), 'F 卡片審查欄沒有剩中文：' + enBox);
  await openDrawer(Ku);
  await enReady();
  await sleep(400);
  const enUnk = await text('#card-drawer .rv-box');
  assert.ok(enUnk.includes("示範AG AI · Antigravity · Model unknown") && enUnk.includes("This AI didn't report its model, so it counts as different from the author."), 'F 模型不明（英文）：' + enUnk);
  await shot('07-1280-英文-卡片模型不明');
  await login(liu.token, '/p/main/team');
  await enReady();
  await until(() => js(`!!document.querySelector('.project-member[data-tm-id="${cx.participantId}"]')?.getClientRects().length`), 15000, 'F 團隊頁（英文）');
  await sleep(400);
  const ec = await teamDetail(cx), ea = await teamDetail(ag);
  assert.match(ec.text, new RegExp(`Tool · model: Codex · ${GPT.replace(/\./g, '\\.')} \\(reported at \\d+/\\d+ \\d+:\\d+ when reviewing\\)`), 'F 工具・模型（英文）：' + ec.text);
  assert.ok(ea.text.includes("Tool · model: Antigravity · Model unknown This AI hasn't reported a model yet. It will once its setup is updated."), 'F 模型不明（英文）：' + ea.text);

  console.log('review-model-ui-test：全部通過（團隊頁 AI 詳情工具・模型、英文、審查者要多不一樣三段、選作者看誰可以審（劃掉寫原因）、AI · 工具 · 模型、卡片規則說明與模型不明、歷次紀錄帶工具與模型、1280／375 不橫向捲動）');
} finally {
  await kit.stop();
}
