// 永久刪除已封存的專案（POST /api/projects/:id/delete）
// - 只有群組管理員；沒封存的擋（409）；要輸入專案名稱；只屬於這個專案的 AI 一起刪（跟「刪除 AI」一樣）
// - 預覽（delete-preview）列出訊息、卡片、文件、上傳檔、技能、成員數
// - 刪掉：卡片與紀錄、訊息與通知、決策、上傳檔與文件（含本體）、技能、加入申請、私訊、專案事件與設定；人和 AI 留著、不再屬於這個專案
// - 跨專案頻道（project=all）與其他專案的資料不動；留一筆全站紀錄（GET /api/project-deletions）
// 修正前：只能封存／還原，沒有真正刪除
// 本機暫存資料庫，不連正式站。用法：node scripts/project-delete-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';
import { testToken } from './test-token.js'; // 資料庫只存雜湊：換一組已知的 Token

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-projdel-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const docs = memStorage();
const app = createApp({ db, storage: dbStorage(db), docStorage: docs, docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const n = async (sql, ...a) => (await db.get(sql, ...a)).n;
let rq = 0;

try {
  const join = async (name, role) => (await call(null, '/api/join', 'POST', { name, role })).body;
  const liu = await join('林志明', 'PO'); // 第一位人類＝管理員
  const wang = await join('陳小美', 'UX');
  const id = p => p.participant.participantId;
  const np = (await call(liu.token, '/api/projects', 'POST', { name: '要刪的專案', code: 'DEL' })).body;
  const pid = np.items.find(p => p.name === '要刪的專案').id;
  const enc = encodeURIComponent(pid);
  assert.equal((await call(liu.token, `/api/participants/${id(wang)}/projects`, 'PUT', { projects: ['預設專案', pid] })).status, 200);
  assert.equal((await call(liu.token, '/api/members/matrix', 'PUT', { changes: [{ id: id(wang), leaderOf: [pid] }] })).status, 200, 'wang 當 leader');
  const mkAi = async (name, projects) => (await call(liu.token, '/api/my-ais', 'POST', { projects, roleKey: 'PG', role: 'PG', name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiOnly = await mkAi('只在這裡的AI', [pid]);
  const aiBoth = await mkAi('兩邊都有的AI', ['預設專案', pid]);
  // 內容：這個專案的訊息（含通知）、卡片、文件、上傳檔、技能、私訊、加入申請；別的專案與跨專案頻道各一則
  const post = (project, text, extra = {}) => call(liu.token, '/api/messages', 'POST', { project, text, requestId: 'r' + (++rq), recipientIds: [id(wang)], ...extra });
  const m1 = (await post(pid, '[需確認] 這個專案的問題\n選項：\nA. 好\nB. 不好')).body;
  await post(pid, '第二則');
  const keepPlat = (await post('預設專案', '另一個專案的訊息')).body, keepAll = (await post('all', '跨專案頻道的訊息')).body;
  assert.ok(m1.messageId && keepPlat.messageId && keepAll.messageId, '發文成功：' + JSON.stringify([m1, keepPlat, keepAll]).slice(0, 300));
  assert.equal((await call(liu.token, `/api/decisions/${m1.messageId}/resolve`, 'POST')).status, 200, '標為已處理');
  assert.equal(await n('SELECT COUNT(*) AS n FROM decision_resolutions WHERE message_id = ?', m1.messageId), 1, '有決策紀錄');
  const card = (await call(liu.token, '/api/cards', 'POST', { title: '這個專案的卡', project: pid, requestId: 'c1' })).body;
  const keepCard = (await call(liu.token, '/api/cards', 'POST', { title: '另一個專案的卡', project: '預設專案', requestId: 'c2' })).body;
  assert.ok(card.cardId && keepCard.cardId, '建卡');
  const cardSeq = (await db.get('SELECT seq FROM cards WHERE uid = ? OR proj_no IS NOT NULL AND project = ?', card.uid || '', pid)).seq;
  const at = new Date().toISOString();
  await db.run("INSERT INTO files (id, uploader_id, name, ext, mime, size, sha256, declared, message_id, created_at, expires_at) VALUES ('fil_del', ?, 'a.txt', 'txt', 'text/plain', 3, 'x', 1, ?, ?, ?)", id(liu), m1.messageId, at, Date.now() + 864e5);
  await db.run("INSERT INTO file_chunks (file_id, idx, data) VALUES ('fil_del', 0, X'616263')");
  await db.run("INSERT INTO files (id, uploader_id, name, ext, mime, size, sha256, declared, message_id, created_at, expires_at) VALUES ('fil_keep', ?, 'b.txt', 'txt', 'text/plain', 3, 'x', 1, ?, ?, ?)", id(liu), keepPlat.messageId, at, Date.now() + 864e5);
  await db.run("INSERT INTO docs (id, project, name, ext, mime, size, sha256, uploader_id, created_at, updated_at) VALUES ('doc_del', ?, '規格', 'md', 'text/markdown', 3, 'x', ?, ?, ?)", pid, id(liu), at, at);
  await db.run("INSERT INTO doc_folders (id, project, name, created_at) VALUES ('fd_del', ?, '資料夾', ?)", pid, at);
  await docs.put('docs/doc_del', new Uint8Array([1, 2, 3])); await docs.put('docs/doc_keep', new Uint8Array([4]));
  await db.run("INSERT INTO skills (id, project, name, version, files, sha256, size, status, uploaded_by, uploaded_at) VALUES ('sk_del', ?, 'del-skill', 1, '[]', 'x', 1, 'published', ?, ?)", pid, id(liu), at);
  await db.run("INSERT INTO skill_installs (ai_id, skill_id, at) VALUES (?, 'sk_del', ?)", aiBoth.participantId, at);
  await db.run("INSERT INTO dms (id, human_id, ai_id, from_id, text, project, request_id, created_at) VALUES ('dm_del', ?, ?, ?, '私訊', ?, 'd1', ?)", id(liu), aiBoth.participantId, id(liu), pid, at);
  await db.run("INSERT INTO join_requests (id, project, participant_id, created_at) VALUES ('jr_del', ?, ?, ?)", pid, id(liu), at);
  await db.run("INSERT INTO app_settings (key, value) VALUES (?, '{\"url\":\"https://example.com/repo\"}')", 'repo:' + pid);
  await db.run("UPDATE app_settings SET value = json_set(COALESCE(value, '{}'), '$.' || ?, json('[\"' || ? || '\"]')) WHERE key = 'read_only'", pid, id(wang)).catch(() => {});
  assert.ok(await n('SELECT COUNT(*) AS n FROM notifications WHERE message_id = ?', m1.messageId), '有通知');
  const flagWin = () => call(liu.token, `/api/projects/${enc}/delete-preview`);

  // 1. 沒封存：擋
  let r = await flagWin();
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'NOT_ARCHIVED');
  assert.equal((await call(liu.token, `/api/projects/${enc}/delete`, 'POST', { confirmName: '要刪的專案' })).body.error.code, 'NOT_ARCHIVED', '沒封存不能刪');
  // 封存要先結案
  await db.run("UPDATE cards SET status = '已完成' WHERE project = ?", pid);
  assert.equal((await call(liu.token, `/api/projects/${enc}/archive`, 'POST')).status, 200, '封存');
  // 2. 只有管理員
  assert.equal((await call(wang.token, `/api/projects/${enc}/delete-preview`)).status, 403, '非管理員看不到預覽');
  assert.equal((await call(wang.token, `/api/projects/${enc}/delete`, 'POST', { confirmName: '要刪的專案' })).status, 403, '非管理員不能刪（leader 也不行）');
  // 3. 預覽：數量；只屬於這個專案的 AI 列出來（會一起刪），不算在留下的成員裡
  r = await flagWin();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual({ ...r.body.counts }, { messages: 2, cards: 1, docs: 1, files: 1, skills: 1, members: 3 }, '預覽數量：' + JSON.stringify(r.body.counts));
  assert.deepEqual(r.body.aisToDelete, ['只在這裡的AI'], '列出會一起刪的 AI');
  const aiOnlyTok = await testToken(db, aiOnly.participantId);
  assert.equal((await call(aiOnlyTok, '/api/me')).status, 200, '刪之前 AI 能用');
  r = await flagWin();
  assert.deepEqual(r.body.blockers, [], '沒有擋下原因了');
  // 4. 名稱要打對
  r = await call(liu.token, `/api/projects/${enc}/delete`, 'POST', { confirmName: '要刪的' });
  assert.equal(r.status, 400, '名稱不對'); assert.match(r.body.error.message, /要刪的專案/);

  // 5. 刪除
  r = await call(liu.token, `/api/projects/${enc}/delete`, 'POST', { confirmName: ' 要刪的專案 ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!r.body.items.some(p => p.id === pid), '專案清單沒有它了');
  assert.equal(r.body.deleted.name, '要刪的專案'); assert.equal(r.body.deleted.counts.messages, 2);
  const left = {};
  for (const [t, sql] of Object.entries({
    messages: 'SELECT COUNT(*) AS n FROM messages WHERE project = ?', cards: 'SELECT COUNT(*) AS n FROM cards WHERE project = ?',
    docs: 'SELECT COUNT(*) AS n FROM docs WHERE project = ?', doc_folders: 'SELECT COUNT(*) AS n FROM doc_folders WHERE project = ?',
    skills: 'SELECT COUNT(*) AS n FROM skills WHERE project = ?', dms: 'SELECT COUNT(*) AS n FROM dms WHERE project = ?',
    join_requests: 'SELECT COUNT(*) AS n FROM join_requests WHERE project = ?', project_events: 'SELECT COUNT(*) AS n FROM project_events WHERE project_id = ?',
    projects: 'SELECT COUNT(*) AS n FROM projects WHERE id = ?',
    settings: "SELECT COUNT(*) AS n FROM app_settings WHERE key IN ('pcode:' || ?1, 'slug:' || ?1, 'repo:' || ?1, 'roles:' || ?1, 'pnomax:' || ?1, 'dm:' || ?1)",
  })) left[t] = await n(sql, pid);
  assert.ok(Object.values(left).every(v => v === 0), '這個專案的資料都刪了：' + JSON.stringify(left));
  assert.equal(await n('SELECT COUNT(*) AS n FROM notifications WHERE message_id = ?', m1.messageId), 0, '通知刪了');
  assert.equal(await n('SELECT COUNT(*) AS n FROM message_recipients WHERE message_id = ?', m1.messageId), 0, '收件人刪了');
  assert.equal(await n('SELECT COUNT(*) AS n FROM decision_resolutions WHERE message_id = ?', m1.messageId), 0, '決策紀錄刪了');
  assert.equal(await n('SELECT COUNT(*) AS n FROM card_log WHERE card_seq = ?', cardSeq), 0, '卡片紀錄刪了');
  assert.equal(await n("SELECT COUNT(*) AS n FROM files WHERE id = 'fil_del'"), 0, '上傳檔刪了');
  assert.equal(await n("SELECT COUNT(*) AS n FROM file_chunks WHERE file_id = 'fil_del'"), 0, '上傳檔本體刪了');
  assert.equal(await n("SELECT COUNT(*) AS n FROM skill_installs WHERE skill_id = 'sk_del'"), 0, '技能安裝紀錄刪了');
  assert.ok(!docs.map.has('docs/doc_del') && docs.map.has('docs/doc_keep'), '文件本體刪了、別人的留著');
  assert.equal(await n("SELECT COUNT(*) AS n FROM app_settings WHERE key LIKE 'pcodeold:%' AND value = ?", pid), 0);
  // 其他專案與跨專案頻道不動
  assert.equal(await n('SELECT COUNT(*) AS n FROM messages WHERE id IN (?, ?)', keepPlat.messageId, keepAll.messageId), 2, '另一個專案與跨專案頻道的訊息留著');
  assert.equal(await n("SELECT COUNT(*) AS n FROM files WHERE id = 'fil_keep'"), 1, '另一個專案的上傳檔留著');
  assert.equal(await n("SELECT COUNT(*) AS n FROM cards WHERE project = '預設專案'"), 1, '另一個專案的卡留著');
  // 人和 AI 留著、不再屬於這個專案；設定裡也拿掉
  for (const p of [id(liu), id(wang), aiBoth.participantId]) {
    const row = await db.get('SELECT projects, status FROM participants WHERE id = ?', p);
    assert.ok(row && row.status === 'active' && !row.projects.split(',').includes(pid), '帳號留著、拿掉專案：' + JSON.stringify(row));
  }
  // 只屬於這個專案的 AI：跟「刪除 AI」一樣（狀態 deleted、Token 失效、工作記憶清掉）
  const gone = await db.get('SELECT status, projects FROM participants WHERE id = ?', aiOnly.participantId);
  assert.deepEqual({ ...gone }, { status: 'deleted', projects: '' }, '只屬於它的 AI 刪了：' + JSON.stringify(gone));
  assert.equal((await call(aiOnlyTok, '/api/me')).status, 401, '那隻 AI 的 Token 失效');
  assert.ok(!(await call(liu.token, '/api/my-ais')).body.items.some(a => a.participantId === aiOnly.participantId), '我的 AI 清單沒有它');
  assert.deepEqual(r.body.deleted.aisDeleted, ['只在這裡的AI'], '紀錄寫了一起刪的 AI');
  for (const key of ['project_leaders', 'read_only', 'project_roles', 'join_settings']) {
    const v = (await db.get('SELECT value FROM app_settings WHERE key = ?', key))?.value || '';
    assert.ok(!v.includes(pid), `${key} 沒有殘留：${v}`);
  }
  assert.equal((await call(wang.token, '/api/me')).status, 200, '成員照常登入');
  // 6. 全站紀錄
  r = await call(liu.token, '/api/project-deletions');
  assert.equal(r.status, 200);
  assert.equal(r.body.items[0].name, '要刪的專案'); assert.equal(r.body.items[0].byName, '林志明'); assert.equal(r.body.items[0].code, 'DEL');
  assert.equal(r.body.items[0].counts.cards, 1);
  assert.equal((await call(wang.token, '/api/project-deletions')).status, 403, '只有管理員看得到刪除紀錄');
  // 7. 刪掉的專案再呼叫：404；同名可以再建
  assert.equal((await call(liu.token, `/api/projects/${enc}/delete-preview`)).status, 404);
  r = await call(liu.token, '/api/projects', 'POST', { name: '要刪的專案', code: 'DEL' });
  assert.ok(r.status < 300 && r.body.items.some(p => p.name === '要刪的專案' && p.code === 'DEL'), '同名同代號可以再建：' + JSON.stringify(r.body).slice(0, 200));
  console.log('project-delete-test：全部通過');
} catch (e) {
  console.error('project-delete-test 失敗：', e.message, (e.stack || '').split('\n').slice(1, 3).join(' | '));
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
