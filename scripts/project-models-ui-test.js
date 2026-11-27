// 畫面測試：模型設定改成各專案自己設定
// 1. 系統設定 › 模型設定改成各專案總覽：搬家提示一次（知道了）、沒搬的舊設定列出
// 2. 專案 ⚙ › 模型設定：負責人可編輯（末 4 碼、變更紀錄、搬家紀錄）；一般成員唯讀（看得到用量，看不到末 4 碼、紀錄、按鈕）
// 3. 新增雲端 AI：先選專案，模型只列那個專案的設定；專案沒有設定時顯示提示、「建立」停用；建好的 AI 只在那個專案
// 4. 375 不橫向捲動
// 用法：node scripts/project-models-ui-test.js（PROJECT_MODELS_SHOTS=資料夾 會存截圖）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startKit, until, freePort } from './browser-kit.js';

const modelPort = await freePort();
const fake = http.createServer(async (req, res) => {
  for await (const _ of req);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'qwen2.5:14b' }] } : { choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 6 } }));
}).listen(modelPort, '127.0.0.1');

const kit = await startKit('project-models');
const shotDir = process.env.PROJECT_MODELS_SHOTS;
try {
  const join = async (name, role) => (await kit.call(null, '/api/join', 'POST', { name, role })).body;
  const id = u => u.participant.participantId;
  const liu = await join('劉昱志', 'PO'), lead = await join('林小安', 'SM'), chen = await join('陳小明', '業務');
  const p2 = await kit.call(liu.token, '/api/projects', 'POST', { name: '另一個專案' });
  const P2 = p2.body.id;
  assert.equal((await kit.call(liu.token, `/api/participants/${id(lead)}/projects`, 'PUT', { projects: ['預設專案', P2] })).status, 200);
  assert.equal((await kit.call(liu.token, `/api/participants/${id(chen)}/projects`, 'PUT', { projects: ['預設專案'] })).status, 200);
  assert.equal((await kit.call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(lead), leaderOf: ['預設專案', P2] }] })).status, 200);

  // 舊版留下的全站設定：一組有雲端 AI 在用、一組沒人用（還沒有任何請求碰過模型設定，伺服器第一次用到時搬）
  const old = await kit.call(liu.token, '/api/my-ais', 'POST', { name: '舊雲端助理', projects: ['預設專案'], roleKey: 'PO', role: 'PO', duties: '整理', style: '簡短', autonomy: '中', mustConfirm: '無', handoff: '寫清楚' });
  assert.equal(old.status, 201);
  const url = `http://127.0.0.1:${modelPort}/v1`;
  kit.sql(`INSERT INTO model_connections (id, name, kind, url, key_enc, key_last4, models, status, created_at, updated_at) VALUES ('mc_old', '舊的地端', 'custom', ?, 'v1:x:y', 'AB12', '["qwen2.5:14b"]', 'ok', 'x', 'x')`, url);
  kit.sql(`INSERT INTO model_connections (id, name, kind, url, key_enc, key_last4, models, status, created_at, updated_at) VALUES ('mc_unused', '沒人用的', 'gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/', 'v1:x:y', 'CD34', '["m"]', 'ok', 'x', 'x')`);
  kit.sql("INSERT INTO cloud_agents (ai_id, connection_id, model, token_enc) VALUES (?, 'mc_old', 'qwen2.5:14b', '')", old.body.participantId);

  const { js, cdp, login } = await kit.browser(1280, 900);
  const shot = async name => { if (!shotDir) return; fs.mkdirSync(shotDir, { recursive: true }); const r = await cdp('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shotDir, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  const click = sel => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
  const text = sel => js(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`);
  const noHScroll = () => js('document.documentElement.scrollWidth <= innerWidth + 1');
  const openPM = async tok => {
    await login(tok, '/p/main/messages');
    await until(() => js("!!document.querySelector('[data-pset]')"), 15000, '專案 ⚙');
    await click('[data-pset]');
    await until(() => js("!!document.querySelector('#pset-menu [data-pset-act=\"models\"]')"), 5000, '⚙ 選單有模型設定');
    await click('#pset-menu [data-pset-act="models"]');
    await until(() => js("!!document.querySelector('#mc-proj .mc-row')"), 8000, '專案模型設定');
  };

  // 1. 系統設定總覽
  await login(liu.token, '/admin/models');
  await until(() => js("!!document.querySelector('.mc-over')"), 15000, '各專案總覽');
  const ov = await text('.mc-page');
  assert.match(ov, /模型設定已改成各專案自己設定（11\/26）。原本的「舊的地端」已搬到有雲端 AI 在用的「預設專案」，金鑰不變，雲端 AI 不用重設。/);
  assert.match(ov, /金鑰改在「專案 ⚙ › 模型設定」設定/);
  assert.match(ov, /還沒搬的舊全站設定 · 1[\s\S]*沒人用的/);
  assert.ok(!(await js("!!document.querySelector('.mc-page [data-mc=\"new\"]')")), '總覽不能新增');
  assert.ok((await js("[...document.querySelectorAll('.mc-over tbody tr')].map(r => r.innerText)")).some(t => /預設專案\s+1\s+1\s+0/.test(t)), '預設專案：1 組、1 隻雲端 AI');
  await shot('1-總覽-1280');
  await click('[data-mcadm="seen"]');
  await until(() => js("!document.querySelector('.mc-moved')"), 5000, '知道了之後不再提示');

  // 2. 負責人：可編輯
  await openPM(lead.token);
  const lt = await text('#mc-proj');
  assert.match(await text('#modal-root .modal'), /☁️ 模型設定 · 預設專案/);
  assert.match(lt, /只有專案負責人和管理員能新增、換金鑰、刪除。這個專案的雲端 AI 只能用這裡的設定。/);
  assert.match(lt, /舊的地端[\s\S]*1 隻 AI[\s\S]*金鑰 ••••AB12[\s\S]*今天 0 輪 · 0 token/);
  assert.match(lt, /費用算在這個專案貼的金鑰上，用量也記在本專案。/);
  assert.match(lt, /變更紀錄[\s\S]*系統[\s\S]*從全站設定搬過來：舊的地端（••••AB12）/);
  assert.ok(await js("!!document.querySelector('#mc-proj [data-mc=\"new\"]') && !!document.querySelector('#mc-proj [data-mc=\"edit\"]')"));
  assert.ok(!/[0-9]{2}:[0-9]{2}:[0-9]{2}/.test(lt), '時間不顯示秒數');
  await shot('2-負責人-1280');
  await click('#mc-proj [data-mc="new"]');
  await until(() => js("!!document.querySelector('#mc-form')"), 5000, '新增表單');
  assert.match(await text('#modal-root .modal'), /新增模型設定 · 預設專案/);
  await click('#modal-root [data-mc="back"]');
  await until(() => js("!!document.querySelector('#mc-proj .mc-row')"), 5000, '返回清單');

  // 一般成員：唯讀
  await openPM(chen.token);
  const mt = await text('#mc-proj');
  assert.match(mt, /只有專案負責人（林小安）和管理員能改。要新增或換金鑰請找他們。/);
  assert.match(mt, /舊的地端[\s\S]*1 隻 AI[\s\S]*自訂 OpenAI 相容 · qwen2\.5:14b[\s\S]*今天 0 輪/);
  assert.ok(!mt.includes('••••') && !mt.includes('AB12'), '看不到末 4 碼');
  assert.ok(!mt.includes('變更紀錄'), '看不到變更紀錄');
  assert.equal(await js("document.querySelectorAll('#mc-proj [data-mc]').length"), 0, '沒有按鈕');
  await shot('3-一般成員-1280');

  // 3. 新增雲端 AI
  await login(lead.token, '/my-ai');
  await until(() => js("!!document.querySelector('#ai-new')"), 15000, '我的 AI');
  await click('#ai-new');
  await until(() => js("document.querySelector('[data-where=\"cloud\"]') && !document.querySelector('[data-where=\"cloud\"]').disabled"), 8000, '雲端卡可以選');
  await click('[data-where="cloud"]');
  assert.deepEqual(await js("[...document.querySelectorAll('.cloud-proj input')].map(i => i.parentElement.innerText.trim())"), ['預設專案', '另一個專案'], '只列自己負責的專案');
  assert.equal(await js("document.querySelector('.new-ai-proj').closest('.field').hidden"), true, '雲端不顯示多選專案');
  await js("(() => { const i = [...document.querySelectorAll('.cloud-proj input')].find(x => x.value === '預設專案'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  assert.deepEqual(await js("[...document.querySelectorAll('[name=\"cloudChoice\"] option')].map(o => o.textContent)"), ['舊的地端 · qwen2.5:14b · 🏠 私人模型']);
  assert.match(await text('.cloud-model-hint'), /預設專案的模型設定。費用算在這個專案的金鑰上。/);
  await shot('4-新增雲端AI-1280');
  await js(`(() => { const i = [...document.querySelectorAll('.cloud-proj input')].find(x => x.value === ${JSON.stringify(P2)}); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  assert.equal(await js("document.querySelector('.cloud-model').hidden"), true, '沒有設定：模型欄換成提示');
  assert.match(await text('.cloud-empty'), /另一個專案還沒有模型設定，雲端 AI 要先有一組金鑰才能用。[\s\S]*去設定模型 ›/);
  assert.equal(await js("document.querySelector('button[type=\"submit\"][form=\"ai-form\"]').disabled"), true, '「建立」停用');
  await shot('5-專案沒有設定-1280');
  await js("(() => { const i = [...document.querySelectorAll('.cloud-proj input')].find(x => x.value === '預設專案'); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  assert.equal(await js("document.querySelector('button[type=\"submit\"][form=\"ai-form\"]').disabled"), false);
  await js("(() => { const e = document.querySelector('#ai-form [name=\"name\"]'); e.value = '專案助理'; e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
  await click('button[type="submit"][form="ai-form"]');
  await until(async () => (await kit.call(lead.token, '/api/my-ais')).body.items.some(x => x.name === '專案助理'), 10000, '建好').catch(async e => { console.log('表單錯誤：', await js("[...document.querySelectorAll('#ai-form .error, #ai-error')].map(x => x.textContent).join(' | ')")); throw e; });
  assert.deepEqual((await kit.call(lead.token, '/api/my-ais')).body.items.find(x => x.name === '專案助理').projects, ['預設專案'], '雲端 AI 只在選的專案');

  // 4. 375
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await openPM(chen.token);
  assert.ok(await noHScroll(), '375 一般成員模型設定不橫向捲動');
  await shot('6-一般成員-375');
  await openPM(lead.token);
  assert.ok(await noHScroll(), '375 負責人模型設定不橫向捲動');
  assert.equal(await js("getComputedStyle(document.querySelector('#mc-proj .mc-log')).display"), 'none', '375 不用三欄表格');
  assert.match(await text('#mc-proj .mc-log-list li'), /^[0-9]+[/][0-9]+ [0-9]{2}:[0-9]{2} · 系統[^從]*從全站設定搬過來：舊的地端（••••AB12）$/, '375 變更紀錄每筆兩行');
  await shot('7-負責人-375');
  await login(liu.token, '/admin/models');
  await until(() => js("!!document.querySelector('.mc-over')"), 15000, '375 總覽');
  assert.ok(await noHScroll(), '375 總覽不橫向捲動');
  assert.equal(await js("getComputedStyle(document.querySelector('.mc-over')).display"), 'none', '375 不用表格');
  const rows = await js("[...document.querySelectorAll('.mc-over-list li')].map(li => li.innerText.split(String.fromCharCode(10)).map(x => x.trim()).filter(Boolean).join(' '))");
  assert.ok(rows.includes('預設專案 1 組設定 · 2 隻雲端 AI · 今天 0 token'), '375 總覽一個專案兩行：' + rows.join(' / '));
  assert.ok(rows.some(r => r.endsWith('還沒有設定')), '沒設定的寫還沒有設定');
  await shot('8-總覽-375');

  // 5. 英文 375：長字不被截、沒有漏翻
  await js("localStorage.setItem('aigile-lang', 'en'); true");
  await openPM(lead.token);
  const en = await text('#mc-proj');
  assert.ok(en.includes('Only project leads and admins can add, replace keys or delete.'));
  assert.match(en, /Today: 0 turns · 0 tokens/);
  assert.ok(await noHScroll(), '英文 375 負責人不橫向捲動');
  assert.deepEqual(en.split(String.fromCharCode(10)).filter(l => /[一-鿿]/.test(l) && !/舊的地端/.test(l)), [], '英文負責人頁沒有漏翻');
  assert.ok(en.includes('Moved from site-wide settings: 舊的地端 (••••AB12)') && en.includes('System'), '搬家紀錄照語言組字');
  assert.equal(await js("document.querySelector('#modal-root .modal-foot [data-close]').textContent.trim()"), 'Close', '關閉按鈕是 Close');
  await shot('en-負責人-375');
  await login(lead.token, '/my-ai');
  await until(() => js("!!document.querySelector('#ai-new')"), 15000, '英文我的 AI');
  await click('#ai-new');
  await until(() => js("document.querySelector('[data-where=\"cloud\"]') && !document.querySelector('[data-where=\"cloud\"]').disabled"), 8000, '英文雲端卡');
  await click('[data-where="cloud"]');
  await js(`(() => { const i = [...document.querySelectorAll('.cloud-proj input')].find(x => x.value === ${JSON.stringify(P2)}); i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  assert.ok((await text('.cloud-empty')).includes('has no model settings yet. A cloud AI needs a key first.') && (await text('.cloud-empty')).includes('Set up models ›'));
  assert.ok(await noHScroll(), '英文 375 新增 AI 不橫向捲動');
  await js("document.querySelector('.cloud-empty').scrollIntoView({ block: 'center' }); true");
  await shot('en-新增AI-專案沒有設定-375');
  await js("localStorage.removeItem('aigile-lang'); true");

  console.log('project-models-ui-test：全部通過（總覽與搬家提示、負責人可編輯與搬家紀錄、一般成員唯讀看用量、新增雲端 AI 先選專案只列本專案設定、沒有設定時提示並停用建立、只屬於選的專案、375 總覽與紀錄兩行、時間不顯示秒數、英文 375）');
} finally {
  await kit.stop();
  fake.close();
}
