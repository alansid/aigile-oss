// 驗收測試：審查者——程式交出去前，先給「不是作者」的人或 AI 看過（規則由專案自訂）
// A. 預設不審：卡片沒有審查欄、請人同意 commit 不擋；只有 leader／管理員能改設定，改了寫進審查紀錄
// B. 開了審查：沒通過就請人同意 commit → 409 REVIEW_REQUIRED；審查者不能是作者（寫死）、要不同家的 AI、不能是作者的主人
// C. 送審 → 自動挑 AI（手上比較空的）→ 要改（一定要意見）→ 重新送審預設同一位 → 通過 → 請同意 commit 放行
// D. 版本改了：commit 寫的 SHA 跟通過的不同＝通過作廢，下一次請同意 commit 擋下
// E. 要 2 位、至少一位是人：人的「要你處理」有這筆；人審查通過就算同意 commit（專案設定、審查者是作者 AI 的主人）
// F. diff：開源版預設可以上傳（leader 可以關）；只有送審入口能附（存專案文件），開關寫進紀錄；有 GitHub 程式庫給比較連結
// H. 請同意 commit 附 64 碼 diff 指紋：相同放行、不同作廢；日期、編號不當成版本
// I. 一輪＝一則送審訊息（前一輪晚到的回覆不算；回覆帶 roundId，舊畫面的回覆被拒）；合併核准要整輪通過；計票按不同審查者、資料庫擋同一輪重複回覆；回覆時重新驗證資格；只審程式卡時標成非程式卡的不擋
// G. MCP：aigile_review_request、aigile_review、aigile_card_get 帶 review
// 測試資料全部由程式產生，不連正式庫。用法：node scripts/review-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-review-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const docText = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('../docs/api-reference.md', import.meta.url), 'utf8');
const app = createApp({ db, storage: dbStorage(db), docStorage: memStorage(), docText, config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const BASE = 'http://localhost';
const req = async (token, p, method = 'GET', body, raw) => {
  const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { 'Content-Type': 'application/json' }) };
  const r = await app(new Request(BASE + p, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) }), BASE);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const code = r => r.body?.error?.code;
const pj = encodeURIComponent('預設專案'), SET = `/api/projects/${pj}/review-settings`;
let rpc = 0;
const tool = async (tok, name, args) => {
  const r = (await req(tok, '/api/mcp', 'POST', { jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } })).body.result;
  return r.isError ? { isError: true, text: r.content[0].text } : JSON.parse(r.content[0].text);
};
const SHA1 = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', SHA2 = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', SHA3 = '4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f';
let seqN = 0;
const post = (tok, text, extra = {}) => req(tok, '/api/messages', 'POST', { project: '預設專案', text, requestId: 'r' + (++seqN), ...extra });

try {
  const liu = (await req(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body; // 管理員
  const lead = (await req(null, '/api/join', 'POST', { name: '林小安', role: 'SM' })).body;
  const hua = (await req(null, '/api/join', 'POST', { name: '小華', role: 'PG' })).body;
  const id = x => x.participant?.participantId || x.participantId;
  for (const p of [lead, hua]) await req(liu.token, `/api/participants/${id(p)}/projects`, 'PUT', { projects: ['預設專案'] });
  await req(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(lead), leaderOf: ['預設專案'] }] });
  const mkAi = async (owner, name, roleKey, tl) => {
    const a = (await req(owner.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey, role: roleKey === 'PG' ? '程式開發' : '產品負責', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    if (tl) await db.run('INSERT INTO skill_syncs (ai_id, tool) VALUES (?, ?)', a.participantId, tl);
    return a;
  };
  const pg = await mkAi(liu, '示範PG', 'PG', 'claude');      // 作者（Claude）
  const pg2 = await mkAi(liu, '示範PG2', 'PG', 'claude');    // 同一家、同一位主人
  const cx = await mkAi(hua, '示範Codex', 'PG', 'codex');    // 不同家、不同主人
  const ag = await mkAi(hua, '示範AG', 'PG', null);          // 工具不明
  const card = (await req(pg.token, '/api/cards', 'POST', { project: '預設專案', title: '報價單匯出加上幣別欄', ownerId: id(pg), requestId: 'c1' })).body;
  const K = card.cardId;
  const getCard = async (tok = liu.token) => (await req(tok, `/api/cards/${K}`)).body;
  const ask = (text = `[需確認] ${K} 請同意 commit：報價單匯出加上幣別欄（${SHA2}）`) => post(pg.token, text, { cardId: K });

  // ---------- A 預設不審 ----------
  let r = await req(liu.token, SET);
  assert.deepEqual([r.status, r.body.settings.cards, r.body.settings.diffUpload, r.body.canEdit], [200, 'off', true, true], 'A 預設不審；開源版預設可以上傳 diff');
  assert.equal((await getCard()).review, undefined, 'A 不審時卡片沒有審查欄');
  r = await ask();
  assert.equal(r.status, 201, 'A 不審時請同意 commit 不擋：' + JSON.stringify(r.body));
  r = await req(hua.token, SET, 'PUT', { cards: 'code' });
  assert.deepEqual([r.status, code(r)], [403, 'FORBIDDEN'], 'A 一般成員不能改設定');
  assert.equal((await req(hua.token, SET)).body.canEdit, false, 'A 一般成員看得到、不能改');
  r = await req(pg.token, SET, 'PUT', { cards: 'code' });
  assert.equal(r.status, 403, 'A AI 不能改設定');
  r = await req(lead.token, SET, 'PUT', { cards: 'code', need: 1, needHuman: true });
  assert.deepEqual([r.status, r.body.settings.cards, r.body.settings.needHuman], [200, 'code', false], 'A leader 能改；要 1 位時「至少一位是人」自動關');
  assert.match(r.body.log[0].text, /哪些卡要審：不審 → 只有程式卡/, 'A 改設定寫進審查紀錄');
  assert.equal(r.body.log[0].byName, '林小安', 'A 紀錄寫誰改的');
  assert.equal((await req(lead.token, SET, 'PUT', { cards: 'x' })).status, 400, 'A 不認得的值回 400');
  const elig = r.body.eligible.map(p => `${p.name}:${p.kind}:${p.tool ?? '-'}`);
  assert.ok(elig.includes('示範AG:ai:-') && elig.includes('示範Codex:ai:codex') && elig.includes('小華:human:-'), 'A 現在符合的審查者列出名字、人／AI、工具（不明＝null）：' + elig);
  assert.ok(elig.indexOf('示範Codex:ai:codex') < elig.indexOf('小華:human:-'), 'A AI 排在人前面');

  // ---------- B 開了審查：沒通過就擋；審查者規則 ----------
  r = await ask();
  assert.deepEqual([r.status, code(r)], [409, 'REVIEW_REQUIRED'], 'B 沒通過就請同意 commit → 擋');
  assert.equal(r.body.error.message, '這張卡還沒通過審查，不能請人同意 commit。請先送審（aigile_review_request），通過後再發。', 'B 擋下的文字照 UX');
  r = await post(pg.token, `[需確認] ${K} 要不要 commit 這版？`); // 沒帶 cardId、內文寫卡號也擋
  assert.equal(code(r), 'REVIEW_REQUIRED', 'B 內文寫卡號也擋');
  assert.equal((await post(pg.token, `[進度] ${K} 寫完了，準備 commit`, { cardId: K })).status, 201, 'B 不是 [需確認] 不擋');
  assert.equal((await post(liu.token, `[需確認] ${K} commit？`, { cardId: K })).status, 201, 'B 人發的不擋（擋的是 AI 請人同意）');
  const rq = (tok, body) => req(tok, `/api/cards/${K}/review-request`, 'POST', { version: SHA1, note: '報價單匯出多一欄幣別；跑了 export-test，全過。', ...body });
  r = await rq(pg.token, { reviewerId: id(pg) });
  assert.deepEqual([r.status, code(r)], [400, 'REVIEWER_NOT_ALLOWED'], 'B 指定自己 → 擋');
  assert.equal(r.body.error.message, '示範PG 不能審這張卡：是作者。', 'B 理由：是作者');
  await req(lead.token, SET, 'PUT', { diffTool: true, notOwner: true });
  r = await rq(pg.token, { reviewerId: id(pg2) });
  assert.match(r.body.error.message, /^示範PG2 不能審這張卡：是作者的主人或同一位主人的 AI。$/, 'B 不能是作者的主人');
  await req(lead.token, SET, 'PUT', { notOwner: false });
  r = await rq(pg.token, { reviewerId: id(pg2) });
  assert.equal(r.body.error.message, '示範PG2 不能審這張卡：同一家。', 'B 要不同家：同是 Claude 不行');
  assert.equal((await rq(pg.token, { version: 'xx' })).status, 400, 'B 版本格式不對');
  assert.equal((await rq(pg.token, { note: '' })).status, 400, 'B 說明必填');

  // ---------- C 送審 → 要改 → 重新送審 → 通過 ----------
  r = await rq(pg.token, {});
  assert.equal(r.status, 200, 'C 送審：' + JSON.stringify(r.body));
  assert.deepEqual(r.body.reviewers.map(p => p.name), ['示範AG'], 'C 自動挑：AI 先挑、手上最空（工具不明當作跟誰都不同家）');
  const reqMsg = (await req(liu.token, `/api/messages/${r.body.messageId}`)).body;
  assert.match(reqMsg.text, new RegExp(`^\\[交接\\] @示範AG ${K} 請你審查：報價單匯出加上幣別欄\\n版本：${SHA1}`), 'C 送審發群組訊息');
  assert.deepEqual(reqMsg.replyFrom, [id(ag)], 'C AI 審查者用 replyFrom 叫醒');
  let c = await getCard();
  assert.deepEqual([c.review.state, c.review.version, c.review.reviewers[0].name, c.review.isCode], ['waiting', SHA1, '示範AG', true], 'C 卡片：等審查');
  // 改成指定 Codex 審（重新送審可指定）
  r = await rq(pg.token, { reviewerId: id(cx) });
  assert.deepEqual(r.body.reviewers.map(p => p.name), ['示範Codex'], 'C 指定不同家的 Codex');
  const rv = (tok, body) => req(tok, `/api/cards/${K}/review`, 'POST', { version: SHA1, ...body });
  assert.equal(code(await rv(ag.token, { result: 'pass' })), 'NOT_REVIEWER', 'C 不是這一輪的審查者不能回');
  assert.equal(code(await rv(pg.token, { result: 'pass' })), 'NOT_REVIEWER', 'C 作者不能審自己');
  assert.equal(code(await rv(cx.token, { result: 'pass', version: SHA2 })), 'VERSION_MISMATCH', 'C 版本要對上');
  assert.equal((await rv(cx.token, { result: 'changes' })).status, 400, 'C 要改一定要寫意見');
  r = await rv(cx.token, { result: 'changes', comment: '拿掉了「不會連正式庫」的檢查，請加回來；幣別欄沒有測空值。' });
  assert.deepEqual([r.status, r.body.state], [200, 'changes'], 'C 要改');
  const note = (await req(liu.token, `/api/messages/${r.body.messageId}`)).body;
  assert.equal(note.text, `[通知] ${K} 審查：要改（示範Codex）`, 'C 群組只發一句短通知');
  c = await getCard();
  assert.deepEqual([c.review.state, c.review.changes.comment], ['changes', '拿掉了「不會連正式庫」的檢查，請加回來；幣別欄沒有測空值。'], 'C 卡片：要改＋意見');
  assert.ok(c.log.some(l => l.via === '審查' && /示範Codex 審 a1b2c3d：要改。意見：拿掉了/.test(l.text)), 'C 意見寫進卡片紀錄');
  assert.equal(code(await ask()), 'REVIEW_REQUIRED', 'C 要改時請同意 commit 仍擋');
  r = await rq(pg.token, { version: SHA2, note: '檢查加回來了，空值有測。' });
  assert.deepEqual(r.body.reviewers.map(p => p.name), ['示範Codex'], 'C 重新送審預設同一位');
  r = await req(cx.token, `/api/cards/${K}/review`, 'POST', { version: SHA2.slice(0, 7), result: 'pass', comment: '檢查加回來了，空值有測。可以。' });
  assert.deepEqual([r.status, r.body.state], [200, 'passed'], 'C 通過（7 碼開頭也算同一版）');
  c = await getCard();
  assert.deepEqual([c.review.state, c.review.passed.by.name, c.review.passed.version], ['passed', '示範Codex', SHA2], 'C 卡片：已審查');
  assert.deepEqual(c.review.history.map(h => h.ev), ['pass', 'request', 'changes', 'request', 'request'], 'C 歷次紀錄（新的在前）');
  assert.equal((await rv(cx.token, { result: 'pass', version: SHA2 })).status, 409, 'C 同一輪不能再回');
  r = await ask();
  assert.equal(r.status, 201, 'C 通過後請同意 commit 放行');

  // ---------- D 版本改了：通過作廢 ----------
  r = await ask(`[需確認] ${K} 請同意 commit（${SHA3}）`);
  assert.equal(r.status, 201, 'D 版本對不上：訊息照發（畫面標紅給人看）');
  c = await getCard();
  assert.deepEqual([c.review.state, c.review.voided.version], ['void', SHA3], 'D 通過作廢');
  assert.equal(code(await ask()), 'REVIEW_REQUIRED', 'D 作廢後請同意 commit 擋下');

  // ---------- E 要 2 位、至少一位是人；人審查通過就算同意 commit ----------
  await req(lead.token, SET, 'PUT', { need: 2, needHuman: true, diffTool: false, humanPass: 'combined' });
  r = await rq(pg.token, { version: SHA3, note: '版本 3', reviewerId: id(liu) }); // 指定作者 AI 的主人，另一位平台自動挑
  assert.equal(r.body.reviewers.length, 2, 'E 要 2 位');
  assert.ok(r.body.reviewers.some(p => p.kind === 'human'), 'E 至少一位是人：' + JSON.stringify(r.body.reviewers));
  const humanRev = r.body.reviewers.find(p => p.kind === 'human');
  const humanTok = { [id(liu)]: liu.token, [id(lead)]: lead.token, [id(hua)]: hua.token }[humanRev.participantId];
  const mine = (await req(humanTok, '/api/reviews/mine')).body.items;
  assert.deepEqual(mine.map(x => [x.cardId, x.version, x.author.name]), [[K, SHA3, '示範PG']], 'E 人的「要你處理」有這筆審查');
  const aiRev = r.body.reviewers.find(p => p.kind === 'ai');
  const aiTok = { [id(cx)]: cx.token, [id(ag)]: ag.token, [id(pg2)]: pg2.token }[aiRev.participantId];
  r = await req(aiTok, `/api/cards/${K}/review`, 'POST', { version: SHA3, result: 'pass' });
  assert.equal(r.body.state, 'waiting', 'E 只有 1 位通過：還在等');
  assert.equal((await req(liu.token, `/api/messages/${r.body.messageId}`)).body.text, `[通知] ${K} 審查：通過（${aiRev.name}），還要再 1 位通過`, 'E 通知寫還要 1 位');
  r = await req(humanTok, `/api/cards/${K}/review`, 'POST', { version: SHA3, result: 'pass', comment: '看過了', approveCommit: true });
  assert.equal(r.body.state, 'passed', 'E 兩位都通過');
  const approve = (await req(liu.token, `/api/messages/${r.body.messageId}`)).body;
  assert.equal(humanRev.participantId, id(liu), 'E 指定的人');
  assert.equal(r.body.approvedCommit, true, 'E 審查者是作者 AI 的主人：通過就算同意 commit');
  assert.match(approve.text, /^\[回覆\] 同意 commit（針對第 \d+ 則），請附完整 40 碼 SHA。審查通過：看過了$/, 'E 同意 commit 的回覆');
  assert.equal(approve.replyToMessageId, mine[0].messageId, 'E 回覆的是送審那則（作者 AI 自己的訊息）');
  assert.equal((await req(humanTok, '/api/reviews/mine')).body.items.length, 0, 'E 審完就不在「要你處理」');

  // ---------- F diff 上傳與比較連結 ----------
  const diffUp = (tok, q = 'declared=review-diff&version=' + SHA3) => req(tok, `/api/cards/${K}/review-diff?${q}`, 'POST', null, new TextEncoder().encode('diff --git a/x b/x\n+幣別\n'));
  assert.equal((await req(hua.token, SET, 'PUT', { diffUpload: false })).status, 403, 'F 一般成員不能關');
  r = await req(liu.token, SET, 'PUT', { diffUpload: false });
  assert.equal(r.body.log[0].text, '把「送審可以上傳 diff」改成不可以', 'F 關掉寫進審查紀錄');
  assert.equal(code(await diffUp(pg.token)), 'DIFF_UPLOAD_OFF', 'F 關掉後不能上傳 diff');
  assert.equal(code(await rq(pg.token, { diffDocId: 'doc_x' })), 'DIFF_UPLOAD_OFF', 'F 關掉後送審不能附 diff');
  r = await req(liu.token, SET, 'PUT', { diffUpload: true });
  assert.equal(r.body.log[0].text, '把「送審可以上傳 diff」改成可以', 'F 開關寫進審查紀錄');
  assert.equal(r.body.declaration, '這是本專案自己的程式差異，不含密鑰與客戶個資', 'F 聲明文字');
  assert.equal((await diffUp(pg.token, 'declared=true')).status, 400, 'F 要用送審 diff 的聲明');
  r = await diffUp(pg.token);
  assert.equal(r.status, 201, 'F 上傳 diff：' + JSON.stringify(r.body));
  const diffDoc = r.body.docId;
  assert.equal(r.body.name, `${K}-${SHA3.slice(0, 12)}.diff.txt`, 'F 檔名');
  const docRow = (await req(liu.token, `/api/projects/${pj}/docs`)).body.items.find(d => d.docId === diffDoc);
  assert.ok(docRow && !docRow.kb.inKb, 'F 存在專案文件（不放進知識庫）');
  assert.equal((await req(liu.token, `/api/projects/${pj}/docs?name=x.diff&declared=true`, 'POST', null, new TextEncoder().encode('diff'))).status >= 400, true, 'F 其他上傳照舊不收 diff');
  await db.run("INSERT INTO app_settings (key, value) VALUES ('repo:預設專案', ?)", JSON.stringify({ url: 'https://github.com/demo/app', branch: 'main' }));
  r = await rq(pg.token, { version: SHA3, note: '附 diff', diffDocId: diffDoc, branch: 'feat/currency' });
  assert.equal(r.status, 200, 'F 送審附 diff');
  c = await getCard();
  assert.deepEqual([c.review.diffDocId, c.review.compareUrl], [diffDoc, 'https://github.com/demo/app/compare/main...feat%2Fcurrency'], 'F 卡片有 diff 與比較連結');
  assert.deepEqual([c.review.branch, c.review.note], ['feat/currency', '附 diff'], 'F 分支跟說明分開回');
  assert.deepEqual((await req(liu.token, SET)).body.github, { url: 'https://github.com/demo/app', branch: 'main' }, 'F 設定回程式庫（送審視窗的「在 GitHub 比較」）');
  r = await req(liu.token, SET, 'PUT', { diffUpload: false });
  assert.equal(r.body.log[0].text, '把「送審可以上傳 diff」改成不可以', 'F 關掉也寫紀錄');

  // ---------- G MCP ----------
  await req(lead.token, SET, 'PUT', { need: 1, humanPass: 'separate' });
  const card2 = (await req(pg.token, '/api/cards', 'POST', { project: '預設專案', title: '第二張', ownerId: id(pg), requestId: 'c2' })).body;
  let t = await tool(pg.token, 'aigile_review_request', { cardId: card2.cardId, version: SHA1, note: '第二張', reviewerId: id(cx) });
  assert.deepEqual(t.reviewers, ['示範Codex（AI）'], 'G MCP 送審：' + JSON.stringify(t));
  t = await tool(pg.token, 'aigile_review_request', { cardId: card2.cardId, version: SHA1, note: 'x', diff: 'diff' });
  assert.ok(t.isError && /不認得的欄位：diff/.test(t.text), 'G MCP 送審只收版本與說明，不收 diff：' + t.text);
  t = await tool(pg.token, 'aigile_review_diff', { cardId: card2.cardId, version: SHA1, diff: 'diff', declared: false });
  assert.ok(t.isError && /declared: true/.test(t.text), 'G MCP 附 diff 沒聲明：不代填、回錯誤');
  t = await tool(pg.token, 'aigile_review_diff', { cardId: card2.cardId, version: SHA1, diff: 'diff', declared: true });
  assert.ok(t.isError && /送審可以上傳 diff/.test(t.text), 'G MCP 沒開上傳 diff 回錯誤');
  t = await tool(cx.token, 'aigile_review', { cardId: card2.cardId, version: SHA1, result: 'pass', comment: '可以' });
  assert.equal(t.state, 'passed', 'G MCP 回覆審查');
  t = await tool(pg.token, 'aigile_card_get', { cardId: card2.cardId });
  assert.equal(t.review.state, 'passed', 'G aigile_card_get 帶 review');

  // ---------- H 請同意 commit 附 diff 指紋（還沒 commit 時的版本）；日期、編號不算版本 ----------
  const FP1 = 'bb34828d3e403d06dc172901fb32c37beee76f2d5d78cfce30abaae9287bdf9f', FP2 = '0b9b35d92cb58cdd70a7602bae4a282921534002006298f0dd745ee6732f3eff';
  const askOn = (key, text) => post(pg.token, text, { cardId: key });
  r = await askOn(card2.cardId, `[需確認] ${card2.cardId} 請同意 commit（20261123 測過，第 1234567 則）`);
  assert.equal(r.status, 201, 'H 只有日期、編號：不當成版本');
  assert.equal((await tool(pg.token, 'aigile_card_get', { cardId: card2.cardId })).review.state, 'passed', 'H 日期不會讓通過作廢');
  const card3 = (await req(pg.token, '/api/cards', 'POST', { project: '預設專案', title: '第三張', ownerId: id(pg), requestId: 'c3' })).body;
  await tool(pg.token, 'aigile_review_request', { cardId: card3.cardId, version: FP1, note: '第三張', reviewerId: id(cx) });
  await tool(cx.token, 'aigile_review', { cardId: card3.cardId, version: FP1, result: 'pass' });
  r = await askOn(card3.cardId, `[需確認] ${card3.cardId} 請同意 commit（指紋 ${FP1}）`);
  assert.equal(r.status, 201, 'H 指紋相同：放行');
  assert.equal((await tool(pg.token, 'aigile_card_get', { cardId: card3.cardId })).review.state, 'passed', 'H 指紋相同：通過不作廢');
  r = await askOn(card3.cardId, `[需確認] ${card3.cardId} 請同意 commit（指紋 ${FP2}）`);
  assert.equal(r.status, 201, 'H 指紋不同：訊息照發');
  t = await tool(pg.token, 'aigile_card_get', { cardId: card3.cardId });
  assert.deepEqual([t.review.state, t.review.voided?.version], ['void', FP2], 'H 64 碼指紋不同＝通過作廢');
  const list = (await req(pg.token, '/api/mcp', 'POST', { jsonrpc: '2.0', id: 99, method: 'tools/list' })).body.result.tools.map(x => x.name);
  assert.ok(list.includes('aigile_review_request') && list.includes('aigile_review'), 'G 工具清單有兩個新工具');

  // ---------- I 補測（審查意見）：整輪通過才合併核准、計票、回覆時重新驗證、非程式卡 ----------
  const mk = async (title, rid) => (await req(pg.token, '/api/cards', 'POST', { project: '預設專案', title, ownerId: id(pg), requestId: rid })).body.cardId;
  await req(lead.token, SET, 'PUT', { cards: 'code', who: 'any', need: 2, needHuman: true, diffTool: false, notOwner: false, humanPass: 'combined' });
  const K4 = await mk('第四張', 'c4');
  r = await req(pg.token, `/api/cards/${K4}/review-request`, 'POST', { version: SHA1, note: 'x', reviewerId: id(liu) });
  assert.equal(r.body.reviewers.length, 2, 'I1 要 2 位');
  r = await req(liu.token, `/api/cards/${K4}/review`, 'POST', { version: SHA1, result: 'pass', approveCommit: true });
  assert.deepEqual([r.body.state, r.body.approvedCommit], ['waiting', undefined], 'I1 人先通過、還差 1 位：不算同意 commit');
  assert.doesNotMatch((await req(liu.token, `/api/messages/${r.body.messageId}`)).body.text, /同意 commit/, 'I1 沒發同意 commit 的回覆');
  const vote = await db.get("SELECT card_seq, message_id FROM card_reviews WHERE ev = 'pass' AND actor_id = ? ORDER BY at DESC LIMIT 1", id(liu));
  await assert.rejects(db.run('INSERT INTO card_reviews (id, card_seq, project, ev, version, actor_id, reviewer_id, message_id, at) VALUES (?,?,?,?,?,?,?,?,?)', 'rv_dup1', vote.card_seq, '預設專案', 'pass', SHA1, id(liu), id(liu), vote.message_id, new Date().toISOString()), /UNIQUE|duplicate/i, 'I2 資料庫擋同一輪同一人回第二次');
  await db.run('INSERT INTO card_reviews (id, card_seq, project, ev, version, actor_id, reviewer_id, message_id, at) VALUES (?,?,?,?,?,?,?,?,?)', 'rv_dup2', vote.card_seq, '預設專案', 'pass', SHA1, id(liu), id(liu), null, new Date().toISOString());
  assert.equal((await req(liu.token, `/api/cards/${K4}`)).body.review.state, 'waiting', 'I2 同一人兩筆通過只算一票');
  assert.equal(code(await req(liu.token, `/api/cards/${K4}/review`, 'POST', { version: SHA1, result: 'pass' })), 'ALREADY_REVIEWED', 'I2 再回一次擋下');
  await req(lead.token, SET, 'PUT', { need: 1, needHuman: false, humanPass: 'separate' });
  const K5 = await mk('第五張', 'c5');
  await req(pg.token, `/api/cards/${K5}/review-request`, 'POST', { version: SHA1, note: 'x', reviewerId: id(cx) });
  await req(lead.token, SET, 'PUT', { who: 'human' });
  r = await req(cx.token, `/api/cards/${K5}/review`, 'POST', { version: SHA1, result: 'pass' });
  assert.deepEqual([r.status, code(r)], [403, 'REVIEWER_NOT_ALLOWED'], 'I3 送審後規則改成只有人：AI 回覆時重新驗證、擋下');
  await req(lead.token, SET, 'PUT', { who: 'any' });
  const K6 = await mk('第六張', 'c6');
  await req(pg.token, `/api/cards/${K6}/review-request`, 'POST', { version: SHA1, note: '只改文件', reviewerId: id(cx), isCode: false });
  assert.equal((await req(liu.token, `/api/cards/${K6}`)).body.review.required, false, 'I4 只審程式卡：標成非程式卡就不要求審查');
  assert.equal((await post(pg.token, `[需確認] ${K6} 請同意 commit`, { cardId: K6 })).status, 201, 'I4 非程式卡請同意 commit 不擋');
  await req(lead.token, SET, 'PUT', { cards: 'all' });
  assert.equal(code(await post(pg.token, `[需確認] ${K6} 請同意 commit（再一次）`, { cardId: K6 })), 'REVIEW_REQUIRED', 'I4 全部的卡都要審時照擋');
  await req(lead.token, SET, 'PUT', { cards: 'code' });

  // I5 同版本重新送審、前一輪的回覆晚到：一輪＝一則送審訊息，舊一輪的票不影響新一輪
  const K7 = await mk('第七張', 'c7');
  const round1 = (await req(pg.token, `/api/cards/${K7}/review-request`, 'POST', { version: SHA1, note: 'x', reviewerId: id(cx) })).body.messageId;
  await req(pg.token, `/api/cards/${K7}/review-request`, 'POST', { version: SHA1, note: '同版本再送一次', reviewerId: id(ag) });
  const seq7 = (await db.get('SELECT card_seq FROM card_reviews WHERE message_id = ?', round1)).card_seq;
  const late = (rid, ev, ms, who) => db.run('INSERT INTO card_reviews (id, card_seq, project, ev, version, actor_id, reviewer_id, comment, message_id, at) VALUES (?,?,?,?,?,?,?,?,?,?)', rid, seq7, '預設專案', ev, SHA1, who, who, ev === 'changes' ? '晚到' : '', round1, new Date(Date.now() + ms).toISOString());
  await late('rv_late1', 'pass', 1000, id(cx));
  let rv7 = (await req(liu.token, `/api/cards/${K7}`)).body.review;
  assert.deepEqual([rv7.state, rv7.reviewers.map(x => x.name)], ['waiting', ['示範AG']], 'I5 前一輪晚到的通過不算新一輪：' + JSON.stringify(rv7.reviewers));
  await late('rv_late2', 'changes', 2000, id(hua)); // 同一人同一輪只能一票（唯一索引），用另一人模擬舊一輪晚到的要改
  assert.equal((await req(liu.token, `/api/cards/${K7}`)).body.review.state, 'waiting', 'I5 前一輪晚到的要改也不會結束新一輪');
  assert.equal(code(await req(cx.token, `/api/cards/${K7}/review`, 'POST', { version: SHA1, result: 'pass' })), 'NOT_REVIEWER', 'I5 前一輪的審查者不是這一輪的');
  r = await req(ag.token, `/api/cards/${K7}/review`, 'POST', { version: SHA1, result: 'pass' });
  assert.equal(r.body.state, 'passed', 'I5 這一輪的審查者通過才算');

  // I6 同一位、同版本、兩輪：舊畫面的回覆（帶舊的 roundId）被拒，新一輪還在等；沒帶 roundId 分不出來也拒；帶新的 roundId 才通過
  const K8 = await mk('第八張', 'c8');
  const r81 = (await req(pg.token, `/api/cards/${K8}/review-request`, 'POST', { version: SHA1, note: 'x', reviewerId: id(cx) })).body.messageId;
  const r82 = (await req(pg.token, `/api/cards/${K8}/review-request`, 'POST', { version: SHA1, note: '同一位、同版本再送一次', reviewerId: id(cx) })).body.messageId;
  assert.equal((await req(liu.token, `/api/cards/${K8}`)).body.review.roundId, r82, 'I6 卡片回這一輪的 roundId');
  r = await req(cx.token, `/api/cards/${K8}/review`, 'POST', { version: SHA1, roundId: r81, result: 'pass' });
  assert.deepEqual([r.status, code(r)], [409, 'ROUND_CHANGED'], 'I6 舊一輪的回覆被拒');
  assert.equal(code(await req(cx.token, `/api/cards/${K8}/review`, 'POST', { version: SHA1, result: 'pass' })), 'ROUND_REQUIRED', 'I6 沒帶 roundId、分不出哪一輪：請重新讀卡');
  assert.equal((await req(liu.token, `/api/cards/${K8}`)).body.review.state, 'waiting', 'I6 新一輪仍待審');
  r = await req(cx.token, `/api/cards/${K8}/review`, 'POST', { version: SHA1, roundId: r82, result: 'pass' });
  assert.equal(r.body.state, 'passed', 'I6 帶新一輪的 roundId：通過');
  const K9 = await mk('第九張', 'c9');
  await req(pg.token, `/api/cards/${K9}/review-request`, 'POST', { version: SHA1, note: 'x', reviewerId: id(cx) });
  assert.equal((await tool(cx.token, 'aigile_review', { cardId: K9, version: SHA1, result: 'pass', roundId: 'msg_old' })).isError, true, 'I6 MCP 帶錯的 roundId 也擋');

  console.log('review-test：全部通過（預設不審、設定權限與紀錄、沒通過就擋 commit、審查者不能是作者／同一家／作者的主人、送審→要改→重新送審→通過、版本變了通過作廢、要 2 位至少一位是人、人通過就算同意 commit、diff 上傳開關（開源預設開）、比較連結、MCP）');
} finally {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
