// 建議的選項才是主按鈕：決策卡看「建議方案」、[需確認] 看「建議：A」或（我建議）
// 規則：剛好只對到一個選項才標「建議」；對不到或對到多個就全部同一種樣式（不再是第一個選項當綠色主按鈕）
// 用法：node scripts/recommend-test.js（找不到 Chrome／Edge 就只跑比對規則）
import fs from 'node:fs';
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

// 一、比對規則：從 app.js 抓出來跑
const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const cut = (a, b) => { const s = src.indexOf(a), e = src.indexOf(b, s); assert.ok(s > 0 && e > s, '找不到 ' + a); return src.slice(s, e); };
const { recommendedIndex, questionRecs, parseQuestions } = new Function(
  cut('  const normRec = ', '  const REC_TAG = ') + cut('  const OPT_LETTER = ', '  function quickHtml(m) {') + '; return { recommendedIndex, questionRecs, parseQuestions };')();

const opts = ['做模糊比對', '先不做'];
assert.equal(recommendedIndex('先不做，等資料量大再說', opts), 1, '對到一個：先不做');
assert.equal(recommendedIndex('照原本的方式處理', opts), -1, '對不到：全部同一種');
assert.equal(recommendedIndex('做模糊比對或先不做都可以', opts), -1, '對到多個：全部同一種');
assert.equal(recommendedIndex('', opts), -1, '沒寫建議');
assert.equal(recommendedIndex(undefined, ['同意']), -1, '沒寫建議、只有「同意」');
assert.equal(recommendedIndex('先不上線，下週再說', ['上線', '先不上線']), 1, '「上線」被「先不上線」包住：算後者');
assert.equal(recommendedIndex('改存 r2，比較便宜', ['同意', '改存 R2']), 1, '大小寫、空白不影響');
assert.equal(recommendedIndex('否，因為還沒測完', ['是', '否']), 1, '單字選項：開頭就是它');
assert.equal(recommendedIndex('這是我的看法，否決也行', ['是', '否']), -1, '單字選項：只出現在句子裡不算');

const recs = t => questionRecs(t, parseQuestions(t));
assert.deepEqual(recs('[需確認] 要開新帳號嗎？\n選項：\nA. 開\nB. 先不要\n建議：B'), ['B'], '「建議：B」');
assert.deepEqual(recs('[需確認] 要開新帳號嗎？\n選項：\nA. 開新帳號\nB. 先不要\n建議：先不要，等下週'), ['B'], '「建議：」寫選項名稱');
assert.deepEqual(recs('[需確認] 怎麼做？\n選項：\nA. 不公開（我建議）\nB. 公開'), ['A'], '選項後面寫（我建議）');
assert.deepEqual(recs('[需確認] 要開新帳號嗎？\n選項：\nA. 開\nB. 先不要'), [null], '沒寫建議');
assert.deepEqual(recs('[需確認] 要開新帳號嗎？\n選項：\nA. 開新帳號\nB. 先不要\n建議：再想想'), [null], '對不到');
assert.deepEqual(recs('[需確認] 怎麼做？\n選項：\nA. 不公開（我建議）\nB. 公開（建議）'), [null], '對到多個');
assert.deepEqual(recs('[需確認] 怎麼做？\n選項：\nA. 不公開（我建議）\nB. 公開\n建議：B'), [null], '標記和建議行打架：全部同一種');
assert.deepEqual(recs('[需確認] 兩件事\n問題1：做嗎？\n選項：\nA. 做\nB. 不做\n建議：A\n\n問題2：哪天？\n選項：\nA. 今天\nB. 明天\n建議：明天'), ['A', 'B'], '多題各看自己的建議');
assert.deepEqual(recs('[需確認] 兩件事\n問題1：做嗎？\n選項：\nA. 做\nB. 不做\n\n問題2：哪天？\n選項：\nA. 今天\nB. 明天\n建議：B'), [null, 'B'], '多題：建議只算在它那題');
console.log('recommend-test：比對規則通過');

// 二、畫面：桌機與 375 都看得到哪個是建議
if (!findBrowser()) { console.log('recommend-test：畫面略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('t1');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const L = boss.participant.participantId;
  const ai = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = kit.aiToken(ai.participantId);
  const dec = async (title, recommendation) => {
    const r = await kit.call(tok, '/api/cards', 'POST', { requestId: 'd' + title, project: '預設專案', type: '決策', title, question: '要不要做？', recommendation, options: ['做模糊比對', '先不做'], impact: 'x', afterNext: 'x', deciderId: L });
    assert.ok(r.body.cardId, JSON.stringify(r.body)); return r.body.cardId;
  };
  const one = await dec('對到一個', '先不做，等資料量大再說'), none = await dec('對不到', '照原本的方式'), many = await dec('對到多個', '做模糊比對或先不做都可以');
  const msg = async (id, text) => (await kit.call(tok, '/api/messages', 'POST', { requestId: id, project: '預設專案', text, recipientIds: [L] })).body.messageId;
  const qOne = await msg('q1', '[需確認] 要開新帳號嗎？\n選項：\nA. 開\nB. 先不要\n建議：B');
  const qNone = await msg('q2', '[需確認] 要換主機嗎？\n選項：\nA. 換\nB. 不換');
  // 同仁（人類）發的 [需確認] 也有選項按鈕；自己發的不給自己按
  const mate = (await kit.call(null, '/api/join', 'POST', { name: '陳美玲', role: 'UX' })).body;
  await kit.call(boss.token, '/api/members/matrix', 'PUT', { changes: [{ id: mate.participant.participantId, projects: ['預設專案'] }] });
  const qHuman = (await kit.call(mate.token, '/api/messages', 'POST', { requestId: 'q3', project: '預設專案', text: '[需確認] 首頁要用哪一版？\n選項：\nA. 藍色版\nB. 橘色版\n建議：A', recipientIds: [L], replyFrom: [L] })).body.messageId;
  const qMine = (await kit.call(boss.token, '/api/messages', 'POST', { requestId: 'q4', project: '預設專案', text: '[需確認] 下週要開會嗎？\n選項：\nA. 開\nB. 不開', recipientIds: [mate.participant.participantId], replyFrom: [mate.participant.participantId] })).body.messageId;
  assert.ok(qHuman && qMine, '同仁與自己的 [需確認] 發送成功');
  const { js, login, cdp } = await kit.browser(1400, 900);

  // 讀出某張決策卡／某則 [需確認] 的選項按鈕：哪些是綠色主按鈕、哪些有「建議」標籤、標籤看不看得到
  const decBtns = id => js(`JSON.stringify([...document.querySelectorAll('[data-inl-root="c:${id}"] [data-inl-act="decide"][data-result]')].filter(b => b.offsetParent && /^決定「/.test(b.textContent)).map(b => { const t = b.querySelector('.rec-tag'); return { r: b.dataset.result, ok: b.classList.contains('ok'), tag: !!t, seen: !!t && t.getBoundingClientRect().width > 0 && getComputedStyle(t).visibility !== 'hidden', bg: getComputedStyle(b).backgroundColor }; }))`).then(JSON.parse);
  const qBtns = id => js(`JSON.stringify([...document.querySelectorAll('[data-q-root="${id}"] .q-opt')].filter(b => b.offsetParent).map(b => { const t = b.querySelector('.rec-tag'); return { k: b.dataset.qOpt, rec: b.classList.contains('rec'), seen: !!t && t.getBoundingClientRect().width > 0, bw: getComputedStyle(b).borderTopWidth }; }))`).then(JSON.parse);
  const openInl = async key => { await js(`document.querySelector('[data-inl-open="${key}"]')?.click(); true`); };

  for (const w of [1280, 375]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 });
    await login(boss.token, '/p/%E9%A0%90%E8%A8%AD%E5%B0%88%E6%A1%88/inbox');
    await until(() => js(`!!document.querySelector('[data-inl-root="c:${one}"], [data-inl-open="c:${one}"]')`), 15000, w + ' 收件匣決策卡');
    const L1 = w + 'px ';
    for (const [id, want] of [[one, '先不做'], [none, null], [many, null]]) {
      await openInl('c:' + id);
      await until(() => js(`!!document.querySelector('[data-inl-root="c:${id}"]')`), 5000, L1 + '展開 ' + id);
      const b = await decBtns(id);
      assert.equal(b.length, 2, L1 + '兩個選項按鈕：' + JSON.stringify(b));
      if (want) {
        assert.deepEqual(b.map(x => x.ok), b.map(x => x.r === want), L1 + '只有建議的是主按鈕：' + JSON.stringify(b));
        assert.ok(b.find(x => x.r === want).seen && !b.find(x => x.r !== want).tag, L1 + '建議的有「建議」標籤且看得到');
        assert.notEqual(b[0].bg, b[1].bg, L1 + '主按鈕跟次要的顏色不同');
      } else {
        assert.ok(b.every(x => !x.ok && !x.tag), L1 + id + ' 沒對到：不設主按鈕、不標建議：' + JSON.stringify(b));
        assert.equal(b[0].bg, b[1].bg, L1 + id + ' 沒對到：同一種樣式');
      }
    }
    await until(() => js(`!!document.querySelector('[data-q-root="${qOne}"] .q-opt')`), 8000, L1 + '[需確認] 選項');
    const q1 = await qBtns(qOne), q2 = await qBtns(qNone);
    assert.deepEqual(q1.map(x => x.rec), [false, true], L1 + '[需確認] 建議：B → 只有 B 標建議：' + JSON.stringify(q1));
    assert.ok(q1[1].seen && q1[1].bw !== q1[0].bw, L1 + '[需確認] 建議的看得出來');
    assert.ok(q2.length === 2 && q2.every(x => !x.rec && !x.seen) && q2[0].bw === q2[1].bw, L1 + '[需確認] 沒寫建議：同一種樣式');
    await until(() => js(`!!document.querySelector('[data-q-root="${qHuman}"] .q-opt')`), 8000, L1 + '同仁發的 [需確認] 有選項按鈕');
    assert.deepEqual((await qBtns(qHuman)).map(x => x.rec), [true, false], L1 + '同仁發的 [需確認] 建議 A 有標示');
    if (w === 1280) {
      assert.ok(await js(`/等你回答的問題/.test(document.body.innerText) && !/AI 等你回答的問題/.test(document.body.innerText)`), L1 + '副標寫「等你回答的問題」');
      await js(`location.href = '/p/%E9%A0%90%E8%A8%AD%E5%B0%88%E6%A1%88/messages'; true`);
      await until(() => js(`!!document.getElementById('msg-${qMine}')`), 10000, L1 + '訊息頁看到自己發的 [需確認]');
      assert.equal(await js(`!!document.querySelector('#msg-${qMine} .q-opt')`), false, L1 + '自己發的 [需確認] 不給自己按鈕');
    }
    assert.ok(!(await js('document.documentElement.scrollWidth > innerWidth + 1')), L1 + '沒有橫向捲動');
  }
  console.log('recommend-test：全部通過');
} catch (e) {
  console.error('recommend-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
