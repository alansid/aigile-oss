// 英文介面（真的瀏覽器）：切成英文後主要畫面沒有殘留中文（人名、專案名、訊息內文這些資料除外）；訊息內文與協定標籤不翻；可切回中文並記住
// 用法：node scripts/i18n-ui-test.js（找不到 Chrome／Edge 就略過）
import assert from 'node:assert';
import { loadEn } from './i18n-scan.js';
const window_en_done = () => loadEn().dict['完成'];
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('i18n-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('i18n');
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  await kit.call(boss.token, '/api/me/password', 'PUT', { username: 'boss.lin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' });
  const ai = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name: '示範助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  assert.ok(ai.participantId, '建 AI');
  await kit.call(boss.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'req_i18n_1', text: '[完成] 測試訊息：登入頁改好了' });
  await kit.call(boss.token, '/api/cards', 'POST', { project: '預設專案', title: '整理首頁文案', type: '工作' });
  const DATA = ['林志明', '志明', '示範助手', '預設專案', '第二專案', '[完成] 測試訊息：登入頁改好了', '整理首頁文案', '中文'];

  const { js, cdp, login } = await kit.browser(1280, 900);
  // 畫面上看得到、又含中文的文字（排除訊息內文等不翻的區塊與上面的資料）
  const leftover = () => js(`(() => {
    const SKIP = '.msg-text,.msg-rest,.dm-text,.dmsg-text,.md-doc,.cr-title,.sw-text,code,pre,textarea,script,style,[data-nt]';
    const DATA = ${JSON.stringify(DATA)};
    const out = new Set();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue.replace(/\\s+/g, ' ').trim(), el = n.parentElement;
      if (!t || [...t].length === 1 || !/[\\u3400-\\u9fff]/.test(t) || !el || el.closest(SKIP) || !el.offsetParent) continue; // 一個字＝頭像（名字第一個字）
      let rest = t; for (const d of DATA) rest = rest.split(d).join('');
      if (/[\\u3400-\\u9fff]/.test(rest)) out.add(t);
    }
    for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) if (el.offsetParent && /[\\u3400-\\u9fff]/.test(el.placeholder)) out.add('placeholder：' + el.placeholder);
    return JSON.stringify([...out].slice(0, 30));
  })()`).then(JSON.parse);
  const check = async label => { await sleep(500); const l = await leftover(); assert.deepEqual(l, [], `${label} 還有中文：${l.join(' ｜ ')}`); };

  // 登入頁（英文）
  await cdp('Page.navigate', { url: kit.BASE + '/' });
  await until(() => js('document.readyState === "complete"'), 15000, '首頁');
  await js("localStorage.setItem('aigile-lang', 'en'); location.reload(); true");
  await until(() => js("!!document.querySelector('#pwd-form') && !document.documentElement.classList.contains('i18n-wait')"), 15000, '英文登入頁');
  assert.equal(await js('document.documentElement.lang'), 'en', 'html lang 跟著切換');
  assert.equal(await js("document.querySelector('#join-title').textContent.trim()"), 'Welcome back');
  await check('登入頁');
  // 單複數
  for (const [a, b] of [['1 members · 2 cards', '1 member · 2 cards'], ['1 new messages', '1 new message'], ['11 members', '11 members'], ['Humans: 1 online', 'Humans: 1 online'], ['10/1 members', '10/1 members']])
    assert.equal(await js(`aigileI18n.plural(${JSON.stringify(a)})`), b, `單複數：${a}`);
  // 登入失敗：伺服器錯誤顯示英文
  await js("document.querySelector('#pwd-form [name=username]').value = 'boss.lin'; document.querySelector('#pwd-form [name=password]').value = 'wrong-pass'; document.querySelector('#pwd-form [type=submit]').click(); true");
  await until(async () => !!(await js("document.querySelector('#pwd-error').textContent.trim()")), 8000, '登入失敗訊息');
  assert.ok(!/[㐀-鿿]/.test(await js("document.querySelector('#pwd-error').textContent")), '錯誤訊息是英文：' + await js("document.querySelector('#pwd-error').textContent"));

  // 主要畫面
  await login(boss.token, '/');
  await until(() => js("/^Good (morning|afternoon|evening), /.test(document.querySelector('.work-title h2')?.textContent || '')"), 15000, '總覽問候英文');
  assert.match(await js("document.querySelector('.work-title h2').textContent"), /, 林志明$/, '問候用全名');
  await check('總覽');
  assert.ok(await js("/\\b1 member · /.test(document.body.innerText)"), '總覽專案卡寫 1 member（單數）');
  for (const [path, sel, label] of [['/p/main/work', '.work-head', '工作'], ['/p/main/messages', '.msg-text', '訊息'], ['/my-ai', '#ai-list', '我的 AI'], ['/members', '.pm-tabs', '成員與權限']]) {
    await login(boss.token, path);
    await until(() => js(`!!document.querySelector(${JSON.stringify(sel)})`), 15000, label);
    await check(label);
  }
  // 訊息內文與協定標籤不翻
  await login(boss.token, '/p/main/messages');
  await until(() => js("!!document.querySelector('.msg-text')"), 15000, '訊息');
  // 協定標籤 [完成] 在畫面上是英文小標籤（只是顯示），內文照原文；存的內容還是 [完成]
  const en = window_en_done();
  assert.ok(await js(`[...document.querySelectorAll('.msg-text')].some(e => e.querySelector('.lead')?.textContent === ${JSON.stringify(en)} && e.textContent.includes('測試訊息：登入頁改好了'))`), '小標籤顯示英文、內文照原文');
  assert.ok((await kit.call(boss.token, '/api/messages?limit=50')).body.items.some(m => m.text.startsWith('[完成]') && m.text.includes('測試訊息：登入頁改好了')), '存的內容照原文');

  // 決策卡與 [需確認] 的選項、問題、建議是使用者寫的：剛好是字典裡的詞（上線＝Released）也照原文；按鈕上固定的字照樣英文
  const bossId = boss.participant.participantId;
  const dc = (await kit.call(boss.token, '/api/cards', 'POST', { requestId: 'i18n-dec', project: '預設專案', type: '決策', title: '上線時間', question: '上線', options: ['上線', '先不要'], recommendation: '上線', impact: '上線', afterNext: '上線', deciderId: bossId })).body;
  assert.ok(dc.cardId, JSON.stringify(dc));
  assert.ok((await kit.call(ai.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'i18n-q', text: '[需確認] 這週要不要上線？\n選項：\nA. 上線\nB. 先不要', recipientIds: [bossId], replyFrom: [bossId] })).status < 300, '[需確認] 發送');
  await login(boss.token, '/p/main/work');
  await until(() => js(`!!document.querySelector('[data-dcard="${dc.cardId}"] [data-inl-act="decide"]')`), 15000, '英文工作頁的決策卡');
  const dv = JSON.parse(await js(`JSON.stringify((() => { const c = document.querySelector('[data-dcard="${dc.cardId}"]'); return { btns: ['上線', '先不要'].map(o => c.querySelector('[data-inl-act="decide"][data-result="' + o + '"] [data-nt]')?.textContent), q: c.querySelector('h4').textContent, rec: c.querySelector('.dbox').textContent, dd: [...c.querySelectorAll('.dfields dd')].map(e => e.textContent).slice(2) }; })())`));
  assert.deepEqual(dv.btns, ['Decide "上線"', 'Decide "先不要"'], '選項照原文、Decide 是英文：' + JSON.stringify(dv));
  assert.equal(dv.q, '上線', '問題照原文');
  assert.match(dv.rec, /上線$/, '建議照原文：' + dv.rec);
  assert.deepEqual(dv.dd, ['上線', '上線'], '影響、決定後照原文');
  await js(`document.querySelector('[data-dcard="${dc.cardId}"] [data-result="上線"]').click(); true`);
  await until(async () => (await kit.call(boss.token, `/api/cards/${dc.cardId}`)).body.decision?.result === '上線', 8000, '決定');
  await login(boss.token, '/p/main/work');
  await until(() => js(`!!document.querySelector('[data-card="${dc.cardId}"]')`), 15000, '卡片列表');
  await js(`document.querySelector('[data-card="${dc.cardId}"]').click(); true`);
  await until(() => js("!!document.querySelector('.ddecision .dresult b')"), 8000, '卡片詳情的決定');
  assert.equal(await js("document.querySelector('.ddecision .dresult b').textContent"), `${loadEn().dict['決定：{0}'].replace('{0}', '上線')}`, '決定結果照原文');
  await login(boss.token, '/p/main/messages');
  await until(() => js("[...document.querySelectorAll('.q-opt')].length >= 2"), 15000, '[需確認] 選項按鈕');
  assert.deepEqual(JSON.parse(await js("JSON.stringify([...document.querySelectorAll('.q-opt span[data-nt]')].map(e => e.textContent))")), ['上線', '先不要'], '[需確認] 選項照原文');
  console.log('✓ 決策卡與 [需確認] 的選項、問題、建議照原文，固定的字是英文');

  // 頭像選單切回中文，重新整理後記住
  await js("document.querySelector('.av-btn').click(); true");
  await until(() => js("!!document.querySelector('#av-menu [data-lang=\"zh\"]')"), 5000, '頭像選單有中文選項');
  await js("document.querySelector('#av-menu [data-lang=\"zh\"]').click(); true");
  await until(() => js("document.documentElement.lang === 'zh-Hant' && document.readyState === 'complete'"), 15000, '切回中文');
  await until(() => js("!!document.querySelector('.av-btn')"), 15000, '中文主畫面');
  assert.equal(await js("localStorage.getItem('aigile-lang')"), 'zh');
  await js('location.reload(); true');
  await until(() => js("document.readyState === 'complete' && !!document.querySelector('.av-btn')"), 15000, '重新整理');
  assert.equal(await js('document.documentElement.lang'), 'zh-Hant', '記住中文');
  console.log('i18n-ui-test：全部通過');
} catch (e) {
  console.error('i18n-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
