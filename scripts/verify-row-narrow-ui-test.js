// 畫面測試（真的瀏覽器，390px）：「要你處理」頁「等你驗收」那列的按鈕都在卡片裡
// 修正前：英文「The AI hasn't submitted a report yet」＋ Verify ＋ Send back… ＋ View details 比中文長，
//         按鈕列不能縮也不換行，「Send back…」超出卡片右緣
// 修正後：窄畫面按鈕列佔滿一行、可以換行；中文版本來就排得下，維持一行
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/verify-row-narrow-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('verify-row-narrow-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('vrow');
try {
  const P = '預設專案';
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const a = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: [P], roleKey: 'PG', role: '程式開發', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = kit.aiToken(a.participantId);
  const card = (await kit.call(tok, '/api/cards', 'POST', { title: '活動頁手機版排版', type: '工作', project: P, ownerId: a.participantId, requestId: 'vrow1' })).body;
  assert.equal((await kit.call(tok, `/api/cards/${card.cardId}`, 'PATCH', { status: '待確認', waitForId: boss.participant.participantId, version: card.version })).status, 200);

  const { js, login } = await kit.browser(390, 844);
  const row = `document.querySelector('[data-ver-row="${card.cardId}"]')`;
  // 每個按鈕（和「還沒交回報」字）的左右都在那列裡；回傳各顆的 top，用來看排了幾行
  const measure = () => js(`(() => { const r = ${row}, box = r.getBoundingClientRect();
    const items = [...r.querySelectorAll('.sugg-actions > *')].map(e => { const b = e.getBoundingClientRect(); return { t: e.textContent.trim(), l: Math.round(b.left), r: Math.round(b.right), top: Math.round(b.top) }; });
    return JSON.stringify({ left: Math.round(box.left), right: Math.round(box.right), items, hscroll: document.documentElement.scrollWidth > innerWidth + 1 }); })()`).then(JSON.parse);

  for (const lang of ['zh', 'en']) {
    await login(boss.token, '/p/main/inbox');
    await js(`localStorage.setItem('aigile-lang', '${lang}'); location.reload(); true`);
    await until(() => js(`!!${row}`), 15000, `${lang}：等你驗收那列`);
    if (lang === 'en') await until(() => js(`${row}.textContent.includes('Send back')`), 15000, 'en：英文已套用');
    await sleep(300);
    const m = await measure();
    assert.ok(m.items.length >= 3, `${lang}：按鈕都在：` + JSON.stringify(m.items));
    for (const it of m.items) assert.ok(it.l >= m.left - 1 && it.r <= m.right + 1, `${lang}：「${it.t}」在那列裡（列 ${m.left}～${m.right}，按鈕 ${it.l}～${it.r}）`);
    assert.ok(!m.hscroll, `${lang}：沒有橫向捲動`);
    // 按鈕 44px、字比較矮，垂直置中後 top 會差幾 px；差 20px 以上才算換到下一行
    const rows = m.items.map(i => i.top).sort((x, y) => x - y).reduce((acc, t) => (t - acc.last > 20 ? { n: acc.n + 1, last: t } : acc), { n: 1, last: Math.min(...m.items.map(i => i.top)) }).n;
    if (lang === 'zh') assert.equal(rows, 1, 'zh：中文排得下，維持一行：' + JSON.stringify(m.items));
    console.log(`  ${lang}：${m.items.length} 個都在列內，排 ${rows} 行`);
  }
  console.log('verify-row-narrow-ui-test：全部通過');
} catch (e) {
  console.error('verify-row-narrow-ui-test 失敗：', e.message); process.exitCode = 1;
} finally { await kit.stop(); }
