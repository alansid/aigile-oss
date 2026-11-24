// 同專案不可同名、不同專案可同名；同畫面出現 >= 2 位同名才加短代碼；@ 選單與未消歧 @名字（含中／英文介面＋1280／375 截圖）
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { startKit, findBrowser, until, sleep } from './browser-kit.js';

const SHOT_DIR = process.env.PLAT430_SHOT_DIR || '';
const saveShot = async (cdp, name) => {
  if (!SHOT_DIR) return;
  const r = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(r.result.data, 'base64'));
};

const kit = await startKit('dupname');
try {
  const { call, aiToken } = kit;
  const join = async (name, role = 'PG') => (await call(null, '/api/join', 'POST', { name, role })).body;
  const boss = await join('劉昱志', 'PO');
  const ming = await join('王小明', 'PG');
  assert.equal((await call(boss.token, `/api/participants/${ming.participant.participantId}/projects`, 'PUT', { projects: ['第二專案'] })).status, 200);

  // 1. 不同專案可同名、同專案擋下
  const inv1 = await call(boss.token, '/api/invites', 'POST', { name: '小華', role: 'UX', projects: ['預設專案'] });
  assert.equal(inv1.status, 201, JSON.stringify(inv1.body));
  assert.equal((await call(boss.token, '/api/invites', 'POST', { name: '小華', role: 'PG', projects: ['預設專案'] })).body.error.code, 'INVITE_EXISTS');
  const inv2 = await call(boss.token, '/api/invites', 'POST', { name: '小華', role: 'PG', projects: ['第二專案'] });
  assert.equal(inv2.status, 201, JSON.stringify(inv2.body));

  const j1 = (await call(null, '/api/auth/invite', 'POST', { token: inv1.body.url.split('/invite/')[1], name: '小華' })).body;
  const huaA = j1.participant;
  assert.equal((await call(boss.token, '/api/invites', 'POST', { name: '小華', role: 'PG', projects: ['預設專案'] })).body.error.code, 'NAME_TAKEN');
  const huaAi = await call(ming.token, '/api/my-ais', 'POST', {
    projects: ['第二專案'], roleKey: 'PG', role: '程式開發', name: '小華',
    duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x',
  });
  assert.equal(huaAi.status, 201, JSON.stringify(huaAi.body));
  assert.notEqual(huaAi.body.shortCode, huaA.shortCode);

  assert.equal((await call(null, '/api/auth/invite', 'POST', { token: inv2.body.url.split('/invite/')[1], name: '小華' })).body.error.code, 'NAME_TAKEN');
  assert.equal((await call(boss.token, `/api/participants/${huaA.participantId}/projects`, 'PUT', { projects: ['預設專案', '第二專案'] })).body.error.code, 'NAME_TAKEN');

  // 2. API @ 解析與 400 AMBIGUOUS_MENTION
  const postAll = (tok, text, extra = {}) => call(tok, '/api/messages', 'POST', { project: 'all', requestId: 'dup_' + Math.random(), text, ...extra });
  const ambigRes = await postAll(boss.token, '請 @小華 看一下');
  assert.equal(ambigRes.status, 400);
  assert.equal(ambigRes.body.error.code, 'AMBIGUOUS_MENTION');
  assert.equal(ambigRes.body.error.candidates.length, 2);

  const codedRes = await postAll(boss.token, `請問 @小華·${huaA.shortCode} 進度如何`);
  assert.equal(codedRes.status, 201);
  assert.deepEqual(codedRes.body.recipients.map(r => r.participantId), [huaA.participantId]);
  const codedResB = await postAll(boss.token, `請 @小華·${huaAi.body.shortCode} 接續檢查`);
  assert.equal(codedResB.status, 201);
  assert.deepEqual(codedResB.body.recipients.map(r => r.participantId), [huaAi.body.participantId]);
  assert.equal((await call(boss.token, '/api/me', 'PATCH', { name: '小華' })).body.error.code, 'NAME_TAKEN');

  assert.equal((await call(j1.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'dup_ha_p', text: '預設專案小華收到' })).status, 201);
  assert.equal((await call(j1.token, '/api/messages', 'POST', { project: 'all', requestId: 'dup_ha_all', text: '跨專案：預設專案小華回報' })).status, 201);
  const aiTok = aiToken(huaAi.body.participantId);
  assert.equal((await call(aiTok, '/api/messages', 'POST', { project: '第二專案', requestId: 'dup_ai1', text: '[完成] 【第二專案】第二專案小華完成' })).status, 201);
  assert.equal((await call(aiTok, '/api/messages', 'POST', { project: 'all', requestId: 'dup_ai_all', text: '跨專案：第二專案小華 AI 同步進度' })).status, 201);

  if (!findBrowser()) {
    console.log('dup-name-ui-test：API 全過（找不到 Chrome／Edge，略過畫面測試）');
    process.exit(0);
  }

  // 3. 中文 1280 ＋ 英文 1280／375 驗證
  const { cdp, js, goto, login, key } = await kit.browser(1280, 900);
  const J = async code => JSON.parse(await js(`JSON.stringify(${code})`));
  await login(boss.token, `/p/${encodeURIComponent('預設專案')}/messages`);
  await until(() => js(`document.querySelectorAll('#messages .msg').length >= 1`), 10000, '載入預設專案訊息');
  assert.equal(await js(`document.querySelectorAll('#messages .name-code').length`), 0, '單一專案不加短代碼');

  await js(`document.querySelector('.proj-switch [data-proj="cross"]').click(); true`);
  await until(() => js(`document.querySelectorAll('#messages .name-code').length >= 2`), 10000, '跨專案出現短代碼');
  await js(`(() => { const el = document.querySelector('#input'); el.focus(); el.value = '@小華'; el.setSelectionRange(3, 3); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await until(() => js(`document.querySelector('#mention-list')?.hidden === false`), 5000, '@ 選單');
  assert.ok((await js(`document.querySelector('#mention-list .mention-grp')?.textContent`)).includes('有 2 位叫「小華」'));
  await key('Enter');
  assert.match(await js(`document.querySelector('#input').value`), /^@小華·[A-Z0-9]{4} $/);

  await js(`(() => { const el = document.querySelector('#input'); el.value = '@小華 請看'; el.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send').click(); return true; })()`);
  await until(() => js(`document.querySelector('#composer-ambig')?.hidden === false`), 5000, '中文消歧列');
  await js(`document.querySelector('#composer-ambig [data-amb-all]').click(); true`);
  await until(() => js(`document.querySelector('#composer-ambig')?.hidden === true`), 3000, '消歧列關閉');
  const exp = await js(`document.querySelector('#input').value`);
  assert.ok(exp.includes('@小華·' + huaA.shortCode) && exp.includes('@小華·' + huaAi.body.shortCode));
  await js(`document.querySelector('#send').click(); true`);
  await until(() => js(`document.querySelector('#input').value === ''`), 5000, '送出完成');

  // 英文介面驗證
  await js(`localStorage.setItem('aigile-lang', 'en'); true`);
  await goto('/', '英文版');
  await until(() => js(`document.documentElement.lang === 'en' && !!document.querySelector('.proj-switch [data-proj="cross"]')`), 15000, '英文介面完成');
  await js(`document.querySelector('.proj-switch [data-proj="cross"]').click(); true`);
  await until(() => js(`document.querySelectorAll('#messages .name-code').length >= 1`), 10000, '英文版跨專案短代碼');
  assert.ok((await J(`[...document.querySelectorAll('#ai-now .name-code')].map(e => e.textContent)`)).includes(huaAi.body.shortCode), '英文 AI 現況條顯示短代碼');
  const sendToText = await js(`document.querySelector('#send-to')?.textContent || ''`);
  assert.ok(sendToText.includes('(visible to all projects)') && !/[（）]/.test(sendToText), '英文 send-to 無中文與全形括號：' + sendToText);
  await js(`(() => { const el = document.querySelector('#input'); el.value = '@小華 Please check'; el.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#send').click(); return true; })()`);
  await until(() => js(`document.querySelector('#composer-ambig')?.hidden === false`), 5000, '英文消歧列');
  const enAmb = await js(`document.querySelector('#composer-ambig').textContent`);
  assert.ok(enAmb.includes('Mention both') && enAmb.includes('(Human)') && enAmb.includes('Developer') && !/[（）]/.test(enAmb), '英文消歧列正確無全形括號：' + enAmb);
  await saveShot(cdp, 'plat430-en-1280.png');

  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const ov = await js(`document.documentElement.scrollWidth - window.innerWidth`);
  assert.ok(ov <= 1, '英文 375 無水平溢位：' + ov);
  await saveShot(cdp, 'plat430-en-375.png');
  console.log('dup-name-ui-test：全部通過');
} finally {
  await kit.stop();
}
