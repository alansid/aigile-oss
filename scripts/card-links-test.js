// 驗收測試：卡片關聯（前置卡、這張擋住、關聯卡）：加／移除、循環擋下、權限、看板摘要、接單提醒、最後一張前置卡完成通知一次
// 用法：node scripts/card-links-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-card-links-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', archiveEveryMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let seq = 0;

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const mkAi = async name => {
    const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    return { id: a.participantId, name, tok: await testToken(db, a.participantId) };
  };
  const A = await mkAi('甲PG'), B = await mkAi('乙PG');
  const mk = async (title, extra = {}) => (await call(liu.token, '/api/cards', 'POST', { requestId: 'c' + (++seq), project: '預設專案', title, status: '待處理', ...extra })).body;
  const get = async (id, tok = liu.token) => (await call(tok, `/api/cards/${id}`)).body;
  const link = (tok, id, kind, cardId) => call(tok, `/api/cards/${id}/links`, 'POST', { kind, cardId });
  const unlink = (tok, id, other) => call(tok, `/api/cards/${id}/links/${other}`, 'DELETE');
  const setSt = async (id, status) => { const c = await get(id); return call(liu.token, `/api/cards/${id}`, 'PATCH', { status, version: c.version }); };
  const board = async (tok = liu.token) => new Map((await call(tok, '/api/cards?status=open')).body.items.map(c => [c.cardId, c]));

  const api7 = await mk('匯率表 API', { ownerId: B.id });
  const quote = await mk('報價單匯出加上幣別欄', { ownerId: A.id });
  const async21 = await mk('匯出改成非同步');
  const pdf15 = await mk('報價單 PDF 版型');
  const cache9 = await mk('匯率快取');

  // 1) 加前置卡（人類）：雙方都留紀錄、詳情帶 links 與 waitingHint
  let r = await link(liu.token, quote.cardId, 'blockedBy', api7.cardId);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.links.blockedBy[0].cardId, api7.cardId);
  assert.match(r.body.waitingHint, new RegExp(`這張還在等 ${api7.cardId}（待處理）。可以先做不受影響的部分`));
  let d = await get(quote.cardId);
  assert.equal(d.links.blockedBy[0].title, '匯率表 API');
  assert.equal(d.links.blockedBy[0].owner?.participantId, B.id, '帶出前置卡負責人');
  assert.ok(d.waitingHint.includes('平台不會擋接單'));
  assert.ok(d.log.some(l => l.text === `設 ${api7.cardId} 為前置卡`), '這張的時間軸有紀錄');
  assert.ok((await get(api7.cardId)).log.some(l => l.text === `設這張擋住 ${quote.cardId}`), '前置卡那張也有紀錄');
  assert.deepEqual((await get(api7.cardId)).links.blocks.map(x => x.cardId), [quote.cardId], '前置卡那張列在「這張擋住」');
  assert.equal((await get(api7.cardId)).waitingHint, undefined, '沒被擋的卡沒有 waitingHint');

  // 2) 這張擋住、關聯卡；同一對不能再連；不能連自己
  assert.equal((await link(liu.token, quote.cardId, 'blocks', async21.cardId)).status, 201);
  assert.equal((await link(liu.token, quote.cardId, 'related', pdf15.cardId)).status, 201);
  assert.equal((await link(liu.token, pdf15.cardId, 'blockedBy', quote.cardId)).body.error?.code, 'LINK_EXISTS', '同一對卡只能一種關聯（反方向也算）');
  assert.equal((await link(liu.token, quote.cardId, 'related', quote.cardId)).body.error?.code, 'LINK_SELF');
  assert.equal((await link(liu.token, quote.cardId, 'nope', pdf15.cardId)).status, 400);
  assert.equal((await link(liu.token, quote.cardId, 'related', 'MAIN-9999')).status, 404);
  d = await get(quote.cardId);
  assert.deepEqual([d.links.blockedBy.length, d.links.blocks.length, d.links.related.length], [1, 1, 1]);
  assert.deepEqual((await get(pdf15.cardId)).links.related.map(x => x.cardId), [quote.cardId], '關聯卡兩邊都看得到');

  // 3) 循環擋下：async21 已經在等 quote，quote 再等 async21 → LINK_CYCLE；間接（api7 等 async21）也擋
  r = await link(liu.token, quote.cardId, 'blockedBy', async21.cardId);
  assert.equal(r.body.error?.code, 'LINK_EXISTS', '已經連過先擋');
  r = await link(liu.token, async21.cardId, 'blocks', api7.cardId);
  assert.equal(r.status, 409); assert.equal(r.body.error?.code, 'LINK_CYCLE', '間接循環：api7 ← quote ← async21，再讓 api7 等 async21 會互相等');
  assert.match(r.body.error.message, new RegExp(`${async21.cardId} 已經在等 ${api7.cardId}`));
  let lk = (await call(liu.token, `/api/cards/${api7.cardId}/links`)).body;
  assert.deepEqual(lk.downstream.sort(), [quote.cardId, async21.cardId].sort(), '在等 api7 的（直接＋間接）');
  assert.deepEqual(lk.upstream, []);

  // 4) 權限：AI 只能替自己負責的卡（或另一張是自己的）加關聯
  r = await link(B.tok, pdf15.cardId, 'related', cache9.cardId);
  assert.equal(r.status, 403, '兩張都不是 B 的'); assert.equal(r.body.error?.code, 'NOT_CARD_OWNER');
  r = await link(B.tok, cache9.cardId, 'blocks', api7.cardId); // api7 是 B 的
  assert.equal(r.status, 201, '另一張是自己的可以');
  assert.equal((await unlink(B.tok, cache9.cardId, api7.cardId)).status, 200);
  assert.ok((await get(api7.cardId)).log.some(l => l.text === `移除前置卡 ${cache9.cardId}`), '移除寫進時間軸（被擋那張）');
  assert.ok((await get(cache9.cardId)).log.some(l => l.text === `移除這張擋住的 ${api7.cardId}`), '移除寫進時間軸（前置卡那張）');
  assert.equal((await unlink(B.tok, cache9.cardId, api7.cardId)).status, 404, '已經沒有關聯');

  // 5) 看板摘要：被擋的卡 waiting、擋住別人的卡 blocks
  let bd = await board();
  assert.deepEqual(bd.get(quote.cardId).linkSum, { waiting: [api7.cardId], blocks: 1 });
  assert.deepEqual(bd.get(api7.cardId).linkSum, { waiting: [], blocks: 1 });
  assert.equal(bd.get(pdf15.cardId).linkSum, undefined, '只有關聯卡不加標記');

  // 6) 接單提醒：A 對 quote 發 [接單] → 回應帶 cardWaiting，照樣接單（不擋）
  r = await call(A.tok, '/api/messages', 'POST', { project: '預設專案', requestId: 'm1', text: '[接單] 先做前端欄位', cardId: quote.cardId, recipientIds: [], replyFrom: [] });
  assert.equal(r.status, 201);
  assert.equal(r.body.cardWaiting, `⏳ 這張還在等 ${api7.cardId}（待處理）。`);
  assert.equal(r.body.cardStatus, '進行中', '被擋照樣接單');
  // MCP 回覆也帶出
  const { slimPost } = await import('../src/mcp.js');
  assert.equal(slimPost(r.body, 201).cardWaiting, r.body.cardWaiting);

  // 7) 前置卡完成 → 通知被擋卡負責人一次（A 是 AI，要叫醒），看板標記拿掉，被擋卡狀態不變
  const beforeQuote = await get(quote.cardId);
  const st0 = beforeQuote.status;
  assert.equal((await setSt(api7.cardId, '已完成')).status, 200);
  let noti = (await call(A.tok, '/api/notifications?status=pending')).body.items;
  let un = noti.filter(n => (n.preview || n.text || '').includes(`等的 ${api7.cardId} 已完成，可以接著做`));
  assert.equal(un.length, 1, '通知被擋卡負責人一次：' + JSON.stringify(noti.map(n => n.preview)));
  d = await get(quote.cardId);
  assert.equal(d.status, st0, '不改被擋卡的狀態');
  assert.equal(d.waitingHint, undefined, '前置卡完成後不再提醒');
  assert.ok(d.log.some(l => l.text === `完成了前置卡 ${api7.cardId}`));
  assert.ok(d.updatedAt > beforeQuote.updatedAt, '被擋卡 updated_at 變了（看板增量會帶回）');
  assert.equal(d.version, beforeQuote.version, '不動 version');
  bd = await board();
  assert.equal(bd.get(quote.cardId).linkSum?.waiting?.length || 0, 0, '看板等待標記拿掉');
  // 重開：又提醒；同一次解除不重複通知（狀態沒變的 PATCH 不算）；重開後再完成是新的一次解除
  await setSt(api7.cardId, '進行中');
  assert.match((await get(quote.cardId)).waitingHint, new RegExp(api7.cardId), '重開後又提醒');
  await setSt(api7.cardId, '已完成');
  noti = (await call(A.tok, '/api/notifications?status=pending')).body.items;
  assert.equal(noti.filter(n => (n.preview || n.text || '').includes(`等的 ${api7.cardId} 已完成`)).length, 2, '重開後再完成＝新的一次解除，再通知一次');
  await call(liu.token, `/api/cards/${api7.cardId}`, 'PATCH', { title: '匯率表 API（改名）', version: (await get(api7.cardId)).version });
  noti = (await call(A.tok, '/api/notifications?status=pending')).body.items;
  assert.equal(noti.filter(n => (n.preview || n.text || '').includes(`等的 ${api7.cardId} 已完成`)).length, 2, '沒換狀態不再通知');

  // 8) 多張前置卡：只有最後一張完成才通知
  const multi = await mk('要等兩張', { ownerId: A.id });
  const p1 = await mk('前置一'), p2 = await mk('前置二');
  await link(liu.token, multi.cardId, 'blockedBy', p1.cardId);
  await link(liu.token, multi.cardId, 'blockedBy', p2.cardId);
  bd = await board();
  assert.deepEqual(bd.get(multi.cardId).linkSum.waiting.sort(), [p1.cardId, p2.cardId].sort());
  assert.match((await get(multi.cardId)).waitingHint, /還在等 .+、.+。/);
  await setSt(p1.cardId, '已完成');
  noti = (await call(A.tok, '/api/notifications?status=pending')).body.items;
  assert.equal(noti.filter(n => (n.preview || n.text || '').includes(multi.cardId) && (n.preview || n.text || '').includes('可以接著做')).length, 0, '還有一張沒完成，不通知');
  await setSt(p2.cardId, '已完成');
  noti = (await call(A.tok, '/api/notifications?status=pending')).body.items;
  assert.equal(noti.filter(n => (n.preview || n.text || '').includes(`前置卡都完成了（最後一張 ${p2.cardId} 已完成）`)).length, 1, '最後一張完成通知一次');

  // 8b) 同時操作：兩張前置卡同時完成 → 被擋卡只通知一次
  const multi2 = await mk('同時完成的被擋卡', { ownerId: A.id });
  const q1 = await mk('同時前置一'), q2 = await mk('同時前置二');
  await link(liu.token, multi2.cardId, 'blockedBy', q1.cardId);
  await link(liu.token, multi2.cardId, 'blockedBy', q2.cardId);
  const [v1, v2] = [(await get(q1.cardId)).version, (await get(q2.cardId)).version];
  const both = await Promise.all([call(liu.token, `/api/cards/${q1.cardId}`, 'PATCH', { status: '已完成', version: v1 }), call(liu.token, `/api/cards/${q2.cardId}`, 'PATCH', { status: '已完成', version: v2 })]);
  assert.deepEqual(both.map(x => x.status), [200, 200]);
  noti = (await call(A.tok, '/api/notifications?status=pending')).body.items;
  assert.equal(noti.filter(n => (n.preview || n.text || '').includes(multi2.cardId) && (n.preview || n.text || '').includes('可以接著做')).length, 1, '兩張同時完成只通知一次：' + JSON.stringify(noti.map(n => n.preview).filter(t => t.includes(multi2.cardId))));
  assert.equal((await get(multi2.cardId)).log.filter(l => /前置卡都完成了/.test(l.text)).length, 1, '解除紀錄只一筆');
  // 同時加會互相等的關聯：只能成功一個，圖裡沒有循環
  const x1 = await mk('同時甲'), x2 = await mk('同時乙'), x3 = await mk('同時丙');
  let rr = await Promise.all([link(liu.token, x1.cardId, 'blockedBy', x2.cardId), link(liu.token, x2.cardId, 'blockedBy', x1.cardId)]);
  assert.deepEqual(rr.map(x => x.status).sort(), [201, 409], '反方向同時加：一個成功、一個擋下 ' + JSON.stringify(rr.map(x => x.body.error?.code)));
  assert.ok(rr.some(x => ['LINK_EXISTS', 'LINK_CYCLE'].includes(x.body.error?.code)));
  // 三張繞一圈：甲等乙已在；乙等丙、丙等甲同時加
  const x1s = (await get(x1.cardId)).links.blockedBy.length ? x1 : x2, x2s = x1s === x1 ? x2 : x1; // 上面成功的是「x1s 等 x2s」
  rr = await Promise.all([link(liu.token, x2s.cardId, 'blockedBy', x3.cardId), link(liu.token, x3.cardId, 'blockedBy', x1s.cardId)]);
  assert.deepEqual(rr.map(x => x.status).sort(), [201, 409], '三張同時繞圈：只能成功一個 ' + JSON.stringify(rr.map(x => x.body.error?.code)));
  assert.equal(rr.find(x => x.status === 409).body.error.code, 'LINK_CYCLE');

  // 8c) 後段失敗再恢復：寫通知訊息失敗時，時間軸紀錄照寫、待送記錄留著；下次整理補送，而且只送一次
  const w3 = await mk('通知失敗的被擋卡', { ownerId: A.id }), p3 = await mk('前置三');
  await link(liu.token, w3.cardId, 'blockedBy', p3.cardId);
  const unblockN = async () => (await call(A.tok, '/api/notifications?status=pending')).body.items.filter(n => (n.preview || '').includes(w3.cardId) && (n.preview || '').includes('可以接著做')).length;
  const pendingN = async () => Number((await db.get("SELECT COUNT(*) AS n FROM app_settings WHERE key > 'unblockq:' AND key < 'unblockq;'")).n);
  const realBatch = db.batch;
  let broke = 0;
  db.batch = async stmts => { if (stmts.some(([sql]) => /INSERT INTO messages/.test(sql))) { broke++; throw new Error('模擬寫訊息失敗'); } return realBatch.call(db, stmts); };
  try { assert.equal((await setSt(p3.cardId, '已完成')).status, 200, '前置卡完成照樣成功'); } finally { db.batch = realBatch; }
  assert.ok(broke >= 1, '有模擬到寫訊息失敗');
  assert.equal(await unblockN(), 0, '失敗時還沒送到');
  assert.equal(await pendingN(), 1, '待送記錄留著');
  assert.equal((await db.all('SELECT text FROM card_log WHERE text = ?', `完成了前置卡 ${p3.cardId}`)).length, 1, '時間軸紀錄有寫（跟待送記錄同一個交易）');
  await call(liu.token, '/api/cards?status=open'); // 下次整理（maybeArchive）補送
  assert.equal(await unblockN(), 1, '補送成功');
  assert.equal(await pendingN(), 0, '送成功就清掉');
  await call(liu.token, '/api/cards?status=open');
  assert.equal(await unblockN(), 1, '不重複送');

  // 8d) 交錯：判定「沒有未完成的前置卡」之後、拿到鎖之前，有人加了一張新的未完成前置卡 → 不能寫「都完成」、不通知
  const w4 = await mk('交錯的被擋卡', { ownerId: A.id }), p4 = await mk('前置四'), late = await mk('晚加的前置卡');
  await link(liu.token, w4.cardId, 'blockedBy', p4.cardId);
  const w4seq = Number((await db.get("SELECT card_seq FROM card_log WHERE text = ? ORDER BY id LIMIT 1", `設 ${p4.cardId} 為前置卡`)).card_seq);
  const lateRow = await db.get('SELECT seq FROM cards WHERE title = ?', '晚加的前置卡');
  let sneaked = 0;
  db.batch = async stmts => {
    if (!sneaked && stmts.some(([sql, args]) => /INSERT INTO app_settings \(key, value\) SELECT/.test(sql) && String(args?.[0]).startsWith('unblockq:'))) { sneaked++; await realBatch.call(db, [["INSERT INTO card_links (from_seq, to_seq, kind, created_by, created_at) VALUES (?,?,'blocked_by','test',?)", [w4seq, Number(lateRow.seq), new Date().toISOString()]]]); }
    return realBatch.call(db, stmts);
  };
  try { assert.equal((await setSt(p4.cardId, '已完成')).status, 200); } finally { db.batch = realBatch; }
  assert.equal(sneaked, 1, '有插隊成功');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM card_log WHERE card_seq = ? AND via = ?', w4seq, '前置卡')).n), 0, '不寫「都完成」紀錄');
  assert.equal(await pendingN(), 0, '不留待送');
  noti = (await call(A.tok, '/api/notifications?status=pending')).body.items;
  assert.equal(noti.filter(n => (n.preview || '').includes(w4.cardId) && (n.preview || '').includes('可以接著做')).length, 0, '不通知');
  assert.match((await get(w4.cardId)).waitingHint, new RegExp(late.cardId), '還在等晚加的那張');

  // 9) AI 讀卡（MCP aigile_card_get 走同一個 API）：links、waitingHint 在最前面幾個欄位
  const w2 = await mk('AI 讀卡測試', { ownerId: A.id });
  await link(A.tok, w2.cardId, 'blockedBy', cache9.cardId);
  const ad = await get(w2.cardId, A.tok);
  const keys = Object.keys(ad);
  assert.ok(keys.indexOf('waitingHint') > -1 && keys.indexOf('waitingHint') < keys.indexOf('reason'), 'waitingHint 排在前面');
  assert.ok(keys.indexOf('links') < keys.indexOf('reason'), 'links 排在前面');

  // 10) 人類紀錄卡不能加關聯
  const note = (await call(liu.token, '/api/cards', 'POST', { requestId: 'n1', project: '預設專案', title: '紀錄', type: '人類紀錄' })).body;
  assert.equal((await link(liu.token, note.cardId, 'related', pdf15.cardId)).body.error?.code, 'LINK_NOTE');

  console.log('card-links-test：全部通過');
} catch (e) {
  console.error('card-links-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
