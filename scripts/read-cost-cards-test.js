// 讀取成本回歸測試（雲端 D1 按讀取列數算額度）：看板列表、卡片詳情、專案清單、自動封存
// 本機 node:sqlite 讀不到 D1 的 rows_read，所以做兩件事：
// 1. 把看板與卡片詳情實際送出的每一條 SELECT 拿去 EXPLAIN QUERY PLAN，大表（cards、card_log、card_msgs、messages、docs）不准整張掃；
//    這次改的幾條要走指定的索引、不用暫存排序
// 2. 數「整張重讀」的次數：專案清單、自動封存在兩份程式之間共用版本記號／上次執行時間
// 用法：node scripts/read-cost-cards-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { ROLES } from '../src/roles.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-readcost-cards-'));
const raw = openNodeDb(path.join(dataDir, 'switch.db'));
const seen = []; // 這一段送出的 SELECT
let recording = false;
const spy = {
  ...raw,
  all: (sql, ...a) => { if (recording) seen.push({ sql, args: a }); return raw.all(sql, ...a); },
  get: (sql, ...a) => { if (recording) seen.push({ sql, args: a }); return raw.get(sql, ...a); },
};
const mk = (extra = {}) => createApp({ db: spy, storage: dbStorage(raw), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', cardStaleHours: String(1 / 3600), ...extra } });
const call = (app, token, p, method = 'GET', body) => app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost')
  .then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const flat = s => s.replace(/\s+/g, ' ').trim();
const planOf = async (sql, args = []) => (await raw.all('EXPLAIN QUERY PLAN ' + sql, ...args)).map(r => r.detail).join(' | ');
const BIG = ['cards', 'card_log', 'card_msgs', 'messages', 'docs', 'card_attachments'];
const fullScans = plan => plan.split(' | ').filter(d => BIG.some(t => new RegExp(`^SCAN (${t}|\\w+ )?\\b${t}\\b(?! USING (COVERING )?INDEX)`).test(d) || new RegExp(`^SCAN ${t}$`).test(d)));

try {
  const A = mk();
  const liu = (await call(A, null, '/api/join', 'POST', { name: '劉昱志', role: 'PO' })).body;
  const r = ROLES.find(x => x.key === 'PG');
  const ai = (await call(A, liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: r.role, name: '開發助手', duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body;
  const me = liu.participant.participantId, aiId = ai.participantId;
  assert.ok(aiId, '建好 AI：' + JSON.stringify(ai).slice(0, 200));

  // 造資料：用 API 建幾張要驗的卡，其餘用 SQL 一次灌（接近正式站：上千張卡、幾萬則訊息、上千份文件）
  const card = (await call(A, liu.token, '/api/cards', 'POST', { requestId: 'rc-main', project: '預設專案', title: '要看的卡' })).body;
  const note = (await call(A, liu.token, '/api/cards', 'POST', { requestId: 'rc-note', project: '預設專案', type: '人類紀錄', title: '人類紀錄' })).body;
  await call(A, liu.token, `/api/cards/${card.cardId}`, 'PATCH', { ownerId: aiId, status: '進行中', version: card.version });
  const seqOf = async id => (await raw.get('SELECT seq FROM cards WHERE project = ? AND proj_no = ?', '預設專案', Number(id.split('-')[1]))).seq;
  const mainSeq = await seqOf(card.cardId);
  const at = i => new Date(Date.parse('2026-10-01T00:00:00Z') + i * 60_000).toISOString();
  const stmts = [];
  let cs = 0, ms = 0;
  for (let i = 0; i < 800; i++) {
    const st = i < 600 ? (i % 2 ? '已完成' : '已封存') : ['待處理', '進行中', '待確認', '受阻'][i % 4];
    stmts.push([`INSERT INTO cards (uid, type, title, owner_id, status, created_by, project, proj_no, created_at, updated_at, wait_for_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ['bulk' + i, i % 9 ? '工作' : '人類紀錄', '灌的卡 ' + i, aiId, st, me, '預設專案', 10_000 + i, at(i), at(i), st === '待確認' ? me : null]]);
  }
  await raw.batch(stmts); stmts.length = 0;
  const seqs = (await raw.all("SELECT seq, status FROM cards WHERE uid LIKE 'bulk%'"));
  for (const c of [...seqs, { seq: mainSeq, status: '進行中' }]) {
    const n = c.status === '已封存' || c.status === '已完成' ? 6 : 20;
    for (let k = 0; k < n; k++) {
      ms++;
      const text = (k % 3 === 0 ? '[通知] ' : k % 5 === 0 ? '[完成] ' : '[進度] ') + '第 ' + k;
      stmts.push(['INSERT INTO messages (id, author_id, text, project, created_at) VALUES (?,?,?,?,?)', ['rcm' + ms, aiId, text, '預設專案', at(5000 + ms)]]);
      stmts.push(['INSERT INTO card_msgs (card_seq, message_id) VALUES (?,?)', [c.seq, 'rcm' + ms]]);
    }
    for (let k = 0; k < 12; k++) stmts.push(['INSERT INTO card_log (card_seq, at, by_id, via, text) VALUES (?,?,?,?,?)', [c.seq, at(k), aiId, k === 3 ? '認領' : '欄位', '紀錄 ' + k]]);
    cs++;
  }
  for (let d = 0; d < 900; d++) stmts.push(['INSERT INTO docs (id, project, name, ext, mime, size, sha256, uploader_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', ['rcd' + d, '預設專案', '檔 ' + d + '.png', 'png', 'image/png', 100, 'x', me, at(d), at(d)]]);
  stmts.push(['INSERT INTO card_attachments (doc_id, card_seq, note_id, human_only) VALUES (?,?,?,0)', ['rcd7', mainSeq, null]]);
  await raw.batch(stmts); stmts.length = 0;
  // 人類紀錄整理到這張（AI 只能標已完成＋mergedInto）
  const nv = (await call(A, liu.token, `/api/cards/${note.cardId}`)).body.version;
  const merged = await call(A, ai.token, `/api/cards/${note.cardId}`, 'PATCH', { status: '已完成', mergedInto: card.cardId, version: nv });
  assert.equal(merged.status, 200, '人類紀錄整理到這張：' + JSON.stringify(merged.body));
  await sleep(1100); // 讓卡片「夠久沒更新」，過時提示才會查
  const talk = await call(A, liu.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'rc-talk', cardId: card.cardId, text: '[回覆] 卡片更新後又有討論' });
  assert.ok(talk.status < 300, JSON.stringify(talk.body));
  await call(A, liu.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'rc-sys', cardId: card.cardId, text: '[通知] 系統訊息不算' });

  // 1. 看板與卡片詳情：每條 SELECT 都不整張掃大表
  const B = mk(); // 新的一份程式（記憶體是空的，等同 Workers 換新程式）
  seen.length = 0; recording = true;
  const list = await call(B, liu.token, '/api/cards?status=open');
  const detail = await call(B, liu.token, `/api/cards/${card.cardId}`);
  const aiDetail = await call(B, ai.token, `/api/cards/${card.cardId}`);
  recording = false;
  assert.equal(list.status, 200); assert.equal(detail.status, 200); assert.equal(aiDetail.status, 200);
  const qs = [...new Map(seen.filter(x => /^\s*(SELECT|WITH)/i.test(x.sql)).map(x => [flat(x.sql), x])).values()];
  const bad = [];
  for (const q of qs) { const p = await planOf(q.sql, q.args); if (fullScans(p).length) bad.push(flat(q.sql).slice(0, 160) + '\n      → ' + p); }
  assert.deepEqual(bad, [], '看板與卡片詳情不准整張掃大表：\n  ' + bad.join('\n  '));

  // 這次改的幾條：走指定索引、不用暫存排序
  const pick = re => { const q = qs.find(x => re.test(flat(x.sql))); assert.ok(q, '有送出這條查詢：' + re); return q; };
  const expectPlan = async (re, idx, noSort = true) => { const q = pick(re); const p = await planOf(q.sql, q.args); assert.match(p, idx, flat(q.sql).slice(0, 80) + ' 的查詢計畫：' + p); if (noSort) assert.ok(!/TEMP B-TREE/.test(p), '不用暫存排序：' + p); };
  await expectPlan(/^SELECT c\.seq AS seq, \(SELECT m\.created_at \|\| ' ' \|\| m\.id FROM card_msgs cm JOIN messages m ON m\.id = cm\.message_id WHERE cm\.card_seq = c\.seq AND m\.text NOT LIKE/, /SEARCH cm USING INDEX idx_card_msgs_card \(card_seq=\?\)/);
  await expectPlan(/FROM card_log WHERE via IN \('認領', '交接'\) AND card_seq IN/, /USING COVERING INDEX idx_card_log_claims/);
  await expectPlan(/text LIKE '已整理到 %'\) ORDER BY seq/, /idx_card_log_merged/);
  await expectPlan(/FROM card_attachments a CROSS JOIN docs d/, /^SEARCH a USING INDEX idx_card_attachments_card/, false);
  assert.ok(!qs.some(x => /cm\.card_seq IN \(SELECT value FROM json_each/.test(flat(x.sql))), '不再把每張卡的全部關聯訊息讀出來');
  const sameName = await planOf("SELECT id, name FROM docs WHERE project = '預設專案' AND deleted_at IS NULL AND name = 'x' AND id != 'y' AND folder_id IS NULL");
  assert.match(sameName, /idx_docs_name/, '文件同名檢查用 (project, name) 索引：' + sameName);

  // 結果照舊：誰正在做、整理自、附件、看板動靜、過時提示
  const d = detail.body;
  assert.equal(d.claim?.by?.participantId, aiId, '詳情的 claim 是最新的認領：' + JSON.stringify(d.claim));
  assert.deepEqual(d.mergedFrom, [note.cardId], '整理自');
  assert.deepEqual(d.attachments.map(x => x.docId), ['rcd7'], '附件');
  const lastNonSys = (await raw.get("SELECT m.created_at AS at FROM card_msgs cm JOIN messages m ON m.id = cm.message_id WHERE cm.card_seq = ? AND m.text NOT LIKE '[通知]%' ORDER BY m.created_at DESC LIMIT 1", mainSeq)).at;
  assert.equal(d.lastActivityAt >= lastNonSys, true, `看板動靜取到最新的非 [通知] 訊息（${d.lastActivityAt} vs ${lastNonSys}）`);
  const it = list.body.items.find(x => x.cardId === card.cardId);
  assert.ok(it?.staleHint, '列表上照樣標出可能過時');
  assert.equal(it.staleHint.latestMessageAt, lastNonSys, '過時提示是最後一則非 [通知] 的關聯訊息');
  assert.equal(it.claim?.by?.participantId, aiId, '列表上的 claim');
  const waiting = list.body.items.filter(x => x.status === '待確認' && x.report);
  assert.ok(waiting.length > 10, '待確認的卡找得到負責人的 [完成] 回報：' + waiting.length);

  // 新加的關聯訊息補得到（之後只補讀新的）
  seen.length = 0; recording = true;
  const fresh = await call(B, ai.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'rc-new', cardId: card.cardId, text: '[進度] 最新一則' });
  assert.ok(fresh.status < 300, JSON.stringify(fresh.body));
  const after = await call(B, liu.token, `/api/cards/${card.cardId}`);
  recording = false;
  assert.equal(after.body.lastActivityAt >= fresh.body.createdAt, true, '新的關聯訊息算進看板動靜');
  assert.ok(!seen.some(x => /cm\.card_seq = c\.seq AND m\.text NOT LIKE/.test(flat(x.sql))), '讀過的卡不再整批補讀');

  // 2. 專案清單：兩份程式共用版本記號；沒改專案就不整張重讀
  const P1 = mk({ projectsCheckMs: '40' }), P2 = mk({ projectsCheckMs: '40' });
  for (let i = 0; i < 2; i++) { await call(P1, liu.token, '/api/projects'); await call(P2, liu.token, '/api/projects'); await sleep(50); }
  seen.length = 0; recording = true;
  for (let i = 0; i < 6; i++) { await sleep(50); await call(P1, liu.token, '/api/projects'); await call(P2, ai.token, '/api/me'); }
  recording = false;
  const projFull = () => seen.filter(x => /^SELECT \* FROM projects/.test(flat(x.sql))).length;
  assert.equal(projFull(), 0, `沒改專案不整張重讀專案表（讀了 ${projFull()} 次）`);
  assert.ok(seen.some(x => /key = 'projects_ver'/.test(x.sql)), '到期只讀版本記號');
  const pid = (await call(P1, liu.token, '/api/projects')).body.items.find(p => p.id === '第二專案')?.id;
  assert.ok(pid, '有第二專案');
  const ren = await call(P1, liu.token, `/api/projects/${encodeURIComponent(pid)}`, 'PATCH', { name: '第二專案（改名）' });
  assert.equal(ren.status, 200, '改專案名稱：' + JSON.stringify(ren.body));
  await sleep(60);
  const p2 = (await call(P2, liu.token, '/api/projects')).body.items.find(p => p.id === pid);
  assert.equal(p2?.name, '第二專案（改名）', '另一份程式也看到新名稱');

  // 3. 自動封存：兩份程式共用上次執行時間，不各自每輪掃一次已完成卡
  const R1 = mk({ archiveEveryMs: '300' }), R2 = mk({ archiveEveryMs: '300' });
  seen.length = 0; recording = true;
  const t0 = Date.now();
  for (let i = 0; i < 8; i++) { await call(i % 2 ? R1 : R2, liu.token, '/api/cards?status=open&limit=5'); await sleep(90); }
  recording = false;
  const scans = seen.filter(x => /FROM cards WHERE status = '已完成' AND verified_by IS NOT NULL/.test(flat(x.sql))).length;
  // 上限照實際花的時間算（全套同時跑時請求會變慢）：共用時間＝每 300 毫秒最多 1 次；各自算的話兩份程式會各掃一次、約兩倍
  const most = Math.floor((Date.now() - t0) / 300) + 1;
  assert.ok(scans >= 1 && scans <= most, `花了 ${Date.now() - t0} 毫秒、間隔 300 毫秒，全站最多掃 ${most} 次（掃了 ${scans} 次）`);

  console.log('read-cost-cards-test：全部通過');
} catch (e) {
  console.error('read-cost-cards-test 失敗：', e.message, (e.stack.split('\n').find(l => l.includes('read-cost-cards-test.js')) || '').trim());
  process.exitCode = 1;
} finally {
  await raw.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
