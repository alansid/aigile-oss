// 雲端 AI 第一階段驗收測試，用假的模型伺服器（不需要真金鑰）
// 1. 網址規則：https 照常、公網 http 擋、內網 http 標未加密、metadata 位址兩版都擋、平台版擋內網
// 2. 模型設定只有管理員能看能改；金鑰加密存、只回末 4 碼，任何回應與資料表都沒有完整金鑰；主密鑰不在資料庫
// 3. 測試連線：成功、金鑰被拒（401）；讀模型清單
// 4. 只有管理員能新增雲端 AI；成員表標 ☁️ 雲端、隨時可叫醒；Token 不會過期
// 5. 被 @ 跑一輪：模型呼叫工具發文 → 回覆、確認通知、記用量；只回文字時平台替它回
// 6. 每輪上限：工具次數到上限停下，代發 [受阻] 給主人（要你處理）；主人「再跑一輪」
// 7. 金鑰錯誤：叫不醒、管理員只通知一次、找它的人收到說明；測試連線成功後自動恢復並處理留著的訊息
// 8. 連不到：排定 10 分鐘後重試；Anthropic 格式也能跑工具
// 用法：node scripts/cloud-ai-test.js（設 AIGILE_TEST_PG_URL 就改用本機 Postgres）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';
import http from 'node:http';
import { checkModelUrl, createModelClient, dohGuard, ModelError } from '../src/cloud-ai.js';
import { nodeModelFetch } from '../src/cloud-fetch-node.js';

// ---------- 1. 網址規則 ----------
{
  const ok = (u, o) => checkModelUrl(u, o);
  assert.equal(ok('https://api.openai.com/v1').ok, true);
  assert.equal(ok('http://api.example.com').code, 'NEED_HTTPS', '公網 http 擋');
  const lan = ok('http://10.0.0.5:11434/v1');
  assert.ok(lan.ok && lan.insecure && lan.privateNet, '內網 http 可以、標未加密');
  assert.ok(ok('http://gpu-box:8000/v1').ok, '沒有點的主機名算內網');
  for (const u of ['http://169.254.169.254/latest', 'https://metadata.google.internal/', 'http://[::ffff:169.254.169.254]/', 'http://0.0.0.0:80', 'http://2852039166/'])
    assert.equal(ok(u).code, 'BLOCKED', 'metadata 位址擋：' + u);
  for (const u of ['http://localhost:11434/v1', 'https://10.0.0.5/v1', 'https://192.168.1.2/v1', 'http://[::1]:8080'])
    assert.equal(ok(u, { hosted: true }).code, 'HOSTED_PRIVATE', '平台版擋內網：' + u);
  assert.equal(ok('ftp://x.com').ok, false);
  assert.equal(ok('https://user:pw@api.openai.com').ok, false, '網址不能帶帳密');
}

// ---------- 假的模型伺服器 ----------
const KEY = 'sk-test-SECRET-abcdefgh-Ij1G';
const calls = [];
let script = [];
let mode = 'ok';
const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const usage = (p, c) => ({ prompt_tokens: p, completion_tokens: c, total_tokens: p + c });
const say = text => ({ choices: [{ message: { role: 'assistant', content: text } }], usage: usage(900, 100) });
const toolCall = (name, args, id = 'c' + Math.random().toString(36).slice(2, 8)) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: usage(1500, 200) });
async function cloudFetch(url, init = {}) {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: u, headers: init.headers || {}, body });
  assert.equal(init.redirect, 'manual', '模型請求不跟轉址');
  if (mode === 'down') throw new TypeError('fetch failed');
  if (mode === 'badkey') return res(401, { error: { message: 'Incorrect API key provided: ' + KEY } });
  if (mode === 'ws400') return res(400, { type: 'error', error: { type: 'invalid_request_error', message: 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header. Key: ' + (init.headers?.Authorization || '').replace('Bearer ', '') } });
  if (mode === 'echo400') return res(400, { error: { message: 'x'.repeat(130) + (init.headers?.Authorization || '').replace('Bearer ', '') + ' tail' } }); // 金鑰剛好跨在第 160 字
  if (u.endsWith('/models')) return res(200, { data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/gemini-2.5-pro' }] });
  if (u.endsWith('/v1/models')) return res(200, { data: [{ id: 'claude-x' }] });
  if (body?.max_tokens === 16) return u.endsWith('/v1/messages') ? res(200, { content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 5, output_tokens: 1 } }) : res(200, say('OK'));
  const next = script.shift();
  if (!next) return res(200, say('（沒有安排的回應）'));
  return typeof next === 'function' ? next(body, u) : res(200, next);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-cloud-ai-'));
const openDb = openTestDb;
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const docStorage = memStorage();
const app = createApp({ db, storage: dbStorage(db), docStorage, docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0', cloudAuto: '0', cloudFetch, hosted: true } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }), 'http://localhost');
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j, text };
};
const sqlAll = (q, ...a) => db.all(q, ...a);
const drain = async () => { await app.flushBackground(); await app.cloudDrain(); await app.flushBackground(); };
let seq = 0;
const MC = '/api/projects/' + encodeURIComponent('預設專案') + '/model-connections'; // 模型設定掛在專案下
const post = (tok, body) => call(tok, '/api/messages', 'POST', { requestId: 'r' + ++seq, project: '預設專案', ...body });

try {
  const admin = (await call(null, '/api/join', 'POST', { name: '管理員', role: 'PO' })).body;
  const member = (await call(null, '/api/join', 'POST', { name: '小明', role: '業務' })).body;
  assert.equal((await call(admin.token, `/api/participants/${member.participant.participantId}/projects`, 'PUT', { projects: ['預設專案'] })).status, 200);
  const A = admin.participant.participantId, M = member.participant.participantId;

  // ---------- 2. 模型設定：只有管理員 ----------
  const ml = await call(member.token, MC);
  assert.equal(ml.status, 200, '成員唯讀看得到專案的模型設定');
  assert.equal(ml.body.canEdit, false);
  assert.equal((await call(member.token, MC, 'POST', { kind: 'gemini', name: 'x' })).status, 403);
  const list0 = (await call(admin.token, MC)).body;
  assert.equal(list0.masterKey, 'ok', '有地方放主密鑰（自動產生）');
  assert.equal(list0.hosted, true);
  assert.equal(list0.customUrl, false, '平台版不能自訂網址');
  assert.deepEqual(list0.kinds.map(k => k.key), ['gemini', 'openai', 'anthropic'], '平台版只列三家官方');
  assert.equal((await call(admin.token, MC, 'POST', { kind: 'ollama', name: '地端' })).body.error.code, 'OFFICIAL_ONLY', '平台版不能用 Ollama');
  assert.equal((await call(admin.token, MC, 'POST', { kind: 'custom', name: '代理', url: 'http://proxy.example.com/v1' })).body.error.code, 'OFFICIAL_ONLY');
  const created = await call(admin.token, MC, 'POST', { kind: 'gemini', name: 'Gemini 免費額度', key: KEY, models: ['gemini-2.5-flash'] });
  assert.equal(created.status, 201, created.text);
  const conn = created.body.connection;
  assert.equal(conn.keyLast4, 'Ij1G');
  assert.equal(conn.official, true);
  assert.equal(conn.private, false);
  assert.ok(!created.text.includes(KEY) && !created.text.includes('SECRET'), '回應沒有完整金鑰');
  const row = (await sqlAll('SELECT key_enc FROM model_connections WHERE id = ?', conn.id))[0];
  assert.ok(row.key_enc.startsWith('v1:') && !row.key_enc.includes('SECRET'), '資料表存加密後的金鑰');
  assert.ok(await docStorage.get('_secrets/model-master-key'), '主密鑰存在資料庫以外（文件儲存區）');
  const settingsDump = JSON.stringify(await sqlAll('SELECT * FROM app_settings'));
  assert.ok(!settingsDump.includes('SECRET'), 'app_settings 也沒有金鑰');
  // 私人模型：改網址
  // 平台版只准官方網址（自訂網址延後）：新增、改網址都擋；舊資料裡的自訂網址，送出前也擋、不會連出去
  const priv = await call(admin.token, MC, 'POST', { kind: 'custom', name: 'Azure 代理', url: 'https://demo-proxy.example.com/v1', models: ['gpt-4o'] });
  assert.equal(priv.status, 400);
  assert.equal(priv.body.error.code, 'OFFICIAL_ONLY');
  assert.equal((await call(admin.token, MC, 'POST', { kind: 'gemini', name: 'G2', url: 'https://gemini-proxy.example.com/v1beta/openai/', models: ['m'] })).body.error.code, 'OFFICIAL_ONLY', '官方種類改網址也擋');
  assert.equal((await call(admin.token, `${MC}/${conn.id}`, 'PATCH', { url: 'https://evil.example.com/v1' })).body.error.code, 'OFFICIAL_ONLY', '改網址擋');
  await db.run("INSERT INTO model_connections (id, project, name, kind, url, key_enc, key_last4, models, status, created_at, updated_at) VALUES ('mc_old', '預設專案', '舊自訂', 'custom', 'https://old-proxy.example.com/v1', '', '', '[\"m\"]', 'ok', 'x', 'x')");
  const before463 = calls.length;
  const oldTest = (await call(admin.token, MC + '/mc_old/test', 'POST', {})).body;
  assert.equal(oldTest.ok, false);
  assert.match(oldTest.message, /平台版只能用官方網址/);
  assert.equal(calls.length, before463, '舊的自訂網址沒有連出去');
  await db.run("DELETE FROM model_connections WHERE id = 'mc_old'");

  // ---------- 3. 讀模型清單、測試連線 ----------
  const disc = (await call(admin.token, MC + '/discover', 'POST', { id: conn.id })).body;
  assert.deepEqual(disc.models, ['gemini-2.5-flash', 'gemini-2.5-pro'], '讀到模型清單（去掉 models/ 前綴）');
  assert.ok(calls.at(-1).headers.Authorization === 'Bearer ' + KEY, '伺服器用解開的金鑰呼叫供應者');
  mode = 'badkey';
  const bad = (await call(admin.token, `${MC}/${conn.id}/test`, 'POST', {})).body;
  assert.equal(bad.ok, false);
  assert.match(bad.message, /金鑰被拒絕（401）。請按「換金鑰」重貼/);
  assert.ok(!JSON.stringify(bad).includes('SECRET'), '供應者錯誤訊息裡的金鑰不回傳');
  mode = 'ok';
  const good = (await call(admin.token, `${MC}/${conn.id}/test`, 'POST', {})).body;
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.match(good.message, /^連線成功：gemini-2\.5-flash 回應 \d+\.\d 秒$/);
  assert.equal(good.connection.status, 'ok');
  // 換金鑰：記末 4 碼舊 → 新
  const KEY2 = 'sk-second-key-WXYZ';
  assert.equal((await call(admin.token, `${MC}/${conn.id}`, 'PATCH', { key: KEY2 })).body.connection.keyLast4, 'WXYZ');
  const log = (await call(admin.token, MC)).body.log;
  assert.match(log[0].text, /更換金鑰 ••••Ij1G → ••••WXYZ/, JSON.stringify(log));
  assert.ok(!JSON.stringify(log).includes('SECRET'));
  assert.equal((await call(admin.token, `${MC}/${conn.id}/test`, 'POST', {})).body.ok, true);

  // ---------- 4. 新增雲端 AI ----------
  const opts = (await call(admin.token, '/api/cloud-ai/options')).body;
  assert.equal(opts.canCreate, true);
  assert.deepEqual(opts.projects.find(p => p.project === '預設專案').choices.map(c => c.model), ['gemini-2.5-flash'], '只列可以用的設定與勾選的模型（Azure 代理還沒測試）');
  assert.equal((await call(member.token, '/api/cloud-ai/options')).body.reason, 'not_leader', '成員不是負責人也不是管理員');
  const aiBody = { runtime: 'cloud', connectionId: conn.id, model: 'gemini-2.5-flash', project: '預設專案', roleKey: 'PO', role: 'PO', name: '示範助理', duties: '整理進度', style: '簡短', autonomy: '中', mustConfirm: '無', handoff: '寫清楚' };
  assert.equal((await call(member.token, '/api/my-ais', 'POST', aiBody)).status, 403, '成員不能新增雲端 AI');
  assert.equal((await call(admin.token, '/api/my-ais', 'POST', { ...aiBody, model: 'gemini-9' })).status, 400, '沒勾選的模型不行');
  const ai = await call(admin.token, '/api/my-ais', 'POST', aiBody);
  assert.equal(ai.status, 201, ai.text);
  const AI = ai.body.participantId;
  assert.equal(ai.body.cloud.maxTools, 20);
  assert.equal(ai.body.cloud.maxTokens, 50000);
  assert.equal((await sqlAll('SELECT token_expires_at FROM participants WHERE id = ?', AI))[0].token_expires_at, 0);
  const team = (await call(member.token, '/api/participants')).body;
  const pAi = (team.items || team.participants || team).find?.(p => p.participantId === AI);
  assert.ok(pAi?.cloud && pAi.cloud.private === false, '成員表標雲端：' + JSON.stringify(pAi));
  assert.equal(pAi.isOnline, true, '雲端 AI 隨時可叫醒');

  // ---------- 5. 被 @ 跑一輪 ----------
  calls.length = 0;
  script = [
    toolCall('aigile_cards', { owner: 'any' }),
    (body) => { // 第二步：工具結果有回給模型，然後發文
      const lastTool = body.messages.filter(m => m.role === 'tool').at(-1);
      assert.ok(lastTool && lastTool.tool_call_id, '工具結果帶 tool_call_id 回給模型');
      assert.ok(body.messages[1].content.includes('整理這週進度'), '第一步就把通知內容給模型');
      return res(200, toolCall('aigile_post', { project: '預設專案', text: '[回覆] 這週進度：都在進行中。', replyToMessageId: m1.body.messageId }));
    },
    say('完成了。'),
  ];
  const m1 = await post(member.token, { text: '@示範助理 幫我整理這週進度', recipientIds: [AI], replyFrom: [AI] });
  assert.equal(m1.status, 201, m1.text);
  await drain();
  const chatCalls = calls.filter(c => c.url.endsWith('/chat/completions'));
  assert.equal(chatCalls.length, 3, '三步：查卡、發文、收尾');
  assert.ok(chatCalls[0].body.tools.some(t => t.function.name === 'aigile_post'), '有給工具');
  assert.ok(!chatCalls[0].body.tools.some(t => /review|doc_upload|memory|ack/.test(t.function.name)), '沒有寫程式、記憶、ack 工具');
  assert.ok(!JSON.stringify(chatCalls[0].body.tools).includes('additionalProperties'), '工具格式只留各家都吃的欄位');
  assert.match(chatCalls[0].body.messages[0].content, /示範助理/);
  const run1 = (await sqlAll('SELECT * FROM cloud_runs WHERE ai_id = ? ORDER BY started_at', AI))[0];
  assert.equal(run1.result, 'replied', JSON.stringify(run1));
  assert.equal(run1.tools, 2);
  assert.equal(run1.tokens, 1700 + 1700 + 1000);
  assert.match(run1.reason, /^小明：幫我整理這週進度$/, '叫醒原因：誰＋前 30 字');
  assert.equal(run1.state, '', '結束後清掉對話');
  const reply = (await sqlAll("SELECT text, reply_to FROM messages WHERE author_id = ? ORDER BY seq", AI)).at(-1);
  assert.equal(reply.text, '[回覆] 這週進度：都在進行中。');
  assert.equal(reply.reply_to, m1.body.messageId);
  assert.equal((await sqlAll("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND status = 'pending'", AI))[0].n, 0, '處理完確認通知');
  const mine = (await call(admin.token, '/api/my-ais')).body.items.find(x => x.participantId === AI);
  assert.equal(mine.cloud.today.runs, 1);
  assert.equal(mine.cloud.today.tokens, 4400);
  assert.equal(mine.cloud.runs[0].result, 'replied');
  assert.equal((await call(member.token, '/api/my-ais')).body.items.length, 0, '成員看不到別人的雲端 AI 用量');

  // 只回文字：平台替它回在那則訊息下
  script = [say('好的，我看過了，沒有問題。')];
  const m2 = await post(member.token, { text: '@示範助理 看一下', recipientIds: [AI], replyFrom: [AI] });
  await drain();
  const auto = (await sqlAll('SELECT text, reply_to FROM messages WHERE author_id = ? ORDER BY seq', AI)).at(-1);
  assert.equal(auto.text, '[回覆] 好的，我看過了，沒有問題。');
  assert.equal(auto.reply_to, m2.body.messageId);

  // 跑的時候又被叫醒：這輪結束再跑一輪（不並行）
  script = [say('第一則看完了。'), say('第二則也看完了。')];
  await post(member.token, { text: '@示範助理 第一則', recipientIds: [AI], replyFrom: [AI] });
  await app.flushBackground();
  await post(member.token, { text: '@示範助理 第二則', recipientIds: [AI], replyFrom: [AI] });
  await app.flushBackground();
  assert.equal((await sqlAll("SELECT COUNT(*) AS n FROM cloud_runs WHERE ai_id = ? AND result = 'running'", AI))[0].n, 1, '同一隻只跑一輪');
  await drain();
  assert.equal((await sqlAll("SELECT COUNT(*) AS n FROM cloud_runs WHERE ai_id = ? AND result = 'running'", AI))[0].n, 0);
  assert.equal((await sqlAll("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND status = 'pending'", AI))[0].n, 0, '兩則都處理完');

  // ---------- 6. 每輪上限 ----------
  assert.equal((await call(member.token, `/api/my-ais/${AI}/cloud`, 'PATCH', { maxTools: 2 })).status, 404, '別人的 AI 改不到');
  assert.equal((await call(admin.token, `/api/my-ais/${AI}/cloud`, 'PATCH', { maxTools: 0 })).status, 400);
  assert.equal((await call(admin.token, `/api/my-ais/${AI}/cloud`, 'PATCH', { maxTools: 2 })).body.cloud.maxTools, 2);
  script = [toolCall('aigile_cards', {}), toolCall('aigile_team', {}), toolCall('aigile_cards', {})];
  const m3 = await post(member.token, { text: '@示範助理 DEMO 大整理', recipientIds: [AI], replyFrom: [AI] });
  await drain();
  const lim = (await sqlAll('SELECT * FROM cloud_runs WHERE ai_id = ? ORDER BY started_at DESC LIMIT 1', AI))[0];
  assert.equal(lim.result, 'limit');
  assert.equal(lim.tools, 2);
  const blocked = (await sqlAll('SELECT id, text, reply_to FROM messages WHERE author_id = ? ORDER BY seq', AI)).at(-1);
  assert.match(blocked.text, /^\[受阻\] 這輪用到上限（2 次工具）/);
  assert.equal(blocked.reply_to, m3.body.messageId);
  const askOwner = await sqlAll("SELECT m.reply_from FROM notifications n JOIN messages m ON m.id = n.message_id WHERE n.recipient_id = ? AND n.message_id = ? AND n.status = 'pending'", A, blocked.id);
  assert.ok(askOwner.length && JSON.parse(askOwner[0].reply_from).includes(A), '主人「要你處理」有這則（要他回覆）');
  assert.equal((await sqlAll("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND status = 'pending'", AI))[0].n > 0, true, '到上限的通知留著');
  // 再跑一輪
  script = [say('接著做完了。')];
  assert.equal((await call(admin.token, `/api/my-ais/${AI}/cloud/run`, 'POST')).body.started, true);
  await drain();
  assert.equal((await sqlAll('SELECT result FROM cloud_runs WHERE ai_id = ? ORDER BY started_at DESC LIMIT 1', AI))[0].result, 'replied');
  await call(admin.token, `/api/my-ais/${AI}/cloud`, 'PATCH', { maxTools: 20 });

  // ---------- 7. 金鑰錯誤 ----------
  mode = 'badkey';
  const m4 = await post(member.token, { text: '@示範助理 金鑰壞了還找你', recipientIds: [AI], replyFrom: [AI] });
  await drain();
  let ag = (await call(admin.token, '/api/my-ais')).body.items.find(x => x.participantId === AI).cloud;
  assert.equal(ag.state, 'error');
  assert.match(ag.stateNote, /Gemini 免費額度.*金鑰被拒絕（401）/);
  const adminNotes = async () => (await sqlAll("SELECT text FROM messages WHERE author_id = ? AND text LIKE '[受阻] 示範助理 叫不醒%'", AI)).length;
  assert.equal(await adminNotes(), 1, '管理員收到一則');
  const told = await sqlAll("SELECT text, reply_to FROM messages WHERE author_id = ? AND text LIKE '[通知] 示範助理 現在叫不醒%'", AI);
  assert.equal(told.length, 1);
  assert.equal(told[0].reply_to, m4.body.messageId);
  assert.ok(!JSON.stringify(await sqlAll('SELECT text FROM messages')).includes('SECRET'), '訊息裡沒有金鑰');
  await post(member.token, { text: '@示範助理 再找一次', recipientIds: [AI], replyFrom: [AI] });
  await drain();
  assert.equal(await adminNotes(), 1, '同一組設定只通知管理員一次');
  assert.equal((await sqlAll("SELECT COUNT(*) AS n FROM messages WHERE author_id = ? AND text LIKE '[通知] 示範助理 現在叫不醒%'", AI))[0].n, 2, '每個找它的人都收到說明');
  assert.equal((await call(admin.token, `/api/my-ais/${AI}/cloud/run`, 'POST')).status, 409, '叫不醒時不能再跑一輪');
  // 修好：測試連線成功 → 自動恢復，留著的訊息再處理
  mode = 'ok';
  script = [say('抱歉剛剛叫不醒，現在處理好了。')];
  assert.equal((await call(admin.token, `${MC}/${conn.id}/test`, 'POST', {})).body.ok, true);
  await drain();
  ag = (await call(admin.token, '/api/my-ais')).body.items.find(x => x.participantId === AI).cloud;
  assert.equal(ag.state, 'ready');
  assert.equal(ag.runs[0].result, 'replied');
  assert.equal((await sqlAll("SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ? AND status = 'pending'", AI))[0].n, 0, '留著的訊息處理完了');

  // ---------- 8. 連不到：10 分鐘後重試 ----------
  mode = 'down';
  await post(member.token, { text: '@示範助理 連不到', recipientIds: [AI], replyFrom: [AI] });
  await drain();
  const r8 = (await sqlAll('SELECT * FROM cloud_runs WHERE ai_id = ? ORDER BY started_at DESC LIMIT 1', AI))[0];
  assert.equal(r8.result, 'running');
  assert.ok(r8.retry_at > Date.now() + 9 * 60_000, '排定約 10 分鐘後重試');
  assert.match((await call(admin.token, '/api/my-ais')).body.items.find(x => x.participantId === AI).cloud.stateNote, /⏳ 連不到這個網址.*自動再試一次/);
  await db.run('UPDATE cloud_runs SET retry_at = 1 WHERE id = ?', r8.id); // 時間到
  mode = 'ok';
  script = [say('連上了。')];
  await drain();
  assert.equal((await sqlAll('SELECT result FROM cloud_runs WHERE id = ?', r8.id))[0].result, 'replied');
  assert.equal((await call(admin.token, '/api/my-ais')).body.items.find(x => x.participantId === AI).cloud.state, 'ready');

  // Token 遺失（例如從備份還原，備份不帶 Token）：第一次跑時自己重發，照常回覆
  await db.run("UPDATE cloud_agents SET token_enc = '' WHERE ai_id = ?", AI);
  script = [say('Token 重發後照常。')];
  await post(member.token, { text: '@示範助理 還原後', recipientIds: [AI], replyFrom: [AI] });
  await drain();
  assert.equal((await sqlAll('SELECT text FROM messages WHERE author_id = ? ORDER BY seq', AI)).at(-1).text, '[回覆] Token 重發後照常。');
  assert.ok((await sqlAll('SELECT token_enc FROM cloud_agents WHERE ai_id = ?', AI))[0].token_enc.startsWith('v1:'), '重發的 Token 加密存回');

  // Anthropic 格式
  const an = (await call(admin.token, MC, 'POST', { kind: 'anthropic', name: 'Anthropic API', key: 'sk-ant-xyz-1234', models: ['claude-x'] })).body.connection;
  assert.equal((await call(admin.token, `${MC}/${an.id}/test`, 'POST', {})).body.ok, true);
  assert.equal(calls.at(-1).headers['x-api-key'], 'sk-ant-xyz-1234');
  const ai2 = (await call(admin.token, '/api/my-ais', 'POST', { ...aiBody, name: '安助理', connectionId: an.id, model: 'claude-x' })).body;
  script = [
    res(200, { content: [{ type: 'tool_use', id: 'tu1', name: 'aigile_team', input: {} }], usage: { input_tokens: 800, output_tokens: 50 } }),
    (body) => {
      const last = body.messages.at(-1);
      assert.equal(last.content[0].type, 'tool_result');
      assert.equal(last.content[0].tool_use_id, 'tu1');
      assert.ok(body.system.includes('安助理'));
      return res(200, { content: [{ type: 'text', text: '團隊都在忙。' }], usage: { input_tokens: 900, output_tokens: 20 } });
    },
  ];
  script = script.map(s => (typeof s === 'function' ? s : () => s)).map(f => (b, u) => f(b, u));
  await post(member.token, { text: '@安助理 大家在幹嘛', recipientIds: [ai2.participantId], replyFrom: [ai2.participantId] });
  await drain();
  const r9 = (await sqlAll('SELECT * FROM cloud_runs WHERE ai_id = ?', ai2.participantId))[0];
  assert.equal(r9.result, 'replied', JSON.stringify(r9));
  assert.equal(r9.tokens, 1770);
  assert.equal((await sqlAll('SELECT text FROM messages WHERE author_id = ? ORDER BY seq', ai2.participantId)).at(-1).text, '[回覆] 團隊都在忙。');


  // ---------- 9. 審查補強：錯誤訊息先遮金鑰再截斷 ----------
  mode = 'echo400';
  const echoed = (await call(admin.token, `${MC}/${conn.id}/test`, 'POST', {})).body;
  assert.equal(echoed.ok, false);
  const KEY_NOW = 'sk-second-key-WXYZ';
  for (let i = 0; i + 5 <= KEY_NOW.length; i++) assert.ok(!echoed.message.includes(KEY_NOW.slice(i, i + 5)), '截斷處不留下金鑰片段：' + echoed.message);
  assert.match(echoed.message, /••••/, '金鑰換成 ••••');
  mode = 'ok';
  assert.equal((await call(admin.token, `${MC}/${conn.id}/test`, 'POST', {})).body.ok, true);

  // 400 而且提到金鑰：附上供應者原文（正式站實測：Anthropic 使用者層級金鑰缺 workspace 標頭），金鑰照樣遮掉
  mode = 'ws400';
  const ws = (await call(admin.token, `${MC}/${conn.id}/test`, 'POST', {})).body;
  assert.equal(ws.ok, false);
  assert.equal(ws.status, 'key_error');
  assert.match(ws.message, /^金鑰被拒絕（400）：This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header/, '看得到供應者原文：' + ws.message);
  assert.match(ws.message, /。請按「換金鑰」重貼$/);
  for (let i = 0; i + 5 <= KEY_NOW.length; i++) assert.ok(!ws.message.includes(KEY_NOW.slice(i, i + 5)), '原文裡的金鑰遮掉：' + ws.message);
  mode = 'badkey';
  assert.equal((await call(admin.token, `${MC}/${conn.id}/test`, 'POST', {})).body.message, '金鑰被拒絕（401）。請按「換金鑰」重貼', '401 維持原本的文字');
  mode = 'ok';
  assert.equal((await call(admin.token, `${MC}/${conn.id}/test`, 'POST', {})).body.ok, true);

  // ---------- 10. 主密鑰：讀取出錯不覆寫；同時第一次建立只會有一把 ----------
  {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p463-mk-'));
    const db2 = await openDb(path.join(dir2, 'switch.db'));
    const base = memStorage();
    let failRead = false, slow = false;
    const store = { ...base,
      async read(k) { if (failRead) throw new Error('storage timeout'); if (slow) await new Promise(r => setTimeout(r, 30)); return base.read(k); },
      create: (k, b) => base.create(k, b) };
    const app2 = createApp({ db: db2, storage: dbStorage(db2), docStorage: store, docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0', cloudAuto: '0', cloudFetch, hosted: true } });
    const call2 = async (token, p, method = 'GET', body) => { const r = await app2(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }), 'http://localhost'); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const adm2 = (await call2(null, '/api/join', 'POST', { name: '管理員二', role: 'PO' })).body;
    slow = true; // 兩個請求都先讀到「沒有」，再同時建立
    const [c1, c2] = await Promise.all([
      call2(adm2.token, MC, 'POST', { kind: 'gemini', name: 'A 組', key: 'key-aaaa-1111', models: ['m1'] }),
      call2(adm2.token, MC, 'POST', { kind: 'openai', name: 'B 組', key: 'key-bbbb-2222', models: ['m2'] }),
    ]);
    slow = false;
    assert.equal(c1.status, 201); assert.equal(c2.status, 201);
    calls.length = 0;
    assert.equal((await call2(adm2.token, `${MC}/${c1.body.connection.id}/test`, 'POST', {})).body.ok, true, '同時建立後 A 組解得開');
    assert.equal((await call2(adm2.token, `${MC}/${c2.body.connection.id}/test`, 'POST', {})).body.ok, true, '同時建立後 B 組解得開');
    assert.deepEqual(calls.map(c => c.headers.Authorization), ['Bearer key-aaaa-1111', 'Bearer key-bbbb-2222'], '兩組都用同一把主密鑰解出原本的金鑰');
    const before = new TextDecoder().decode(await base.read('_secrets/model-master-key'));
    // 換一份程式（沒有快取）、儲存區暫時讀不到：不能當成沒有而產生新的
    const app3 = createApp({ db: db2, storage: dbStorage(db2), docStorage: store, docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0', cloudAuto: '0', cloudFetch, hosted: true } });
    failRead = true;
    const r3 = await app3(new Request('http://localhost' + MC, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm2.token }, body: JSON.stringify({ kind: 'gemini', name: 'C 組', key: 'key-cccc-3333', models: ['m1'] }) }), 'http://localhost');
    assert.equal(r3.status, 503);
    assert.equal((await r3.json()).error.code, 'MASTER_KEY_UNAVAILABLE');
    failRead = false;
    assert.equal(new TextDecoder().decode(await base.read('_secrets/model-master-key')), before, '讀取出錯時主密鑰沒被覆寫');
    await db2.close?.();
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // ---------- 11. 連線那一層：DNS 查到的位址是 metadata／內網就不連 ----------
  {
    let hits = 0;
    const local = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[{"id":"m"}]}'); });
    await new Promise(r => local.listen(0, '127.0.0.1', r));
    const port = local.address().port;
    const to = ip => (host, opts, cb) => cb(null, [{ address: ip, family: 4 }]);
    try {
      const okFetch = nodeModelFetch({ hosted: false, resolve: to('127.0.0.1') });
      assert.equal((await okFetch(`http://gpu-box:${port}/v1/models`)).status, 200, '開源版：內網照常連（對照組）');
      assert.equal(hits, 1);
      const metaFetch = nodeModelFetch({ hosted: false, resolve: to('169.254.169.254') });
      await assert.rejects(metaFetch(`http://gpu-box:${port}/v1/models`), e => e instanceof ModelError && e.kind === 'blocked' && /metadata/.test(e.message), '名稱指到 metadata：擋');
      const hostedFetch = nodeModelFetch({ hosted: true, resolve: to('127.0.0.1') });
      await assert.rejects(hostedFetch(`https://looks-public.example.com:${port}/v1/models`), e => e.kind === 'blocked', '平台版：公網名稱指到內網也擋');
      await assert.rejects(nodeModelFetch({ hosted: false })('http://169.254.169.254/latest/meta-data'), e => e.kind === 'blocked', '網址直接寫 metadata IP：不連');
      assert.equal(hits, 1, '被擋的都沒有連到伺服器');
      // 經過模型呼叫那一層：一樣擋、分類成 blocked
      const cl = createModelClient(metaFetch, { hosted: false });
      await assert.rejects(cl.listModels({ kind: 'custom', url: `http://gpu-box:${port}/v1` }, ''), e => e.kind === 'blocked');
      assert.equal(hits, 1);
    } finally { local.close(); }
    // 平台版：DNS over HTTPS 查到內網或 metadata 就不連
    const dohCalls = [];
    const fakeDoh = answers => async u => { dohCalls.push(String(u)); return new Response(JSON.stringify({ Status: 0, Answer: answers })); };
    await assert.rejects(dohGuard({ hosted: true, fetchImpl: fakeDoh([{ type: 1, data: '10.0.0.5' }]) })('https://evil.example.com/v1'), e => e.kind === 'blocked');
    await assert.rejects(dohGuard({ hosted: true, fetchImpl: fakeDoh([{ type: 5, data: 'x.example.' }, { type: 1, data: '169.254.169.254' }]) })('https://evil.example.com/v1'), e => e.kind === 'blocked');
    await dohGuard({ hosted: true, fetchImpl: fakeDoh([{ type: 1, data: '93.184.216.34' }]) })('https://api.example.com/v1');
    // 判斷不了就不連：DNS 查詢失敗、查無此主機、沒有任何 A／AAAA、DoH 服務出錯
    const rawDoh = body => async () => new Response(JSON.stringify(body));
    await assert.rejects(dohGuard({ hosted: true, fetchImpl: rawDoh({ Status: 2 }) })('https://api.example.com/v1'), e => e.kind === 'unreachable', 'SERVFAIL 不連');
    await assert.rejects(dohGuard({ hosted: true, fetchImpl: rawDoh({ Status: 3 }) })('https://nope.example.com/v1'), e => e.kind === 'unreachable', 'NXDOMAIN 不連');
    await assert.rejects(dohGuard({ hosted: true, fetchImpl: rawDoh({ Status: 0, Answer: [{ type: 5, data: 'only-cname.example.' }] }) })('https://api.example.com/v1'), e => e.kind === 'unreachable', '沒有 A／AAAA 不連');
    await assert.rejects(dohGuard({ hosted: true, fetchImpl: async () => new Response('busy', { status: 503 }) })('https://api.example.com/v1'), e => e.kind === 'unreachable', 'DoH 服務出錯不連');
    dohCalls.length = 0;
    await dohGuard({ hosted: true, fetchImpl: fakeDoh([]) })('https://8.8.8.8/v1');
    assert.equal(dohCalls.length, 0, 'IP 直接寫在網址裡不查 DNS（由網址規則擋）');
  }

  // 刪除整組設定：用它的 AI 叫不醒
  const del = (await call(admin.token, `${MC}/${an.id}`, 'DELETE')).body;
  assert.equal(del.affected, 1);
  assert.equal((await call(admin.token, '/api/my-ais')).body.items.find(x => x.participantId === ai2.participantId).cloud.state, 'error');

  console.log('cloud-ai-test：全部通過（網址規則、只有管理員、金鑰加密只回末 4 碼、測試連線、新增雲端 AI、被 @ 跑一輪、替它回覆、不並行、每輪上限與再跑一輪、金鑰錯誤只通知一次並自動恢復、連不到 10 分鐘後重試、Token 遺失自己重發、Anthropic 格式、平台版只准官方網址、刪除設定、錯誤訊息先遮金鑰、400 金鑰錯附供應者原文、主密鑰讀取出錯不覆寫與同時建立、連線層擋 metadata／內網、DNS over HTTPS 檢查）');
} finally {
  await db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
