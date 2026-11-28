// 同意 push／部署按鈕畫面測試（真的瀏覽器，1280／375，中英文）：AI 請示 push／部署照規格 4.2 附「請同意 push：<40 碼 SHA>」「請同意部署：<40 碼 SHA>」
// A. 非 PG 的 AI（發布）請 push＋部署同一個 SHA：按鈕寫「同意 push＋部署 <7 碼>」，下面列出會送出的完整句子；按下送「[回覆] 同意 push：<SHA>\n同意部署：<SHA>」
// B. PG 請多個動作（訊息裡也提到 commit）：不出舊的 commit／push 授權列，按鈕合併同 SHA；想法另起一行接在後面
// C. 沒照格式（7 碼、少一碼、行尾多字、只是引述回覆句子）→ 按鈕維持「同意照辦」，送出「[回覆] 同意照辦」
// D. 有「選項：」的請示照舊用選項；暫緩處理照舊；375 不橫向捲動、按鈕與句子不超出畫面
// E. 英文介面：按鈕寫 Approve push + deploy <7 碼>，送出的句子仍是規格的中文原文
// 用法：node scripts/approval-buttons-ui-test.js（APPROVAL_SHOTS=資料夾 會存截圖）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

if (!findBrowser()) { console.log('approval-buttons-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('approve');
try {
  const { call, get } = kit;
  const A = 'd92f98cbafb00fce582accf309f8bdfdf5f9d836';
  const B = '609bcad14b3842583cf88d39c8b9d410fb36a31d';
  const C = '150b52b94b61d5cb5ca6cfe4377f01ff7b35ef37';
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const mkAi = async (roleKey, role, name) => (await call(boss.token, '/api/my-ais', 'POST', {
    projects: ['預設專案'], roleKey, role, name, duties: '整合與發布', style: '簡潔', autonomy: '跑測試', mustConfirm: 'push 與部署問', handoff: '回報結果',
  })).body;
  const rel = await mkAi('SRE', '測試與發布', '發布助手'), pg = await mkAi('PG', '程式開發', '程式助手');
  const relTok = kit.aiToken(rel.participantId), pgTok = kit.aiToken(pg.participantId);
  let rq = 0;
  const post = (tok, text) => call(tok, '/api/messages', 'POST', { project: '預設專案', text, requestId: 'ap-' + (++rq), replyFrom: [] }).then(r => r.body);

  const mA = await post(relTok, `[需確認] DEMO-12 v1.0.9 全套三輪通過，請同意推上去並部署。\n請同意 push：${A}\n請同意部署：${A}\n請同意正式庫遷移：${A}`);
  const mB = await post(pgTok, `[需確認] DEMO-13 兩版都已 commit，請同意推送；平台另要部署。\n- 請同意 push：\`${B}\`\n請同意 push：${C}\n請同意部署：${B}`);
  const mC = await post(relTok, `[需確認] 請同意 push：d92f98c\n請同意部署：${A.slice(0, 39)}\n請同意 push：${A}（平台）\n[回覆] 同意 push：${A}`);
  const mD = await post(relTok, `[需確認] 要先推哪一版？\n請同意 push：${A}\n選項：\nA. 先推平台\nB. 兩版一起`);
  const mE = await post(relTok, `[需確認] DEMO-14 請同意部署。\n請同意部署：${C}`);

  const { js, login, cdp } = await kit.browser(1280, 900);
  const size = (w, h) => cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 600 });
  const shotDir = process.env.APPROVAL_SHOTS;
  const shot = async (name, id) => {
    if (!shotDir) return;
    if (id) await js(`document.getElementById('msg-${id}').scrollIntoView({ block: 'center' }); true`);
    await sleep(300);
    fs.mkdirSync(shotDir, { recursive: true });
    const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  const info = id => js(`(() => {
    const el = document.getElementById('msg-${id}');
    if (!el) return null;
    const send = el.querySelector('[data-q-send]');
    return JSON.stringify({
      send: send?.textContent.trim() || '', disabled: !!send?.disabled,
      note: [...el.querySelectorAll('.grant-note .grant-line')].map(c => c.textContent),
      shaMono: [...el.querySelectorAll('.grant-note .grant-line')].map(l => getComputedStyle(l).fontFamily !== getComputedStyle(l.querySelector('code')).fontFamily),
      noteText: el.querySelector('.grant-note')?.textContent.trim() || '',
      opts: el.querySelectorAll('[data-q-opt]').length, hold: !!el.querySelector('[data-q-hold]'),
      oldAuth: [...el.querySelectorAll('[data-auth]')].map(b => b.dataset.auth), hints: el.querySelectorAll('.auth-row.hint').length,
      answered: el.querySelector('.auth-row.answered')?.textContent.replace(/\\s+/g, ' ').trim() || '',
    });
  })()`).then(s => JSON.parse(s));
  const reply = id => until(() => get('SELECT text FROM messages WHERE reply_to = ? ORDER BY created_at DESC LIMIT 1', id)?.text, 10000, '回覆寫進資料庫');
  const click = sel => js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);

  await size(1280, 900);
  await login(boss.token, '/p/' + encodeURIComponent('預設專案') + '/messages');
  await until(() => js(`!!document.querySelector('#msg-${mE.messageId} [data-q-send]')`), 15000, '請示訊息載入');

  // A. 同 SHA push＋部署
  const a = await info(mA.messageId);
  assert.equal(a.send, `同意 push＋部署＋正式庫遷移 ${A.slice(0, 7)}`, 'A. 按鈕看得到要同意什麼（含正式庫遷移）');
  assert.deepEqual(a.note, [`同意 push：${A}`, `同意部署：${A}`, `同意正式庫遷移：${A}`], 'A. 按鈕下列出會送出的完整句子（完整 40 碼）');
  assert.ok(a.noteText.startsWith('按下會送出：'), 'A. 說明文字');
  assert.deepEqual(a.shaMono, [true, true, true], 'A. 只有 SHA 用等寬字，動作字用一般字');
  assert.deepEqual([a.oldAuth, a.hold, a.opts], [[], true, 0], 'A. 只有同意與暫緩，沒有舊授權列');
  // B. PG 多動作：不出 commit／push 舊授權列
  const b = await info(mB.messageId);
  assert.equal(b.send, `同意 push＋部署 ${B.slice(0, 7)}、push ${C.slice(0, 7)}`, 'B. 同 SHA 合併、不同 SHA 分開');
  assert.deepEqual(b.note, [`同意 push：${B}`, `同意 push：${C}`, `同意部署：${B}`], 'B. 一個動作一行，照請示的順序');
  assert.deepEqual([b.oldAuth, b.hints], [[], 0], 'B. 照格式請示時不用字面猜 commit／push');
  // C. 沒照格式
  const c = await info(mC.messageId);
  assert.deepEqual([c.send, c.note], ['同意照辦', []], 'C. 7 碼、少一碼、行尾多字、引述回覆句子都不算格式，按鈕維持同意照辦');
  // D. 有選項的照舊
  const d = await info(mD.messageId);
  assert.deepEqual([d.opts, d.note, d.send], [2, [], '先選一個選項'], 'D. 有選項的請示照舊用選項');
  await shot('1280-a-b', mA.messageId);

  // 375：不橫向捲動、按鈕與句子在畫面內
  await size(375, 800);
  await sleep(300);
  await js(`document.getElementById('msg-${mB.messageId}').scrollIntoView({ block: 'center' }); true`);
  const geo = JSON.parse(await js(`(() => { const el = document.getElementById('msg-${mB.messageId}'), vw = document.documentElement.clientWidth;
    const out = [...el.querySelectorAll('[data-q-send], [data-q-hold], .grant-note .grant-line')].filter(x => { const r = x.getBoundingClientRect(); return r.left < 0 || r.right > vw + 0.5; }).map(x => x.textContent.slice(0, 20));
    return JSON.stringify({ sw: document.documentElement.scrollWidth, vw, out, h: el.querySelector('[data-q-send]').getBoundingClientRect().height }); })()`));
  assert.ok(geo.sw <= geo.vw, `375 不橫向捲動（${geo.sw} > ${geo.vw}）`);
  assert.deepEqual(geo.out, [], '375 按鈕與完整句子都在畫面內');
  assert.ok(geo.h >= 44, '375 同意鈕至少 44px 高');
  await shot('375-b', mB.messageId);
  await size(1280, 900);
  await sleep(300);

  // 送出：A 直接按
  assert.ok(await click(`#msg-${mA.messageId} [data-q-send]`), 'A. 按同意');
  assert.equal(await reply(mA.messageId), `[回覆] 同意 push：${A}\n同意部署：${A}\n同意正式庫遷移：${A}`, 'A. 送出完整句子，一個動作一行');
  await until(() => info(mA.messageId).then(x => x.answered.includes(`同意 push＋部署＋正式庫遷移 ${A.slice(0, 7)}`) && !x.answered.includes("同意部署：")), 10000, 'A. 已回覆用跟按鈕一樣的短句');
  await shot('1280-a-sent', mA.messageId);
  // B. 寫了想法：另起一行接在後面
  await js(`(() => { const t = document.querySelector('[data-q-text="${mB.messageId}"]'); t.focus(); t.value = '記得看 CI'; t.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  assert.ok(await click(`#msg-${mB.messageId} [data-q-send]`), 'B. 按同意');
  assert.equal(await reply(mB.messageId), `[回覆] 同意 push：${B}\n同意 push：${C}\n同意部署：${B}\n記得看 CI`, 'B. 想法另起一行，不黏在 SHA 後面');
  // C. 沒照格式：照舊送同意照辦
  assert.ok(await click(`#msg-${mC.messageId} [data-q-send]`), 'C. 按同意照辦');
  assert.equal(await reply(mC.messageId), '[回覆] 同意照辦', 'C. 沒附格式照舊送同意照辦');
  // E. 暫緩處理照舊
  assert.ok(await click(`#msg-${mE.messageId} [data-q-hold]`), 'E. 按暫緩');
  assert.equal(await reply(mE.messageId), '[回覆] 暫緩處理', 'E. 暫緩處理不帶 SHA');

  // E. 英文介面：按鈕翻成英文，送出的句子仍是規格原文（看 F 這則還沒回覆的）
  const mF = await post(relTok, `[需確認] DEMO-15 please approve.\n請同意 push：${B}\n請同意部署：${B}\n請同意正式庫遷移：${B}\n請同意 push：${C}`);
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await login(boss.token, '/p/' + encodeURIComponent('預設專案') + '/messages');
  await until(() => js(`!!document.querySelector('#msg-${mF.messageId} [data-q-send]')`), 15000, '英文介面請示載入');
  await sleep(300);
  const f = await info(mF.messageId);
  assert.equal(f.send, `Approve push + deploy + production migration ${B.slice(0, 7)}, push ${C.slice(0, 7)}`, 'E. 英文按鈕');
  assert.ok(f.noteText.startsWith('This sends:'), 'E. 英文說明：' + f.noteText.slice(0, 30));
  assert.deepEqual(f.note, [`同意 push：${B}`, `同意部署：${B}`, `同意正式庫遷移：${B}`, `同意 push：${C}`], 'E. 會送出的句子不翻譯');
  await shot('1280-en', mF.messageId);
  assert.ok(await click(`#msg-${mF.messageId} [data-q-send]`), 'E. 按 Approve');
  assert.equal(await reply(mF.messageId), `[回覆] 同意 push：${B}\n同意部署：${B}\n同意正式庫遷移：${B}\n同意 push：${C}`, 'E. 英文介面送出的仍是規格原文');
  await js("localStorage.removeItem('aigile-lang'); true");

  console.log('approval-buttons-ui-test：全部通過');
} finally { await kit.stop(); }
