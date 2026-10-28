// 平台自動通知的英文顯示
// 1. 伺服器：平台依固定句型自動發的通知（卡片異動、決策、暫緩、交接、退回、接手、刪除 AI）帶 auto: true；成員自己發的訊息沒有
// 2. 英文介面：這些通知整句換成英文，人名、卡號、標題、專案名、使用者寫的原因照原文，不留其他中文；開頭的協定標籤不翻
// 3. 中文介面原文不動；對不上固定句型的照原文
// 4. 瀏覽器：英文介面的訊息頁看到英文、中文介面看到原文；存進資料庫的內容不變
// 用法：node scripts/i18n-auto-test.js
import fs from 'node:fs';
import assert from 'node:assert';
import { loadEn } from './i18n-scan.js';
import { startKit, until, sleep } from './browser-kit.js';

// 在 node 裡跑 public/i18n/i18n.js（假的瀏覽器環境），拿到 aigileI18n
function loadI18n(lang) {
  const src = fs.readFileSync(new URL('../public/i18n/i18n.js', import.meta.url), 'utf8');
  const script = {}, win = {};
  const doc = { documentElement: { lang: '', classList: { add() {}, remove() {} } }, addEventListener() {}, createElement: () => script, head: { append() {}, querySelector: () => null }, body: null };
  new Function('window', 'document', 'localStorage', 'navigator', 'location', 'MutationObserver', src)(
    win, doc, { getItem: () => lang, setItem() {} }, { language: 'zh-TW' }, { reload() {} }, class { observe() {} });
  if (lang === 'en') { win.AIGILE_EN = loadEn(); script.onload(); }
  return win.aigileI18n;
}
const en = loadI18n('en'), zh = loadI18n('zh');
const HAN = /[㐀-鿿]|[：（）「」；，、。]/;
// 去掉照原文的部分後，不能再有中文或全形標點
function onlyEnglish(out, keep, label) {
  let rest = out.replace(/^\s*\[[^\]\n]{1,40}\]\s?/, '');
  for (const k of [...keep].sort((a, b) => b.length - a.length)) rest = rest.split(k).join('');
  assert.ok(!HAN.test(rest), `${label}：英文裡還有中文 → ${out}`);
}

const kit = await startKit('i18nauto');
try {
  // ---------- 1. 實際觸發各種自動通知 ----------
  const P = '預設專案';
  const join = async (name, role) => (await kit.call(null, '/api/join', 'POST', { name, role })).body;
  const boss = await join('林志明', 'PO'), mate = await join('陳大文', 'PG');
  const M = mate.participant.participantId, B = boss.participant.participantId;
  assert.equal((await kit.call(boss.token, `/api/participants/${M}/projects`, 'PUT', { projects: [P] })).status, 200);
  const S = { duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
  const mkAi = async (name, roleKey) => (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: [P], roleKey, role: roleKey === 'PO' ? '產品負責人' : '程式開發', name, ...S })).body;
  const ai = await mkAi('開發助手', 'PG'), po = await mkAi('產品助手', 'PO'), gone = await mkAi('暫時助手', 'PG');
  const aiTok = kit.aiToken(ai.participantId), goneTok = kit.aiToken(gone.participantId);
  let n = 0;
  const card = async (tok, body) => { const r = await kit.call(tok, '/api/cards', 'POST', { project: P, requestId: 'rq' + ++n, ...body }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const get = async id => (await kit.call(boss.token, `/api/cards/${id}`)).body;
  const ok = async (r, label) => { const x = await r; assert.ok(x.status < 300, `${label}：${x.status} ${JSON.stringify(x.body)}`); return x.body; };

  const c1 = await card(boss.token, { title: '首頁改版：第二版', ownerId: M }); // 標題裡有全形冒號
  const c2 = await card(boss.token, { title: '要不要上線', type: '決策', deciderId: M, question: '要上線嗎？', options: ['上線', '再等等'] });
  const c3 = await card(boss.token, { title: '寫測試', waitForId: M });
  await ok(kit.call(mate.token, `/api/cards/${c2.cardId}/decide`, 'POST', { result: '上線', note: '先上測試站' }), '決定');
  const c4 = await card(boss.token, { title: '補文件', type: '決策', deciderId: M, options: ['好'] });
  await ok(kit.call(mate.token, `/api/cards/${c4.cardId}/decide`, 'POST', { result: '要求補充', note: '附上截圖' }), '要求補充');
  const c5 = await card(boss.token, { title: '換主機', type: '決策', deciderId: M, options: ['換'] });
  await ok(kit.call(mate.token, `/api/cards/${c5.cardId}/defer`, 'POST', { reason: '等報價' }), '暫緩');
  await ok(kit.call(mate.token, `/api/cards/${c5.cardId}/resume`, 'POST', {}), '恢復');
  const c6 = await card(boss.token, { title: '整理需求' });
  await ok(kit.call(boss.token, `/api/cards/${c6.cardId}`, 'PATCH', { ownerId: M, version: c6.version }), '改負責人');
  const c6b = await get(c6.cardId);
  await ok(kit.call(mate.token, `/api/cards/${c6.cardId}`, 'PATCH', { waitForId: B, blocker: '缺帳號', version: c6b.version }), '等誰');
  const c7 = await card(boss.token, { title: '登入頁' });
  await ok(kit.call(boss.token, `/api/cards/${c7.cardId}/handover`, 'POST', { toId: ai.participantId, progress: '畫面做好', nextStep: '接 API', caution: '別動樣式' }), '交接給 AI');
  await ok(kit.call(aiTok, `/api/cards/${c7.cardId}/handover`, 'POST', { toId: M, progress: '做完了', nextStep: '請驗收' }), 'AI 交給人類驗收');
  await ok(kit.call(mate.token, `/api/cards/${c7.cardId}/reject`, 'POST', { reason: '按鈕沒反應' }), '退回');
  const c8 = await card(boss.token, { title: '修錯字' });
  await ok(kit.call(aiTok, `/api/cards/${c8.cardId}/takeover`, 'POST', {}), 'AI 認領');
  await ok(kit.call(mate.token, `/api/cards/${c8.cardId}/takeover`, 'POST', { reason: '我比較熟' }), '接手');
  await card(goneTok, { title: '暫時的卡', ownerId: gone.participantId });
  await ok(kit.call(boss.token, `/api/my-ais/${gone.participantId}/delete`, 'POST', { confirmName: '暫時助手' }), '刪除 AI');
  await ok(kit.call(boss.token, '/api/messages', 'POST', { project: P, requestId: 'human1', text: '[通知] 首頁改版：建立卡片', recipientIds: [] }), '成員自己發');

  const all = [];
  for (const tok of [boss.token, po.participantId && kit.aiToken(po.participantId)]) {
    const r = await kit.call(tok, '/api/messages?limit=100');
    if (!Array.isArray(r.body.items)) throw new Error('讀訊息失敗：' + r.status + JSON.stringify(r.body));
    for (const m of r.body.items) if (!all.some(x => x.messageId === m.messageId)) all.push(m);
  }
  const autos = all.filter(m => m.auto);
  const human = all.find(m => m.text === '[通知] 首頁改版：建立卡片');
  assert.ok(human && !human.auto, '成員自己發的訊息沒有 auto（就算長得像也不翻）');
  const has = re => autos.find(m => re.test(m.text));
  const expect = {
    建卡負責人: /建立卡片，負責人 陳大文$/, 建卡等決定: /建立卡片，等 陳大文 決定$/, 建卡等誰: /建立卡片，等 陳大文$/,
    決定: /決定「上線」：先上測試站$/, 要求補充: /要求補充：附上截圖$/, 暫緩: /暫緩（陳大文）：等報價$/, 恢復: /已恢復，回到待確認$/,
    改負責人: /負責人改為 陳大文$/, 等誰: /等 林志明：缺帳號$/, 交接: /^\[交接\][\s\S]*等 開發助手 接手/, 驗收: /^\[交接\][\s\S]*等你驗收/,
    退回: /^\[退回\]/, 接手: /陳大文 接手，@開發助手/, 刪除AI: /AI「暫時助手」已被刪除/,
  };
  for (const [k, re] of Object.entries(expect)) assert.ok(has(re), `有「${k}」的自動通知（auto: true）：\n${autos.map(m => m.text).join('\n')}`);
  console.log(`✓ 伺服器：${autos.length} 則自動通知帶 auto，成員自己發的沒有`);

  // ---------- 2. 英文：整句換英文，照原文的只剩人名、卡號、標題、專案名、使用者寫的字 ----------
  const keep = ['林志明', '陳大文', '開發助手', '暫時助手', '產品助手', '首頁改版：第二版', '要不要上線', '寫測試', '補文件', '換主機', '整理需求', '登入頁', '修錯字',
    '上線', '先上測試站', '附上截圖', '等報價', '缺帳號', '畫面做好', '接 API', '別動樣式', '做完了', '請驗收', '按鈕沒反應', '我比較熟', `【${P}】`, '【All projects】'];
  for (const m of autos) {
    const out = en.autoMsg(m.text);
    assert.notEqual(out, m.text, `英文有換：${m.text}`);
    assert.equal(out.match(/^\s*\[[^\]]+\]/)?.[0], m.text.match(/^\s*\[[^\]]+\]/)?.[0], `協定標籤照原文：${out}`);
    onlyEnglish(out, keep, m.text);
    for (const id of m.text.match(/\b[A-Z]{2,5}-\d+\b/g) || []) assert.ok(out.includes(id), `卡號 ${id} 還在：${out}`);
    for (const at of m.text.match(/@(開發助手|陳大文)/g) || []) assert.ok(out.includes(at), `@ 名字還在（才會變成提及）：${out}`);
  }
  const show = re => en.autoMsg(has(re).text);
  assert.match(show(expect.建卡等決定), /created this card, waiting for 陳大文 to decide$/);
  assert.match(show(expect.決定), /decided "上線": 先上測試站$/);
  assert.match(show(/首頁改版：第二版/), /首頁改版：第二版: created this card, owner 陳大文$/, '標題裡的全形冒號不會被當成分隔');
  assert.match(show(expect.交接), /status Triage → To do, waiting for 開發助手 to pick it up\)\n• Progress: 畫面做好\n• Next step: 接 API\n• Caution: 別動樣式$/);
  assert.match(show(expect.刪除AI), /^\[通知\] 【All projects】AI "暫時助手" was deleted\. Its cards are unassigned now \(back to To do\), 1 card: MAIN-9\./);
  if (process.env.SHOW) for (const m of autos) console.log(en.autoMsg(m.text));
  console.log('✓ 英文：' + autos.length + ' 則都換成英文，人名、卡號、標題、原因照原文');

  // 平台其他固定句型（leader 調整成員、批次採用建議、邀請加入）
  const extra = [
    ['[通知] 【網站】王小明（網站 leader）把 李四 加入網站；把 張三 移出網站（2 張卡退回待處理）', '[通知] 【網站】王小明 (網站 leader): added 李四 to 網站; removed 張三 from 網站 (2 cards returned to To do)'],
    ['[通知] 批次採用了 AI 建議，與你有關的 2 張卡：WEB-1、WEB-2', '[通知] Adopted AI suggestions in a batch. Cards involving you (2): WEB-1, WEB-2'],
    ['[通知] 李四 已加入（網站 PG，專案：網站、後台）', '[通知] 李四 joined (網站 PG, projects: 網站, 後台)'],
    ['[通知] 李四 已加入（還沒有專案）', '[通知] 李四 joined (no projects yet)'],
    ['[通知] 李四 已用新的邀請連結重新登入', '[通知] 李四 signed in again with a new invite link'],
    ['[通知] 【網站】WEB-3 修 bug：採用了 開發助手 的建議：狀態改為 進行中', '[通知] 【網站】WEB-3 修 bug: adopted 開發助手\'s suggestion: status changed to In progress'],
  ];
  for (const [zhText, want] of extra) assert.equal(en.autoMsg(zhText), want);
  // 對不上的照原文；中文介面不動
  for (const t of ['[通知] 隨便寫的一句話', '沒有標籤：建立卡片', '']) assert.equal(en.autoMsg(t), t, `對不上就照原文：${t}`);
  for (const m of autos) assert.equal(zh.autoMsg(m.text), m.text, '中文介面不動');
  // 卡片「等誰」那欄（不是自動通知，走一般字典）
  assert.equal(en.tr('等你'), 'Waiting on you');
  assert.equal(en.tr('等你：設計稿還沒來'), 'Waiting on you: 設計稿還沒來');
  assert.equal(en.tr('等 王小明'), 'Waiting on 王小明');
  assert.equal(en.tr('等 王小明：設計稿還沒來'), 'Waiting on 王小明: 設計稿還沒來');
  console.log('✓ 其他句型、對不上照原文、中文介面不動');

  // ---------- 3. 瀏覽器：英文看到英文、中文看到原文 ----------
  const target = has(expect.建卡等決定);
  const { js, cdp, login } = await kit.browser(1280, 900);
  await login(mate.token, '/p/main/messages');
  const texts = async lang => {
    await js(`localStorage.setItem('aigile-lang', '${lang}'); true`);
    await cdp('Page.reload');
    await until(() => js(`document.documentElement.lang === '${lang === 'en' ? 'en' : 'zh-Hant'}'`), 15000, '換語言');
    await until(() => js(`document.querySelectorAll('.msg-text').length > 3`), 30000, '訊息'); // 全套同時跑時比較慢
    await sleep(800);
    return js(`document.getElementById('messages').innerText`);
  };
  const enPage = await texts('en');
  assert.ok(enPage.includes('created this card, waiting for 陳大文 to decide'), '英文介面看到英文通知');
  assert.ok(!enPage.includes('建立卡片，等 陳大文 決定'), '英文介面不再顯示中文句型');
  assert.ok(await js("[...document.querySelectorAll('.gmsg')].every(g => !(g.querySelector('.gm-head .lead') && g.querySelector('.msg-text .lead')))"), '卡片分組裡名字旁有標籤，內文不再放一次');
  assert.ok(!(await js("[...document.querySelectorAll('.lead')].map(e => e.textContent).join(' ')")).match(/[通知交接退回]/), '小標籤在英文介面是英文');
  assert.ok(enPage.includes('[通知] 首頁改版：建立卡片') || enPage.includes('首頁改版：建立卡片'), '成員自己發的照原文');
  const zhPage = await texts('zh');
  assert.ok(zhPage.includes('建立卡片，等 陳大文 決定'), '中文介面看到原文');
  const stored = (await kit.call(boss.token, `/api/messages/${target.messageId}`)).body.text;
  assert.equal(stored, target.text, '存進資料庫的內容不變');
  console.log('✓ 瀏覽器：英文介面顯示英文、中文介面原文；資料庫不變');
  console.log('i18n-auto-test 通過');
} catch (e) {
  console.error('i18n-auto-test 失敗：', e.message);
  process.exitCode = 1;
} finally { await kit.stop(); }
