// 畫面測試（真的瀏覽器）：系統私訊看起來像系統通知
// UX 全面驗收必修④：收件匣、總覽、私訊面板寫「平台通知 回你了」，預覽露出 node 指令和網址
// 1. 平台通知在收件匣、總覽、私訊面板顯示「平台通知」＋一句白話，不寫「回你了」
// 2. 預覽不露出 node 指令與網址；點開私訊對話才看得到全文
// 3. 主人叫 AI 同步的指令（給 AI 的私訊），私訊面板的預覽寫成白話
// 4. 給 AI 的內容不變：AI 用 API 讀到完整指令
// 需要 Chrome 或 Edge；找不到就略過。用法：node scripts/system-dm-gist-ui-test.js
import assert from 'node:assert';
import { startKit, findBrowser, until } from './browser-kit.js';

if (!findBrowser()) { console.log('system-dm-gist-ui-test：略過（找不到 Chrome／Edge）'); process.exit(0); }
const kit = await startKit('t1');
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const a = (await kit.call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: 'PG一號', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const pg = { id: a.participantId, tok: kit.aiToken(a.participantId) };
  assert.equal((await kit.call(boss.token, '/api/projects/%E9%A0%90%E8%A8%AD%E5%B0%88%E6%A1%88/dm', 'PUT', { on: true })).status, 200, '開私訊');
  // 平台通知 ①：技能新版（含網址）
  const up = await kit.call(boss.token, '/api/projects/%E9%A0%90%E8%A8%AD%E5%B0%88%E6%A1%88/skills', 'POST', { files: [{ path: 'SKILL.md', text: '---\nname: pg-rules\ndescription: PG 規則\n---\n規則\n' }], roles: ['PG'] });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  // 平台通知 ②：同步失敗（含網址）
  assert.equal((await kit.call(pg.tok, '/api/me/skills/sync-status', 'POST', { state: 'failed', lastLine: '技能：pg-rules 下載失敗' })).status, 200);
  // 主人按同步 → 私訊叫醒 AI（給 AI 的指令：node …、網址）
  assert.equal((await kit.call(boss.token, '/api/skill-sync', 'POST', { aiIds: [pg.id] })).status, 200);
  // 4. AI 讀到的內容不變
  const aiDm = (await kit.call(pg.tok, '/api/dm')).body.items;
  assert.ok(aiDm.some(d => /^\[技能同步\] 請在你的工作資料夾跑一次：node \.aigile\/watcher\/aigile-setup\.mjs --agent PG_\w+ --base http/.test(d.text)), 'AI 讀到完整指令');
  const notes = (await kit.call(boss.token, '/api/notifications?status=pending')).body.items;
  assert.equal(notes.filter(n => n.sender.system).length, 2, '主人有兩則平台通知');
  assert.ok(notes.every(n => !n.sender.system || n.preview.includes('http')), 'API 的預覽照舊（網頁才改寫）');

  const { js, login } = await kit.browser(1280, 900);
  const bad = t => /回你了|https?:\/\/|node \.aigile/.test(t);
  // 總覽「要你處理」
  await login(boss.token, '/');
  await until(() => js("document.querySelectorAll('.hub-todo .ht-row').length >= 2"), 15000, '總覽要你處理');
  const hub = await js("[...document.querySelectorAll('.hub-todo .ht-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim())");
  const hubSys = hub.filter(t => t.includes('平台通知'));
  assert.equal(hubSys.length, 2, '總覽兩則平台通知：' + JSON.stringify(hub));
  assert.ok(hubSys.some(t => t.includes('平台通知：🧩 技能「pg-rules」有第 1 版，1 隻 AI 要同步')), JSON.stringify(hubSys));
  assert.ok(hubSys.some(t => t.includes('平台通知：⚠ PG一號 同步技能失敗：技能：pg-rules 下載失敗')), JSON.stringify(hubSys));
  assert.ok(hubSys.every(t => !bad(t)), '總覽不寫回你了、不露網址：' + JSON.stringify(hubSys));
  // 收件匣頁的私訊區
  await js("history.pushState(null, '', '/p/main/inbox'); dispatchEvent(new PopStateEvent('popstate')); true");
  await until(() => js("[...document.querySelectorAll('.sugg-row')].some(r => r.textContent.includes('平台通知'))"), 10000, '收件匣私訊區');
  const inbox = await js("[...document.querySelectorAll('.sugg-row')].filter(r => r.textContent.includes('平台通知')).map(r => r.querySelector('.sugg-main').textContent.replace(/\\s+/g, ' ').trim())");
  assert.equal(inbox.length, 2, JSON.stringify(inbox));
  assert.ok(inbox.every(t => t.startsWith('平台通知') && !bad(t)), '收件匣：' + JSON.stringify(inbox));
  // 私訊面板：對話清單的預覽（最後一則是主人叫 AI 同步的指令）
  await until(() => js("!!document.querySelector('[data-dm-toggle]:not([hidden])')"), 10000, '私訊按鈕');
  await js("document.querySelector('[data-dm-toggle]:not([hidden])').click(); true");
  await until(() => js("!!document.querySelector('#dm-panel .dm-row .dm-prev')"), 10000, '私訊面板清單');
  const prev = await js("document.querySelector('#dm-panel .dm-row .dm-prev').textContent");
  assert.equal(prev, '你：🧩 已請 AI 同步技能，結果會自動顯示在同步清單', '私訊面板預覽：' + prev);
  // 點開對話：看得到全文（給 AI 的指令）
  await js("document.querySelector('#dm-panel .dm-row').click(); true");
  await until(() => js("(document.querySelector('#dm-panel').textContent || '').includes('node .aigile/watcher/aigile-setup.mjs')"), 10000, '點開看得到全文');
  assert.equal(await js("(document.querySelector('#dm-panel').textContent || '').includes('平台通知')"), true, '對話裡平台通知照舊');
  // 關掉面板回清單：預覽還是白話（打開對話後清單改用本機的最後一則）
  await js("document.querySelector('#dm-panel [data-dm-back], #dm-panel .dm-back')?.click(); true");
  await sleep(500);
  const prev2 = await js("document.querySelector('#dm-panel .dm-row .dm-prev')?.textContent || ''");
  if (prev2) assert.equal(bad(prev2), false, '回到清單也不露指令：' + prev2);
  console.log('system-dm-gist-ui-test：全部通過');
} catch (e) {
  console.error('system-dm-gist-ui-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await kit.stop();
}
