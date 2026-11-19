// [需確認] 選項大家都能按；按的人不是 replyFrom 指定的人 → 先確認一次，回覆標「代答（按的人名字）」
// A. 非指定人照樣看得到、按得到選項
// B. 非指定人按送出先跳確認「這題是問 X 的，確定要代答嗎？」；取消不送出
// C. 送出的回覆在訊息與 API 都標「代答（名字）」，AI 收到的通知預覽也帶；已回覆區照樣標出選了哪個
// D. 規格寫明收到代答可照做、大事再請本人確認
// 本機暫存資料庫＋無頭 Chrome／Edge，不連正式站。用法：node scripts/ask-proxy-test.js [截圖資料夾]
import './test-home.mjs';
import assert from 'node:assert';
import fs from 'node:fs';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
assert.match(spec, /代答（名字）[^\n]{0,20}可照做[^\n]{0,10}大事再請本人確認/, 'D：規格寫明代答怎麼處理');

if (!findBrowser()) { console.log('ask-proxy-test：畫面略過（找不到 Chrome／Edge）'); process.exit(0); }
const SHOT = process.argv[2] || '';
const kit = await startKit('p335');
try {
  const liu = (await kit.call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body; liu.participantId = liu.participant.participantId;
  const percy = (await kit.call(null, '/api/join', 'POST', { name: 'Percy', role: 'UX' })).body; percy.participantId = percy.participant.participantId;
  await kit.call(liu.token, `/api/participants/${percy.participantId}/projects`, 'PUT', { projects: ['預設專案'] });
  const ux = (await kit.call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'UX', role: '使用體驗', name: 'UX', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  let n = 0;
  const post = async (tok, text, extra = {}) => { const r = await kit.call(tok, '/api/messages', 'POST', { text, requestId: 'p335_' + (++n), project: '預設專案', ...extra }); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body; };
  const ASK = '[需確認] 首頁要不要加教學？\n\n選項：\nA. 加（建議）\nB. 先不要';
  const toLiu = { recipientIds: [liu.participantId, percy.participantId], replyFrom: [liu.participantId] };
  const a1 = await post(ux.token, ASK, toLiu), a2 = await post(ux.token, ASK, toLiu), a3 = await post(ux.token, ASK, toLiu);
  const replies = async id => (await kit.call(liu.token, '/api/messages?limit=50')).body.items.filter(m => m.replyToMessageId === id);

  const { js, login, cdp } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  const shot = async (name, sel) => {
    if (!SHOT) return;
    const r = await J(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: Math.max(0, b.x - 8), y: Math.max(0, b.y - 8), width: b.width + 16, height: b.height + 16 }; })()`);
    await sleep(200);
    const s = await cdp('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
    fs.writeFileSync(`${SHOT}/${name}.png`, Buffer.from(s.result.data, 'base64'));
  };
  const box = id => J(`(() => { const b = document.querySelector('#msg-${id} .auth-box');
    return { opts: b?.querySelectorAll('.q-opt').length || 0, confirm: b?.querySelector('.auth-confirm')?.textContent.replace(/\\s+/g, ' ').trim() || '', answered: b?.querySelector('.answered')?.textContent.replace(/\\s+/g, ' ') || '', picks: b?.querySelectorAll('.ans-pick').length || 0 }; })()`);
  const click = sel => js(`document.querySelector(${JSON.stringify(sel)}).click(); true`);

  // Percy（不是被問的人）
  await login(percy.token, '/p/' + encodeURIComponent('預設專案') + '/messages');
  await until(() => js(`!!document.querySelector('#msg-${a1.messageId} .q-opt')`), 10000, 'A：非指定人看得到選項');
  assert.equal((await box(a1.messageId)).opts, 2, 'A：兩個選項都能按');
  await click(`#msg-${a1.messageId} [data-q-opt="A"]`);
  await click(`#msg-${a1.messageId} [data-q-send]`);
  await until(async () => (await box(a1.messageId)).confirm, 5000, 'B：跳確認');
  assert.match((await box(a1.messageId)).confirm, /這題是問 王大明 的，確定要代答嗎？[\s\S]*代答（Percy）[\s\S]*確定代答[\s\S]*取消/, 'B：確認文字：' + (await box(a1.messageId)).confirm);
  await shot('335-confirm', `#msg-${a1.messageId} .auth-box`);
  assert.equal((await replies(a1.messageId)).length, 0, 'B：確認前沒送出');
  await click(`#msg-${a1.messageId} [data-q-proxy-cancel]`);
  await until(async () => !(await box(a1.messageId)).confirm, 5000, '取消收起確認');
  await sleep(300);
  assert.equal((await replies(a1.messageId)).length, 0, 'B：取消不送出');
  // 再按一次、確定代答
  await click(`#msg-${a1.messageId} [data-q-send]`);
  await until(async () => (await box(a1.messageId)).confirm, 5000, '再跳確認');
  await click(`#msg-${a1.messageId} [data-q-proxy-ok]`);
  await until(async () => (await box(a1.messageId)).answered, 8000, '代答送出後收起');
  const r1 = await replies(a1.messageId);
  assert.equal(r1.length, 1, 'C：送出一則');
  assert.equal(r1[0].text, '[回覆] 代答（Percy）：選 A', 'C：訊息與 API 標代答：' + r1[0].text);
  const b1 = await box(a1.messageId);
  assert.ok(b1.answered.includes('代答（Percy）') && b1.picks === 1, 'C：已回覆區顯示代答並標出選了 A：' + JSON.stringify(b1));
  await shot('335-answered', `#msg-${a1.messageId} .auth-box`);
  const nt = (await kit.call(ux.token, '/api/notifications?status=pending&limit=50')).body.items.find(x => x.messageId === r1[0].messageId);
  assert.match(nt?.preview || '', /代答（Percy）/, 'C：AI 收到的通知預覽帶代答');

  await click(`#msg-${a3.messageId} [data-q-hold]`);
  assert.match((await box(a3.messageId)).confirm, /確定要幫忙暫緩嗎？[\s\S]*代為暫緩（Percy）[\s\S]*確定暫緩/);
  assert.ok(await js(`document.querySelector('#msg-${a3.messageId} [data-q-hold]').disabled && document.querySelector('#msg-${a3.messageId} [data-q-send]').disabled`));
  await click(`#msg-${a3.messageId} [data-q-proxy-ok]`);
  await until(async () => (await replies(a3.messageId)).length === 1, 5000, '代為暫緩送出');
  assert.equal((await replies(a3.messageId))[0].text, '[回覆] 代為暫緩（Percy）：暫緩處理');
  // 王大明（被問的人）：不確認、不標代答
  await login(liu.token, '/p/' + encodeURIComponent('預設專案') + '/messages');
  await until(() => js(`!!document.querySelector('#msg-${a2.messageId} .q-opt')`), 10000, '本人看得到選項');
  await click(`#msg-${a2.messageId} [data-q-opt="B"]`);
  await click(`#msg-${a2.messageId} [data-q-send]`);
  await until(async () => (await box(a2.messageId)).answered, 8000, '本人直接送出');
  const r2 = await replies(a2.messageId);
  assert.equal(r2[0].text, '[回覆] 選 B', '本人回覆不標代答：' + r2[0].text);
  console.log('ask-proxy-test：全部通過');
} catch (e) {
  console.error('ask-proxy-test 失敗：', e.message); process.exitCode = 1;
} finally { await kit.stop(); }
