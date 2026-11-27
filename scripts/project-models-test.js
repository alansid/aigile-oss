// 模型設定改成各專案自己設定的驗收測試
// 1. 搬家：舊版的全站設定有雲端 AI 在用的搬到那隻 AI 的專案；兩個專案都用到就各複製一組（同一把金鑰）；沒人用的留著，總覽列出；搬家提示看過一次就不再出現
// 2. 權限：專案負責人＋管理員能新增、改、刪；一般成員唯讀（看得到用量，看不到末 4 碼與變更紀錄）；不在專案的看不到
// 3. 新增雲端 AI：只能建在自己負責的專案，只能選那個專案的設定；一般成員不能建
// 4. 雲端 AI 只屬於一個專案：不能改所屬專案
// 5. 系統設定總覽：各專案設定數、雲端 AI 數；只能刪沒搬的舊全站設定
// 用法：node scripts/project-models-test.js（設 AIGILE_TEST_PG_URL 就改用本機 Postgres）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';

const res = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function cloudFetch(url) { // 假的模型伺服器：測試連線一律成功
  if (String(url).endsWith('/models')) return res(200, { data: [{ id: 'm1' }] });
  return res(200, { choices: [{ message: { role: 'assistant', content: 'OK' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-project-models-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const docStorage = memStorage();
const mkApp = (dbx = db, extra = {}) => createApp({ db: dbx, storage: dbStorage(db), docStorage, docText: '', config: { openJoin: '1', rateLimitPerMin: '10000', teamCacheMs: '0', cloudAuto: '0', cloudFetch, hosted: true, ...extra } });
let app = mkApp();
const callOn = async (ap, token, p, method = 'GET', body) => {
  const r = await ap(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }), 'http://localhost');
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j, text };
};
const call = (...a) => callOn(app, ...a);
const P1 = '預設專案';
const MC = pj => '/api/projects/' + encodeURIComponent(pj) + '/model-connections';
const aiSettings = { roleKey: 'PO', role: 'PO', duties: '整理進度', style: '簡短', autonomy: '中', mustConfirm: '無', handoff: '寫清楚' };

try {
  const admin = (await call(null, '/api/join', 'POST', { name: '管理員', role: 'PO' })).body;
  const lead = (await call(null, '/api/join', 'POST', { name: '負責人', role: 'PM' })).body;
  const member = (await call(null, '/api/join', 'POST', { name: '小明', role: '業務' })).body;
  const outsider = (await call(null, '/api/join', 'POST', { name: '外人', role: '業務' })).body;
  const A = admin.participant.participantId, L = lead.participant.participantId, M = member.participant.participantId, O = outsider.participant.participantId;
  const p2 = await call(admin.token, '/api/projects', 'POST', { name: '另一個專案' });
  assert.equal(p2.status, 201, p2.text);
  const P2 = p2.body.id;
  for (const [id, pjs] of [[L, [P1, P2]], [M, [P1]], [O, [P2]]])
    { const r = await call(admin.token, `/api/participants/${id}/projects`, 'PUT', { projects: pjs }); assert.equal(r.status, 200, r.text); }

  // ---------- 1. 搬家 ----------
  const ai1 = await call(admin.token, '/api/my-ais', 'POST', { ...aiSettings, name: '舊雲端一', projects: [P1] });
  const ai2 = await call(admin.token, '/api/my-ais', 'POST', { ...aiSettings, name: '舊雲端二', projects: [P2] });
  assert.equal(ai1.status, 201, ai1.text); assert.equal(ai2.status, 201, ai2.text);
  const old = (id, name, last4) => db.run(`INSERT INTO model_connections (id, name, kind, url, key_enc, key_last4, models, status, created_at, updated_at)
    VALUES (?, ?, 'gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/', 'v1:x:y', ?, '["m1"]', 'ok', 'x', 'x')`, id, name, last4);
  await old('mc_shared', '共用 Gemini', 'AB12');
  await old('mc_unused', '沒人用', 'CD34');
  for (const ai of [ai1, ai2]) await db.run("INSERT INTO cloud_agents (ai_id, connection_id, model, token_enc) VALUES (?, 'mc_shared', 'm1', '')", ai.body.participantId);
  await db.run("INSERT INTO app_settings (key, value) VALUES ('project_leaders', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ [P1]: [L] }));
  // 搬家中途失敗：整組回復，什麼都沒搬一半
  const flaky = { ...db, batch: stmts => db.batch([...stmts.slice(0, 2), ['INSERT INTO no_such_table VALUES (1)', []]]) };
  const failed = await callOn(mkApp(flaky), admin.token, '/api/admin/model-connections');
  assert.equal(failed.status, 200, '搬家失敗頁面照常顯示');
  assert.equal(failed.body.unassigned.length, 2, '失敗的那組還在舊設定');
  assert.equal((await db.all("SELECT id FROM model_connections WHERE name = '共用 Gemini'")).length, 1, '沒有複製一半');
  assert.equal((await db.get("SELECT project FROM model_connections WHERE id = 'mc_shared'")).project, '', '沒有標一半');
  assert.equal((await db.all("SELECT ai_id FROM cloud_agents WHERE connection_id = 'mc_shared'")).length, 2, '雲端 AI 沒有重綁一半');
  // 兩份程式同時搬：只有一份搬成功，不會重複複製
  const [ra, rb] = await Promise.all([callOn(mkApp(), admin.token, '/api/admin/model-connections'), callOn(mkApp(), admin.token, '/api/admin/model-connections')]);
  assert.equal(ra.status, 200); assert.equal(rb.status, 200);
  assert.equal(JSON.parse((await db.get("SELECT value FROM app_settings WHERE key = 'model_conn_moved'")).value).items.length, 2, '同時搬只記一次搬家');
  app = mkApp(); // 換一份程式＝升級新版：負責人重新讀、搬家在第一次用到時跑

  const ov = (await call(admin.token, '/api/admin/model-connections')).body;
  const rows = await db.all("SELECT id, project, key_enc, key_last4 FROM model_connections WHERE name = '共用 Gemini' ORDER BY project");
  assert.deepEqual(rows.map(r => r.project).sort(), [P1, P2].sort(), '兩個專案的雲端 AI 都用到：各一組');
  assert.ok(rows.every(r => r.key_enc === 'v1:x:y' && r.key_last4 === 'AB12'), '複製的是同一把金鑰');
  const agents = await db.all('SELECT a.ai_id, c.project FROM cloud_agents a JOIN model_connections c ON c.id = a.connection_id');
  assert.equal(agents.find(a => a.ai_id === ai1.body.participantId).project, P1, '雲端 AI 改用自己專案那組');
  assert.equal(agents.find(a => a.ai_id === ai2.body.participantId).project, P2);
  assert.deepEqual(ov.unassigned.map(x => x.name), ['沒人用'], '沒人用的不搬，總覽列出');
  assert.deepEqual(ov.moved.map(x => x.project).sort(), [P1, P2].sort(), '第一次打開有搬家提示');
  assert.equal(ov.projects.find(p => p.project === P1).connections, 1);
  assert.equal(ov.projects.find(p => p.project === P1).cloudAis, 1);
  assert.equal((await call(lead.token, '/api/admin/model-connections')).status, 403, '總覽只有管理員');
  const log1 = (await call(admin.token, MC(P1))).body.log;
  assert.match(log1[0].text, /從全站設定搬過來：共用 Gemini（••••AB12）/);
  assert.equal(log1[0].byName, '系統');
  assert.deepEqual(log1[0].moved, { name: '共用 Gemini', last4: 'AB12' }, '搬家紀錄另存名稱與末 4 碼，畫面照語言組字');
  assert.equal((await call(admin.token, '/api/admin/model-connections/moved-seen', 'POST', {})).status, 200);
  assert.deepEqual((await call(admin.token, '/api/admin/model-connections')).body.moved, [], '看過就不再提示');
  app = mkApp();
  await call(admin.token, '/api/admin/model-connections');
  assert.equal((await db.all("SELECT id FROM model_connections WHERE name = '共用 Gemini'")).length, 2, '再跑一次不會重複搬');

  // ---------- 2. 權限 ----------
  const made = await call(lead.token, MC(P1), 'POST', { kind: 'openai', name: '專案 OpenAI', key: 'sk-lead-key-9876', models: ['m1'] });
  assert.equal(made.status, 201, made.text);
  const leadConn = made.body.connection;
  assert.equal(leadConn.project, P1);
  assert.equal((await call(lead.token, MC(P1), 'POST', { kind: 'openai', name: '專案 OpenAI', models: ['m1'] })).body.error.code, 'DUPLICATE_NAME', '同專案不能同名');
  assert.equal((await call(lead.token, MC(P2), 'POST', { kind: 'openai', name: '專案 OpenAI', models: ['m1'] })).status, 403, '不是第二專案的負責人');
  assert.equal((await call(admin.token, MC(P2), 'POST', { kind: 'openai', name: '專案 OpenAI', models: ['m1'] })).status, 201, '不同專案可以同名；管理員每個專案都能設');
  assert.equal((await call(member.token, MC(P1), 'POST', { kind: 'openai', name: 'x', models: ['m1'] })).status, 403, '一般成員不能新增');
  assert.equal((await call(member.token, `${MC(P1)}/${leadConn.id}`, 'PATCH', { name: 'y' })).status, 403, '一般成員不能改');
  assert.equal((await call(member.token, `${MC(P1)}/${leadConn.id}`, 'DELETE')).status, 403, '一般成員不能刪');
  assert.equal((await call(lead.token, `${MC(P1)}/${leadConn.id}/test`, 'POST', {})).body.ok, true, '負責人能測試連線');
  const asMember = await call(member.token, MC(P1));
  assert.equal(asMember.status, 200);
  assert.equal(asMember.body.canEdit, false);
  assert.deepEqual(asMember.body.leaders, ['負責人']);
  assert.ok(asMember.body.connections.length === 2 && asMember.body.connections.every(c => c.keyLast4 === null), '一般成員看不到末 4 碼');
  assert.ok(asMember.body.connections.every(c => c.today && typeof c.today.tokens === 'number'), '一般成員看得到今天用量');
  assert.equal(asMember.body.log, undefined, '一般成員看不到變更紀錄');
  assert.ok(!asMember.text.includes('9876') && !asMember.text.includes('AB12'));
  assert.equal((await call(lead.token, MC(P1))).body.connections.find(c => c.id === leadConn.id).keyLast4, '9876', '負責人看得到末 4 碼');
  assert.equal((await call(outsider.token, MC(P1))).status, 403, '不在專案的看不到');
  const otherConn = (await db.get('SELECT id FROM model_connections WHERE project = ? AND name = ?', P2, '共用 Gemini')).id;
  assert.equal((await call(lead.token, `${MC(P1)}/${otherConn}`, 'PATCH', { name: 'z' })).status, 404, '不能從別的專案改');

  // ---------- 3. 新增雲端 AI ----------
  const optsL = (await call(lead.token, '/api/cloud-ai/options')).body;
  const o1 = optsL.projects.find(p => p.project === P1), o2 = optsL.projects.find(p => p.project === P2);
  assert.equal(optsL.canCreate, true);
  assert.equal(o1.canCreate, true);
  assert.equal(o2.canCreate, false, '第二專案不是他負責');
  assert.deepEqual(o1.choices.map(c => c.connectionId).sort(), [rows.find(r => r.project === P1).id, leadConn.id].sort(), '只列本專案可以用的設定');
  assert.equal((await call(member.token, '/api/cloud-ai/options')).body.reason, 'not_leader');
  const cloudBody = { ...aiSettings, runtime: 'cloud', name: '專案助理', project: P1, connectionId: leadConn.id, model: 'm1' };
  assert.equal((await call(member.token, '/api/my-ais', 'POST', cloudBody)).status, 403, '一般成員不能建雲端 AI');
  assert.equal((await call(lead.token, '/api/my-ais', 'POST', { ...cloudBody, connectionId: otherConn })).status, 400, '不能用別的專案的設定');
  assert.equal((await call(lead.token, '/api/my-ais', 'POST', { ...cloudBody, project: P2, connectionId: otherConn })).status, 403, '不能建在不是自己負責的專案');
  const cai = await call(lead.token, '/api/my-ais', 'POST', { ...cloudBody, projects: [P1, P2] });
  assert.equal(cai.status, 201, cai.text);
  assert.deepEqual(cai.body.projects, [P1], '雲端 AI 只屬於建立時選的專案');

  // ---------- 4. 只屬於一個專案 ----------
  const mv = await call(lead.token, `/api/my-ais/${cai.body.participantId}`, 'PATCH', { projects: [P1, P2] });
  assert.equal(mv.body.error?.code, 'CLOUD_ONE_PROJECT', mv.text);
  assert.equal((await call(admin.token, `/api/participants/${cai.body.participantId}/projects`, 'PUT', { projects: [P2] })).body.error?.code, 'CLOUD_ONE_PROJECT', '管理員改成員專案也擋');
  assert.equal((await call(lead.token, `/api/my-ais/${cai.body.participantId}`, 'PATCH', { projects: [P1] })).status, 200, '沒改專案照常存');
  assert.equal((await call(lead.token, `/api/my-ais/${cai.body.participantId}/cloud`, 'PATCH', { connectionId: otherConn, model: 'm1' })).status, 400, '換模型也只能選本專案的設定');

  // ---------- 5. 總覽與刪舊設定 ----------
  const ov2 = (await call(admin.token, '/api/admin/model-connections')).body;
  assert.equal(ov2.projects.find(p => p.project === P1).connections, 2);
  assert.equal(ov2.projects.find(p => p.project === P1).cloudAis, 2);
  assert.equal((await call(admin.token, `/api/admin/model-connections/${leadConn.id}`, 'DELETE')).status, 404, '總覽不能刪專案的設定');
  assert.equal((await call(admin.token, '/api/admin/model-connections/mc_unused', 'DELETE')).status, 200, '沒搬的舊設定可以刪');
  assert.deepEqual((await call(admin.token, '/api/admin/model-connections')).body.unassigned, []);
  const del = await call(lead.token, `${MC(P1)}/${leadConn.id}`, 'DELETE');
  assert.equal(del.body.affected, 1, '負責人能刪，用它的 AI 叫不醒');
  assert.match((await call(lead.token, MC(P1))).body.log[0].text, /專案 OpenAI：刪除整組設定/);

  // ---------- 6. 換網址不沿用存好的金鑰（可以自訂網址的開源版）----------
  const seen = [];
  const recFetch = async (url, init = {}) => { seen.push({ url: String(url), auth: (init.headers || {}).Authorization || '' }); return res(200, { data: [{ id: 'm1' }] }); };
  const own = mkApp(db, { hosted: false, cloudFetch: recFetch });
  const oc = await callOn(own, admin.token, MC(P1), 'POST', { kind: 'custom', name: '代理 A', url: 'https://a.example.com/v1', key: 'sk-old-key-1111', models: ['m1'] });
  assert.equal(oc.status, 201, oc.text);
  await callOn(own, admin.token, `${MC(P1)}/discover`, 'POST', { id: oc.body.connection.id, url: 'https://b.example.com/v1' });
  assert.ok(seen.length && seen.every(x => x.url.startsWith('https://b.example.com') && !x.auth.includes('sk-old')), '讀模型清單：新網址不帶存好的金鑰 ' + JSON.stringify(seen));
  const noKey = await callOn(own, admin.token, `${MC(P1)}/${oc.body.connection.id}`, 'PATCH', { url: 'https://b.example.com/v1' });
  assert.equal(noKey.body.error?.code, 'KEY_REQUIRED', '換網址沒重貼金鑰要擋');
  assert.equal((await callOn(own, admin.token, `${MC(P1)}/${oc.body.connection.id}`, 'PATCH', { url: 'https://b.example.com/v1', removeKey: true })).status, 200, '換網址同時刪金鑰可以');
  assert.equal((await callOn(own, admin.token, `${MC(P1)}/${oc.body.connection.id}`, 'PATCH', { url: 'https://c.example.com/v1', key: 'sk-new-key-2222' })).status, 200, '換網址並重貼可以');
  seen.length = 0;
  await callOn(own, admin.token, `${MC(P1)}/discover`, 'POST', { id: oc.body.connection.id });
  assert.ok(seen.length && seen.every(x => x.url.startsWith('https://c.example.com') && x.auth.includes('sk-new-key-2222')), '沒換網址就用存好的新金鑰');

  console.log('project-models-test：全部通過（搬家與複製、中斷整組回復、同時搬只搬一次、換網址不沿用舊金鑰、沒人用的不搬、搬家提示一次、負責人＋管理員能改、成員唯讀看用量不看末 4 碼與紀錄、不在專案看不到、雲端 AI 只建在負責的專案並只選本專案設定、不能改所屬專案、總覽與刪舊設定）');
} finally {
  db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
