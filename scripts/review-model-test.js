// 驗收測試：審查者要多不一樣（不限／不同模型／不同家）＋平台記下每位 AI 的模型
// A. 設定三段、預設不限；舊設定 diffTool：true → 不同家、false → 不限（存著的、送來的都轉）；改了寫審查紀錄
// B. AI 回報模型：PUT /api/me/model（人不行、格式不對 400）、aigile_me 帶 model；團隊狀態的 AI 多 aiTool、aiModel（時間、時機）
// C. 不同模型：比完整模型代號（不分大小寫）；同一個模型擋、新舊版本算不同、模型不明當作不一樣、人一律可以；自動挑也照規則
// D. 不同家：同一家擋、不同家可以、工具不明當作不一樣；不同家一定也是不同模型（同模型照樣擋）
// E. 審查紀錄記當時的工具與模型：送審記作者的、通過／要改記審查者的；之後換模型不影響；審查者中途換成同一個模型 → 回覆被擋
// F. 回覆沒帶 model 就用最近一次回報的；MCP 的 aigile_review_request、aigile_review 都收 model
// G. 作者送審時模型不明、之後才回報（跟審查者同一個模型）：這一輪照送審那一刻算（不明＝當作不一樣），不會錯擋
// H. 升級路徑：已套過原本的 007_card_reviews.sql、有舊資料 → 套 009_review_models.sql：多 model 欄與 ai_models；舊送審列的 tool（當時記的是審查者的）清成不明；欄位跟 schema.sql 一樣
// 測試資料全部由程式產生，不連正式庫。用法：node scripts/review-model-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';
import { DatabaseSync } from 'node:sqlite';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rvmodel-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const docText = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('../docs/api-reference.md', import.meta.url), 'utf8');
const app = createApp({ db, storage: dbStorage(db), docStorage: memStorage(), docText, config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const BASE = 'http://localhost';
const req = async (token, p, method = 'GET', body) => {
  const r = await app(new Request(BASE + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), BASE);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const code = r => r.body?.error?.code;
const pj = encodeURIComponent('預設專案'), SET = `/api/projects/${pj}/review-settings`;
let rpc = 0;
const tool = async (tok, name, args) => {
  const r = (await req(tok, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } })).body.result;
  return r.isError ? { isError: true, text: r.content[0].text } : JSON.parse(r.content[0].text);
};
const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', SHA2 = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const OPUS = 'claude-opus-5-5', OPUS_OLD = 'claude-opus-5', SONNET = 'claude-sonnet-5-5', GPT = 'gpt-5.1-codex';

try {
  const liu = (await req(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員
  const hua = (await req(null, '/api/join', 'POST', { name: '小華', role: 'PG' })).body;
  const id = x => x.participant?.participantId || x.participantId;
  await req(liu.token, `/api/participants/${id(hua)}/projects`, 'PUT', { projects: ['預設專案'] });
  const mkAi = async (owner, name, tl) => {
    const a = (await req(owner.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: '程式開發', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    if (tl) await db.run('INSERT INTO skill_syncs (ai_id, tool) VALUES (?, ?)', a.participantId, tl);
    return a;
  };
  const pg = await mkAi(liu, '示範PG', 'claude');     // 作者（Claude）
  const po = await mkAi(liu, '示範PO', 'claude');     // 同一家
  const cx = await mkAi(hua, '示範Codex', 'codex');   // 不同家
  const ag = await mkAi(hua, '示範AG', null);         // 工具不明
  let n = 0;
  const mk = async title => (await req(pg.token, '/api/cards', 'POST', { project: '預設專案', title, ownerId: id(pg), requestId: 'c' + (++n) })).body.cardId;
  const rq = (K, body, tok = pg.token) => req(tok, `/api/cards/${K}/review-request`, 'POST', { version: SHA1, note: '改了報價單匯出；跑了 export-test。', ...body });
  const rv = (K, tok, body) => req(tok, `/api/cards/${K}/review`, 'POST', { version: SHA1, result: 'pass', ...body });
  const getCard = async K => (await req(liu.token, `/api/cards/${K}`)).body;

  // ---------- A 設定三段、舊設定轉換 ----------
  let r = await req(liu.token, SET);
  assert.equal(r.body.settings.differ, 'any', 'A 預設不限');
  assert.ok(!('diffTool' in r.body.settings), 'A 不再回 diffTool');
  await db.run("INSERT INTO app_settings (key, value) VALUES ('review', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ 預設專案: { cards: 'code', diffTool: true, log: [] } }));
  assert.equal((await req(liu.token, SET)).body.settings.differ, 'vendor', 'A 存著的舊設定 diffTool true → 不同家');
  await db.run("UPDATE app_settings SET value = ? WHERE key = 'review'", JSON.stringify({ 預設專案: { cards: 'code', diffTool: false, log: [] } }));
  assert.equal((await req(liu.token, SET)).body.settings.differ, 'any', 'A 存著的舊設定 diffTool false → 不限');
  r = await req(liu.token, SET, 'PUT', { diffTool: true });
  assert.deepEqual([r.status, r.body.settings.differ, 'diffTool' in r.body.settings], [200, 'vendor', false], 'A 舊的呼叫方式 diffTool:true → 不同家，存的時候不留 diffTool');
  assert.match(r.body.log[0].text, /^審查者要多不一樣：不限 → 不同家$/, 'A 改了寫審查紀錄');
  assert.ok(!('diffTool' in JSON.parse((await db.get("SELECT value FROM app_settings WHERE key = 'review'")).value)['預設專案']), 'A 存檔沒有 diffTool');
  r = await req(liu.token, SET, 'PUT', { differ: 'model' });
  assert.deepEqual([r.body.settings.differ, r.body.log[0].text], ['model', '審查者要多不一樣：不同家 → 不同模型'], 'A 改成不同模型');
  assert.equal((await req(liu.token, SET, 'PUT', { differ: 'same' })).status, 400, 'A 不認得的值回 400（狀態碼）');
  assert.equal((await req(liu.token, SET, 'PUT', { diffTool: 'yes' })).status, 400, 'A 舊的 diffTool 不是布林也擋');
  assert.deepEqual(r.body.ais.map(a => `${a.name}:${a.tool ?? '-'}:${a.model ?? '-'}`), ['示範AG:-:-', '示範Codex:codex:-', '示範PG:claude:-', '示範PO:claude:-'], 'A 設定帶專案裡的 AI（工具、模型；沒回報＝null）');

  // ---------- B AI 回報模型 ----------
  r = await req(pg.token, '/api/me/model', 'PUT', { model: OPUS });
  assert.deepEqual([r.status, r.body.model, r.body.via], [200, OPUS, 'checkin'], 'B AI 回報模型（接上）');
  assert.equal((await req(liu.token, '/api/me/model', 'PUT', { model: OPUS })).status, 403, 'B 人不能回報模型');
  for (const bad of ['', ' ', 'x'.repeat(81), 'opus\n5', '<script>', 42]) assert.equal((await req(pg.token, '/api/me/model', 'PUT', { model: bad })).status, 400, 'B 模型格式不對：' + JSON.stringify(bad));
  const me = await tool(po.token, 'aigile_me', { model: SONNET });
  assert.equal(me.participantId, id(po), 'B aigile_me 帶 model 照樣回身分');
  let row = await db.get('SELECT model, via FROM ai_models WHERE ai_id = ?', id(po));
  assert.deepEqual([row.model, row.via], [SONNET, 'checkin'], 'B aigile_me 帶 model＝接上時回報');
  assert.equal((await tool(po.token, 'aigile_me', { model: 'bad model!' })).isError, true, 'B aigile_me 帶錯的 model 回錯誤');
  const tm = (await req(liu.token, '/api/team-status?project=' + pj)).body.members;
  const tPg = tm.find(m => m.participantId === id(pg)), tAg = tm.find(m => m.participantId === id(ag)), tHua = tm.find(m => m.participantId === id(hua));
  assert.deepEqual([tPg.aiTool, tPg.aiModel.model, tPg.aiModel.via, !!Date.parse(tPg.aiModel.at)], ['claude', OPUS, 'checkin', true], 'B 團隊狀態：工具・模型（幾點、什麼時候回報）');
  assert.deepEqual([tAg.aiTool, tAg.aiModel], [null, null], 'B 團隊狀態：沒回報＝null');
  assert.ok(tHua && !('aiModel' in tHua), 'B 人沒有模型欄');
  const list = (await req(pg.token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rpc, method: 'tools/list' })).body.result.tools;
  for (const t of ['aigile_me', 'aigile_review_request', 'aigile_review']) assert.ok(list.find(x => x.name === t).inputSchema.properties.model, 'B MCP 工具收 model：' + t);

  // ---------- C 不同模型 ----------
  const K1 = await mk('報價單匯出加上幣別欄');
  r = await rq(K1, { reviewerId: id(po), model: OPUS });
  assert.equal(r.status, 200, 'C 作者 Opus、Sonnet 審：可以（同一家、不同模型）' + JSON.stringify(r.body));
  await req(po.token, '/api/me/model', 'PUT', { model: 'Claude-Opus-5-5' });
  r = await rq(K1, { reviewerId: id(po), model: OPUS });
  assert.deepEqual([r.status, r.body.error?.message], [400, '示範PO 不能審這張卡：同一個模型。'], 'C 同一個模型擋（不分大小寫）');
  await req(po.token, '/api/me/model', 'PUT', { model: OPUS_OLD });
  assert.equal((await rq(K1, { reviewerId: id(po), model: OPUS })).status, 200, 'C 同一個模型的新舊版本算不同');
  assert.equal((await rq(K1, { reviewerId: id(ag), model: OPUS })).status, 200, 'C 模型不明的 AI 當作不一樣');
  assert.equal((await rq(K1, { reviewerId: id(hua), model: OPUS })).status, 200, 'C 人一律可以');
  // 自動挑：同一個模型的不挑
  await req(po.token, '/api/me/model', 'PUT', { model: OPUS });
  await req(cx.token, '/api/me/model', 'PUT', { model: OPUS });
  await req(ag.token, '/api/me/model', 'PUT', { model: OPUS });
  const K2 = await mk('第二張');
  r = await rq(K2, { model: OPUS });
  assert.deepEqual(r.body.reviewers.map(p => p.kind), ['human'], 'C 自動挑：AI 都是同一個模型，只剩人');
  r = await rq(await mk('第二張之二'), { model: SONNET }); // 重新送審預設同一位，所以用新卡
  assert.equal(r.body.reviewers[0].kind, 'ai', 'C 作者換了模型再送審：AI 又能審了');
  assert.equal((await db.get('SELECT via FROM ai_models WHERE ai_id = ?', id(pg))).via, 'request', 'C 送審帶 model＝送審時回報');

  // ---------- D 不同家 ----------
  await req(liu.token, SET, 'PUT', { differ: 'vendor' });
  await req(po.token, '/api/me/model', 'PUT', { model: SONNET });
  await req(cx.token, '/api/me/model', 'PUT', { model: GPT });
  await db.run('DELETE FROM ai_models WHERE ai_id = ?', id(ag));
  const K3 = await mk('第三張');
  r = await rq(K3, { reviewerId: id(po), model: OPUS });
  assert.equal(r.body.error?.message, '示範PO 不能審這張卡：同一家。', 'D 同一家擋（就算模型不同）');
  assert.equal((await rq(K3, { reviewerId: id(cx), model: OPUS })).status, 200, 'D 不同家可以');
  assert.equal((await rq(K3, { reviewerId: id(ag), model: OPUS })).status, 200, 'D 工具、模型都不明的 AI 當作不一樣');
  await req(ag.token, '/api/me/model', 'PUT', { model: OPUS });
  r = await rq(K3, { reviewerId: id(ag), model: OPUS });
  assert.equal(r.body.error?.message, '示範AG 不能審這張卡：同一個模型。', 'D 不同家一定也是不同模型：工具不明但同一個模型照樣擋');

  // ---------- E 審查紀錄記當時的工具與模型 ----------
  await req(liu.token, SET, 'PUT', { differ: 'model' });
  const K4 = await mk('第四張');
  r = await rq(K4, { reviewerId: id(cx), model: OPUS });
  const round = r.body.messageId;
  await req(pg.token, '/api/me/model', 'PUT', { model: SONNET }); // 作者之後換模型：不影響已送的這一輪
  r = await rv(K4, cx.token, { roundId: round, model: GPT });
  assert.deepEqual([r.status, r.body.state], [200, 'passed'], 'E 通過');
  let c = (await getCard(K4)).review;
  assert.deepEqual([c.rule.differ, c.requestedBy.tool, c.requestedBy.model], ['model', 'claude', OPUS], 'E 送審記作者當時的工具與模型（之後換模型不影響）');
  assert.deepEqual([c.passed.by.tool, c.passed.by.model, c.reviewers[0].model, c.reviewers[0].result], ['codex', GPT, GPT, 'pass'], 'E 通過記審查者當時的工具與模型');
  assert.deepEqual(c.history.map(h => `${h.ev}:${h.by.tool}:${h.by.model}`), [`pass:codex:${GPT}`, `request:claude:${OPUS}`], 'E 歷次紀錄每列帶工具、模型');
  await req(cx.token, '/api/me/model', 'PUT', { model: 'o4' });
  assert.equal((await getCard(K4)).review.passed.by.model, GPT, 'E 審查者之後換模型也不影響紀錄');
  assert.ok(!('diffTool' in c.rule), 'E 卡片規則不再帶 diffTool');
  // 審查者中途換成跟作者同一個模型：回覆時重新檢查，擋下
  const K5 = await mk('第五張');
  await rq(K5, { reviewerId: id(cx), model: OPUS });
  r = await rv(K5, cx.token, { model: OPUS });
  assert.deepEqual([r.status, code(r), r.body.error?.message], [403, 'REVIEWER_NOT_ALLOWED', '示範Codex 現在不能審這張卡：同一個模型。'], 'E 審查者換成同一個模型 → 回覆被擋');
  assert.equal((await db.get('SELECT model, via FROM ai_models WHERE ai_id = ?', id(cx))).via, 'review', 'E 回覆帶 model＝審查時回報（擋下也照實記）');

  // ---------- F 回覆沒帶 model；MCP ----------
  await req(cx.token, '/api/me/model', 'PUT', { model: GPT });
  r = await rv(K5, cx.token, {});
  assert.equal(r.status, 200, 'F 回覆沒帶 model：用最近一次回報的（不同模型就放行）');
  assert.equal((await getCard(K5)).review.passed.by.model, GPT, 'F 紀錄用最近一次回報的模型');
  const K6 = await mk('第六張');
  const m1 = await tool(pg.token, 'aigile_review_request', { cardId: K6, version: SHA2, note: 'MCP 送審', reviewerId: id(cx), model: 'claude-fable-5-2' });
  assert.equal(m1.reviewers[0], '示範Codex（AI）', 'F MCP 送審帶 model');
  const m2 = await tool(cx.token, 'aigile_review', { cardId: K6, version: SHA2, result: 'pass', roundId: m1.messageId, model: 'gpt-5.2-codex' });
  assert.equal(m2.state, 'passed', 'F MCP 回覆帶 model');
  c = (await getCard(K6)).review;
  assert.deepEqual([c.requestedBy.model, c.passed.by.model], ['claude-fable-5-2', 'gpt-5.2-codex'], 'F MCP 的模型記在審查紀錄');
  assert.equal((await tool(pg.token, 'aigile_review_request', { cardId: K6, version: SHA1, note: 'x', model: 'a b c !' })).isError, true, 'F MCP 模型格式不對回錯誤');

  // ---------- G 作者送審後才首次回報模型 ----------
  const K7 = await mk('第七張');
  await db.run('DELETE FROM ai_models WHERE ai_id = ?', id(pg));
  r = await rq(K7, { reviewerId: id(cx) }); // 作者沒帶 model、也沒回報過
  assert.equal(r.status, 200, 'G 作者模型不明也能送審');
  assert.equal((await getCard(K7)).review.requestedBy.model, null, 'G 送審紀錄：作者模型不明');
  await req(pg.token, '/api/me/model', 'PUT', { model: GPT }); // 送審後才回報，剛好跟審查者同一個模型
  r = await rv(K7, cx.token, { model: GPT });
  assert.deepEqual([r.status, r.body.state], [200, 'passed'], 'G 這一輪照送審那一刻算（作者不明＝當作不一樣），不會錯擋：' + JSON.stringify(r.body));

  // ---------- H 升級路徑：有舊資料的資料庫 ----------
  const mig = name => fs.readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8');
  const old = new DatabaseSync(':memory:');
  old.exec(mig('007_card_reviews.sql'));
  const ins = old.prepare('INSERT INTO card_reviews (id, card_seq, project, ev, version, actor_id, reviewer_id, reviewer_kind, tool, comment, message_id, at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  ins.run('rv1', 1, 'x', 'request', SHA1, 'p_author', 'p_rev', 'ai', 'codex', '舊的送審', 'msg_1', '2026-11-20T00:00:00.000Z'); // 舊版：送審列的 tool 是審查者的
  ins.run('rv2', 1, 'x', 'pass', SHA1, 'p_rev', 'p_rev', 'ai', 'codex', '', 'msg_1', '2026-11-20T01:00:00.000Z');
  old.exec(mig('009_review_models.sql'));
  const rows = old.prepare('SELECT id, tool, model FROM card_reviews ORDER BY id').all().map(x => `${x.id}:${x.tool}:${x.model}`);
  assert.deepEqual(rows, ['rv1:null:null', 'rv2:codex:null'], 'H 舊資料升級：多 model 欄；送審列的 tool 清成不明、通過列照舊');
  old.prepare('INSERT INTO ai_models (ai_id, model, via, at) VALUES (?,?,?,?)').run('p_rev', GPT, 'review', '2026-11-23T00:00:00.000Z');
  old.prepare('INSERT INTO card_reviews (id, card_seq, project, ev, version, actor_id, tool, model, at) VALUES (?,?,?,?,?,?,?,?,?)').run('rv3', 1, 'x', 'pass', SHA1, 'p_rev', 'codex', GPT, '2026-11-23T00:00:00.000Z');
  const fresh = new DatabaseSync(':memory:');
  fresh.exec(fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  const colsOf = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).join(',');
  for (const t of ['card_reviews', 'ai_models']) assert.equal(colsOf(old, t), colsOf(fresh, t), 'H 升級後的欄位跟 schema.sql 一樣：' + t);
  old.close(); fresh.close();

  console.log('review-model-test：全部通過（三段設定與舊設定轉換、AI 回報模型、團隊狀態工具・模型、不同模型／不同家／不明當作不一樣、審查紀錄記當時的工具與模型、中途換模型重新檢查、MCP、作者送審後才回報模型不會錯擋、有舊資料的升級路徑）');
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
