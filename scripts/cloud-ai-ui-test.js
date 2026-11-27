// 雲端 AI 畫面（本機暫存庫＋本機假模型伺服器，不連正式站、不用真金鑰）
// - 管理員設定 › 模型設定：新增一組（自訂 OpenAI 相容、內網 http → 🏠 私人模型＋未加密）、讀模型清單、儲存並測試
// - 新增 AI：第一題「在哪裡跑」；成員的雲端卡灰掉；管理員選雲端、選模型、建立後不用接入
// - 群組：@ 它 → 「☁️ 正在處理…」→ 回覆，名字旁 🏠 私人模型
// - 我的 AI：副標、隨時可叫醒、今天用量與最近幾輪；金鑰錯誤 → 叫不醒＋找它的人收到說明
// - 375 不橫向捲動
// - 英文介面：模型設定、新增 AI 的雲端卡、我的 AI 雲端分頁都是英文
// 用法：node scripts/cloud-ai-ui-test.js（CLOUD_AI_SHOTS=資料夾 會存截圖）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startKit, until, freePort, sleep } from './browser-kit.js';

let mode = 'ok', delay = 0;
const body0 = raw => { try { return JSON.parse(raw || '{}'); } catch { return {}; } };
const modelPort = await freePort();
const fake = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  const send = (st, b) => { res.writeHead(st, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
  if (mode === 'badkey') return send(401, { error: { message: 'bad key' } });
  if (mode === 'loop' && body0(raw).max_tokens !== 16 && !req.url.endsWith('/models')) return send(200, { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 't' + Date.now() + Math.random(), type: 'function', function: { name: 'aigile_team', arguments: '{}' } }] } }], usage: { total_tokens: 1500 } });
  if (req.url.endsWith('/models')) return send(200, { data: [{ id: 'qwen2.5:14b' }, { id: 'llama3.1:8b' }] });
  const body = JSON.parse(raw || '{}');
  if (body.max_tokens === 16) return send(200, { choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 6 } });
  await sleep(delay);
  send(200, { choices: [{ message: { content: '整理好了：DEMO-12 待驗證、DEMO-13 進行中。' } }], usage: { prompt_tokens: 1800, completion_tokens: 120, total_tokens: 1920 } });
}).listen(modelPort, '127.0.0.1');

const kit = await startKit('cloudai');
const shotDir = process.env.CLOUD_AI_SHOTS;
try {
  const { body: liu } = await kit.call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' });
  const { body: wang } = await kit.call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' });
  assert.equal((await kit.call(liu.token, '/api/participants/' + wang.participant.participantId + '/projects', 'PUT', { projects: ['預設專案'] })).status, 200);
  const { js, cdp, login } = await kit.browser(1280, 900);
  const shot = async name => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const noHScroll = () => js('document.documentElement.scrollWidth <= innerWidth + 1');
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const setVal = (sel, v) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  // 1. 模型設定：空的 → 新增一組（自訂 OpenAI 相容、內網 http）
  const MC = '/api/projects/' + encodeURIComponent('預設專案') + '/model-connections';
  const openPM = async tok => { // 模型設定在專案 ⚙ › 模型設定
    await login(tok, '/p/main/messages');
    await until(() => js("!!document.querySelector('[data-pset]')"), 15000, '專案 ⚙');
    await click('[data-pset]');
    await until(() => js("!!document.querySelector('#pset-menu [data-pset-act=\"models\"]')"), 5000, '⚙ 選單');
    await click('#pset-menu [data-pset-act="models"]');
    await until(() => js("!!document.querySelector('#mc-proj')"), 8000, '專案模型設定');
  };
  await openPM(liu.token);
  await until(() => js("!!document.querySelector('[data-mc=\"new\"]')"), 15000, '模型設定頁');
  assert.match(await js("document.querySelector('.mc-page').innerText"), /預設專案還沒有模型設定，雲端 AI 要先有一組金鑰才能用。[\s\S]*費用算在這個專案貼的金鑰上/);
  await click('[data-mc="new"]');
  await until(() => js("!!document.querySelector('#mc-form')"), 5000, '新增表單');
  await click('[data-kind="custom"]');
  await setVal('#mc-form [name="name"]', '公司地端');
  await setVal('#mc-url', `http://127.0.0.1:${modelPort}/v1`);
  await until(() => js("!!document.querySelector('.mc-priv')"), 5000, '私人模型說明');
  assert.match(await js("document.querySelector('.mc-urltag').innerText"), /🏠 私人模型[\s\S]*未加密/);
  await setVal('#mc-url', 'http://api.example.com/v1');
  await until(() => js("!!document.querySelector('.mc-bad')"), 5000, '公網 http 擋');
  assert.match(await js("document.querySelector('.mc-bad').innerText"), /公網網址必須用 https/);
  await setVal('#mc-url', `http://127.0.0.1:${modelPort}/v1`);
  await until(() => js("!!document.querySelector('.mc-priv')"), 5000, "行 54");
  await click('[data-mck="discover"]');
  await until(() => js("document.querySelectorAll('.mc-checks input').length === 2"), 5000, '讀到 2 個模型');
  await js("document.querySelectorAll('.mc-checks input').forEach(i => { i.checked = true; }); true");
  await click('button[type="submit"][form="mc-form"]');
  await until(() => js("/連線成功/.test(document.querySelector('.mc-result')?.textContent || '')"), 10000, '儲存並測試');
  assert.match(await js("document.querySelector('.mc-result').textContent"), /^✓ 已存好。連線成功：qwen2\.5:14b 回應/);
  await shot('models-form-1280');
  await js("document.querySelector('#modal-root [data-close]').click(); true");
  // 加一組官方（Gemini，貼金鑰；這裡連不到真的 Gemini，只看列表）
  assert.equal((await kit.call(liu.token, MC, 'POST', { kind: 'gemini', name: 'Gemini 免費額度', key: 'AIza-demo-key-Ij1G', models: ['gemini-2.5-flash', 'gemini-2.5-pro'] })).status, 201);
  await openPM(liu.token);
  await until(() => js("document.querySelectorAll('.mc-row').length === 2"), 15000, '兩組設定');
  const listText = await js("document.querySelector('.mc-page').innerText");
  assert.match(listText, /Gemini 免費額度[\s\S]*官方[\s\S]*金鑰 ••••Ij1G/);
  assert.match(listText, /公司地端[\s\S]*🏠 私人模型[\s\S]*未加密[\s\S]*✓ 可以用[\s\S]*不需金鑰/);
  assert.ok(!listText.includes('AIza-demo'), '畫面沒有完整金鑰');
  assert.match(listText, /變更紀錄[\s\S]*Gemini 免費額度：新增，金鑰 ••••Ij1G/);
  await shot('models-list-1280');

  // 2. 新增 AI：成員的雲端卡灰掉
  await login(wang.token, '/my-ai');
  await until(() => js("!!document.querySelector('#ai-new')"), 15000, '我的 AI');
  await click('#ai-new');
  await until(() => js("!!document.querySelector('.where-why') && !/載入中/.test(document.querySelector('.where-why').textContent)"), 8000, '成員的雲端卡');
  assert.equal(await js("document.querySelector('[data-where=\"cloud\"]').disabled"), true);
  assert.match(await js("document.querySelector('.where-why').textContent"), /只有專案負責人和管理員能新增/);

  // 管理員：選雲端、選模型、建立
  await login(liu.token, '/my-ai');
  await until(() => js("!!document.querySelector('#ai-new')"), 15000, "行 84");
  await click('#ai-new');
  await until(() => js("document.querySelector('[data-where=\"cloud\"]') && !document.querySelector('[data-where=\"cloud\"]').disabled"), 8000, '雲端卡可以選');
  await click('[data-where="cloud"]');
  assert.equal(await js("document.querySelector('.env-field')?.hidden ?? true"), true, '雲端不問所在環境（開源版沒有這欄）');
  assert.deepEqual(await js("[...document.querySelectorAll('[name=\"cloudChoice\"] option')].map(o => o.textContent)"), ['公司地端 · qwen2.5:14b · 🏠 私人模型', '公司地端 · llama3.1:8b · 🏠 私人模型'], '只列可以用的設定（Gemini 還沒測試成功）');
  await js("(() => { const b = [...document.querySelectorAll('#ai-form input[name=proj]:not(:disabled)')]; (b.find(i => i.value === '預設專案') || b[0]).checked = true; return true; })()");
  await setVal('#ai-form [name="name"]', '示範助理');
  await shot('new-ai-cloud-1280');
  await click('button[type="submit"][form="ai-form"]');
  await until(() => js("[...document.querySelectorAll('.ma-item')].some(x => x.innerText.includes('示範助理'))"), 10000, '建好').catch(async e => { console.log('表單錯誤：', await js("[...document.querySelectorAll('#ai-form .error')].map(x => x.textContent).join(' | ')")); throw e; });
  const rowText = await js("[...document.querySelectorAll('.ma-item')].find(x => x.innerText.includes('示範助理')).innerText");
  assert.match(rowText, /隨時可叫醒/);
  assert.match(rowText, /☁️ 雲端 · 🏠 私人模型「公司地端」 · qwen2\.5:14b/);
  assert.ok(!/複製一行啟動|複製接入文字|Token/.test(rowText), '雲端 AI 沒有接入步驟與 Token');
  const aiId = (await kit.call(liu.token, '/api/my-ais')).body.items.find(x => x.name === '示範助理').participantId;

  // 3. 群組：@ 它 → 正在處理… → 回覆
  delay = 8000;
  await login(wang.token, '/p/main');
  await until(() => js("!!document.querySelector('#messages')"), 15000, "行 104");
  const sent = await kit.call(wang.token, '/api/messages', 'POST', { requestId: 'ui-1', project: '預設專案', text: '@示範助理 幫我把 DEMO-12 到 DEMO-15 整理成這週進度', recipientIds: [aiId], replyFrom: [aiId] });
  assert.equal(sent.status, 201);
  await until(() => js("/示範助理 正在處理…/.test(document.querySelector('#cloud-busy')?.innerText || '')"), 10000, '正在處理…');
  await until(() => js("/示範助理\\s*(處理中|Working)/.test(document.querySelector('#ai-now')?.innerText || '')"), 8000, 'AI 列顯示處理中');
  await shot('group-busy-1280');
  await until(() => js("[...document.querySelectorAll('.msg')].some(m => m.innerText.includes('整理好了'))"), 15000, '雲端 AI 回覆');
  const replyEl = "[...document.querySelectorAll('.msg')].find(m => m.innerText.includes('整理好了'))";
  assert.match(await js(`${replyEl}.querySelector('.cloud-chip').textContent`), /🏠 私人模型/);
  await until(() => js("document.querySelector('#cloud-busy').hidden"), 10000, '跑完消失');
  await until(() => js("!/處理中/.test(document.querySelector('#ai-now')?.innerText || '')"), 8000, '跑完不再顯示處理中');
  await shot('group-reply-1280');
  delay = 0;

  // 4. 我的 AI：今天用量、最近幾輪
  await login(liu.token, '/my-ai');
  await until(() => js("[...document.querySelectorAll('.ma-item')].some(x => x.innerText.includes('示範助理'))"), 15000, "行 118");
  await js(`[...document.querySelectorAll('.ma-item')].find(x => x.innerText.includes('示範助理')).querySelector('[data-act="tab"][data-tab="cloud"]').click(); true`);
  await until(() => js("!!document.querySelector('.cl-panel')"), 5000, '雲端分頁');
  const panel = await js("document.querySelector('.cl-panel').innerText");
  assert.match(panel, /今天\s*叫醒 1 次 · 共 1\.9k token/);
  assert.match(panel, /王小明[\s\S]*1\.9k[\s\S]*已回覆/);
  await shot('myai-cloud-1280');
  // 每輪上限
  await click('[data-act="cloud-limit"]');
  await until(() => js("!!document.querySelector('#cl-tools')"), 5000, "行 127");
  await js("document.querySelector('#cl-tools').value = '25'; document.querySelector('.confirm-root [data-ok]').click(); true");
  await until(() => js("/最多 25 次工具/.test(document.querySelector('.cl-panel')?.innerText || '')"), 5000, '上限改好');


  // 4b. 一輪到上限：群組的 [受阻]、主人「要你處理」三顆鈕（再跑一輪／改每輪上限／先不用）
  assert.equal((await kit.call(liu.token, `/api/my-ais/${aiId}/cloud`, 'PATCH', { maxTools: 2 })).status, 200);
  mode = 'loop';
  await kit.call(wang.token, '/api/messages', 'POST', { requestId: 'ui-limit', project: '預設專案', text: '@示範助理 幫我把 DEMO-15 整理完', recipientIds: [aiId], replyFrom: [aiId] });
  await until(async () => (await kit.call(liu.token, '/api/my-ais')).body.items.find(x => x.participantId === aiId).cloud.runs[0]?.result === 'limit', 15000, '到上限');
  mode = 'ok';
  await login(liu.token, '/p/main');
  await until(() => js("[...document.querySelectorAll('.msg')].some(m => m.innerText.includes('這輪用到上限'))"), 15000, '群組有 [受阻]');
  await js("[...document.querySelectorAll('.msg')].find(m => m.innerText.includes('這輪用到上限')).scrollIntoView({ block: 'center' }); true");
  await shot('group-limit-1280');
  await login(liu.token, '/p/main/inbox');
  await until(() => js("!!document.querySelector('[data-cloud-rerun]')"), 15000, '要你處理有再跑一輪');
  const limitRow = await js("document.querySelector('[data-cloud-rerun]').closest('.sugg-row').innerText");
  assert.match(limitRow, /再跑一輪[\s\S]*改每輪上限[\s\S]*先不用/);
  await shot('inbox-limit-1280');
  await click('[data-cloud-limit]');
  await until(() => js("!!document.querySelector('#cl-tools')"), 8000, '改每輪上限視窗');
  assert.equal(await js("document.querySelector('#cl-tools').value"), '2');
  await js("document.querySelector('#cl-tools').value = '20'; document.querySelector('.confirm-root [data-ok]').click(); true");
  await until(async () => (await kit.call(liu.token, '/api/my-ais')).body.items.find(x => x.participantId === aiId).cloud.maxTools === 20, 8000, '上限改回 20');
  await click('[data-cloud-rerun]');
  await until(async () => (await kit.call(liu.token, '/api/my-ais')).body.items.find(x => x.participantId === aiId).cloud.runs[0]?.result === 'replied', 15000, '再跑一輪回覆了');
  await until(() => js("!document.querySelector('[data-cloud-rerun]')"), 8000, '按了再跑一輪就移出要你處理');

  // 5. 金鑰錯誤：叫不醒、找它的人收到說明
  mode = 'badkey';
  await kit.call(wang.token, '/api/messages', 'POST', { requestId: 'ui-2', project: '預設專案', text: '@示範助理 再整理一次', recipientIds: [aiId], replyFrom: [aiId] });
  await until(async () => (await kit.call(liu.token, '/api/my-ais')).body.items.find(x => x.participantId === aiId).cloud.state === 'error', 15000, '叫不醒');
  await login(liu.token, '/my-ai');
  await until(() => js("[...document.querySelectorAll('.ma-item')].some(x => x.innerText.includes('叫不醒'))"), 15000, "行 136");
  await js(`[...document.querySelectorAll('.ma-item')].find(x => x.innerText.includes('示範助理')).querySelector('[data-act="tab"][data-tab="cloud"]').click(); true`);
  await until(() => js("!!document.querySelector('.cl-alert')"), 5000, "行 138");
  assert.match(await js("document.querySelector('.cl-alert').innerText"), /公司地端」：金鑰被拒絕（401）/);
  await shot('myai-error-1280');
  const told = (await kit.call(wang.token, '/api/messages?limit=20')).body.items.find(m => m.text.startsWith('[通知] 示範助理 現在叫不醒'));
  assert.ok(told, '找它的人收到說明');

  // 6. 375
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await openPM(liu.token);
  await until(() => js("document.querySelectorAll('.mc-row').length === 2"), 15000, "行 147");
  assert.ok(await noHScroll(), '375 模型設定不橫向捲動');
  await shot('models-list-375');
  mode = 'ok';
  const conn = (await kit.call(liu.token, MC)).body.connections.find(c => c.name === '公司地端');
  assert.equal((await kit.call(liu.token, `${MC}/${conn.id}/test`, 'POST', {})).body.ok, true, '修好後測試連線成功');
  await until(async () => (await kit.call(liu.token, '/api/my-ais')).body.items.find(x => x.participantId === aiId).cloud.state === 'ready', 15000, '自動恢復');
  await login(liu.token, '/my-ai');
  await until(() => js("!!document.querySelector('#ai-new')"), 15000, "行 152");
  await click('#ai-new');
  await until(() => js("document.querySelector('[data-where=\"cloud\"]') && !document.querySelector('[data-where=\"cloud\"]').disabled"), 8000, "行 154");
  await click('[data-where="cloud"]');
  assert.ok(await noHScroll(), '375 新增 AI 不橫向捲動');
  await shot('new-ai-cloud-375');

  // 7. 英文介面
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await openPM(liu.token);
  await until(() => js("document.querySelectorAll('.mc-row').length === 2"), 15000, '英文模型設定');
  const enPage = await js("document.querySelector('.mc-page').innerText");
  assert.match(enPage, /Only project leads and admins can add, replace keys or delete\. Cloud AIs in this project can only use these settings\.[\s\S]*Usage is billed to the key pasted in this project/);
  assert.match(enPage, /🏠 Private model[\s\S]*Unencrypted[\s\S]*✓ Working/);
  assert.match(enPage, /Test connection/);
  const leftover = enPage.split('\n').filter(l => /[一-鿿]/.test(l) && !/公司地端|Gemini 免費額度|劉昱志/.test(l));
  assert.deepEqual(leftover, [], '模型設定頁沒有漏翻的中文');
  await shot('models-list-en-1280');
  await login(liu.token, '/my-ai');
  await until(() => js("[...document.querySelectorAll('.ma-item')].some(x => x.innerText.includes('示範助理'))"), 15000, '英文我的 AI');
  await js(`[...document.querySelectorAll('.ma-item')].find(x => x.innerText.includes('示範助理')).querySelector('[data-act="tab"][data-tab="cloud"]').click(); true`);
  await until(() => js("!!document.querySelector('.cl-panel')"), 5000, '英文雲端分頁');
  const enRow = await js("[...document.querySelectorAll('.ma-item')].find(x => x.innerText.includes('示範助理')).innerText");
  assert.match(enRow, /Ready anytime/);
  assert.match(enRow, /☁️ Cloud · 🏠 Private model "公司地端" · qwen2\.5:14b/);
  assert.match(enRow, /Per-turn limit: up to 20 tool calls/);
  await shot('myai-cloud-en-1280');
  await click('#ai-new');
  await until(() => js("document.querySelector('[data-where=\"cloud\"]') && !document.querySelector('[data-where=\"cloud\"]').disabled"), 8000, '英文雲端卡');
  await click('[data-where="cloud"]');
  assert.match(await js("document.querySelector('.ai-where').innerText"), /Where does this AI run\?[\s\S]*On the platform \(cloud AI\)[\s\S]*Per-turn limit/);
  await shot('new-ai-cloud-en-1280');

  console.log('cloud-ai-ui-test：全部通過（模型設定新增／私人模型／未加密／公網 http 擋／讀模型清單／儲存並測試、成員雲端卡灰掉、管理員建雲端 AI 不用接入、正在處理…、回覆標 🏠、今天用量與最近幾輪、每輪上限、金鑰錯誤叫不醒、到上限的 [受阻] 與要你處理三顆鈕、AI 列處理中、375、英文介面）');
} finally {
  await kit.stop();
  fake.close();
}
