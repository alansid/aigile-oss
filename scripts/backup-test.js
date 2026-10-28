// 驗收測試：管理員一鍵備份匯出與匯入
// 1. 匯出：整個群組資料（成員、專案、訊息、卡片、決策、技能、設定）一個檔，有版本號；分頁拿，不會一次全讀
// 2. 不含 Token、密碼雜湊、裝置登入、登入碼、邀請、AI 接入連結
// 3. 匯入只在空站可用：先預覽（清單有數量）、再確認；版本太新或不是備份檔就擋；中途失敗可以重來
// 4. 附件（訊息附件、專案文件）可選擇不含；技能包一定帶
// 5. 匯入後：資料一樣、匯入的人登入（密碼、裝置）改掛到備份裡的管理員、AI 的舊 Token 不能用
// 6. 每張資料表都要決定匯不匯出（新增資料表忘了放清單會失敗）
// 用法：node scripts/backup-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { memStorage } from '../src/storage-r2.js';
import { EXPORT_TABLES, SKIP_TABLES } from '../src/backup.js';
import { APP_VERSION } from '../src/version.js';
import { testToken } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-backup-'));
const site = name => {
  const db = openNodeDb(path.join(dataDir, name + '.db'), { legacyProjects: false });
  const docs = memStorage();
  const app = createApp({ db, storage: dbStorage(db), docStorage: docs, docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', peopleCheckMs: '1' } });
  const call = async (token, p, method = 'GET', body, raw) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(raw ? {} : { 'Content-Type': 'application/json' }) }, body: raw ?? (body ? JSON.stringify(body) : undefined) }), 'http://localhost');
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
  };
  return { db, docs, call };
};
const b64 = u8 => Buffer.from(u8).toString('base64');
const enc = s => new TextEncoder().encode(s);
let n = 0;
const rid = () => 'bk' + ++n;

// 跟網頁做的一樣：先拿清單，一張表一頁一頁拿，文件一份一份拿
async function exportAll(s, tok, files) {
  const info = (await s.call(tok, `/api/admin/backup?files=${files ? 1 : 0}`)).body;
  const out = { format: info.format, formatVersion: info.formatVersion, appVersion: info.appVersion, exportedAt: info.exportedAt, includeFiles: info.includeFiles, tables: {}, docs: [] };
  let pages = 0;
  for (const t of info.tables) {
    out.tables[t.name] = [];
    for (let after = 0; ;) {
      const r = await s.call(tok, `/api/admin/backup/rows?table=${t.name}&after=${after}&files=${files ? 1 : 0}`);
      assert.equal(r.status, 200, t.name + JSON.stringify(r.body));
      out.tables[t.name].push(...r.body.rows); pages++;
      if (r.body.next == null) break;
      after = r.body.next;
    }
  }
  for (const id of info.docs) out.docs.push({ id, b64: b64((await s.call(tok, `/api/admin/backup/doc?id=${id}`)).body) });
  return { info, backup: out, pages };
}
async function importAll(s, tok, bk) {
  let r = await s.call(tok, '/api/admin/restore/begin', 'POST', { format: bk.format, formatVersion: bk.formatVersion, appVersion: bk.appVersion });
  if (r.status !== 200) return r;
  for (const [t, rows] of Object.entries(bk.tables)) {
    for (let i = 0; i < rows.length; i += 200) {
      r = await s.call(tok, '/api/admin/restore/rows', 'POST', { table: t, rows: rows.slice(i, i + 200) });
      assert.equal(r.status, 200, t + JSON.stringify(r.body));
    }
  }
  for (const d of bk.docs) assert.equal((await s.call(tok, `/api/admin/restore/doc?id=${d.id}`, 'POST', null, Buffer.from(d.b64, 'base64'))).status, 200);
  return s.call(tok, '/api/admin/restore/finish', 'POST', {});
}

try {
  // 6. 每張表都有歸屬
  const A = site('a');
  const all = (await A.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map(r => r.name);
  for (const t of all) assert.ok(EXPORT_TABLES.includes(t) || SKIP_TABLES.includes(t), `資料表 ${t} 要放進 EXPORT_TABLES 或 SKIP_TABLES`);

  // ---- 站 A：做一些資料 ----
  const liu = (await A.call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body; // 第一位＝管理員
  const pj = (await A.call(liu.token, '/api/me')).body.projects[0];
  assert.equal((await A.call(liu.token, '/api/me/password', 'PUT', { username: 'boss', newPassword: 'pass-word-1', newPasswordAgain: 'pass-word-1' })).status, 200);
  const chen = (await A.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const ai = (await A.call(liu.token, '/api/my-ais', 'POST', { projects: [pj], roleKey: 'PG', role: 'PG', name: '小明的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = (await testToken(A.db, ai.participantId));
  for (let i = 0; i < 620; i++) await A.db.run("INSERT INTO messages (id, author_id, text, request_id, project, created_at) VALUES (?,?,?,?,?,?)", 'msg_bulk' + i, liu.participant.participantId, '第 ' + i + ' 則', 'bulk' + i, pj, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
  const m = (await A.call(aiTok, '/api/messages', 'POST', { requestId: rid(), project: pj, text: '[完成] 做好了' })).body;
  assert.ok(m.messageId, JSON.stringify(m));
  const card = (await A.call(liu.token, '/api/cards', 'POST', { requestId: rid(), project: pj, title: '登入頁', ownerId: ai.participantId })).body;
  assert.ok(card.cardId, JSON.stringify(card));
  const dec = (await A.call(liu.token, '/api/cards', 'POST', { requestId: rid(), project: pj, type: '決策', title: '要不要上線', question: '？', options: ['上線', '先不要'], deciderId: liu.participant.participantId })).body;
  assert.ok(dec.cardId, JSON.stringify(dec));
  const sk = await A.call(liu.token, `/api/projects/${pj}/skills`, 'POST', { files: [{ path: 'SKILL.md', text: '---\nname: rules\ndescription: 規則\n---\n規則\n' }] });
  assert.equal(sk.status, 201, JSON.stringify(sk.body));
  const pack = await A.call(liu.token, `/api/projects/${pj}/skills`, 'POST', { files: [{ path: '.claude-plugin/plugin.json', text: '{"name":"demo-pack"}' }, { path: 'skills/a/SKILL.md', text: '---\nname: a\ndescription: a\n---\na\n' }] });
  assert.equal(pack.status, 201, JSON.stringify(pack.body));
  const doc = await A.call(liu.token, `/api/projects/${pj}/docs?name=spec.md&declared=true`, 'POST', null, enc('# 規格\n內容'));
  assert.equal(doc.status, 201, JSON.stringify(doc.body));
  const att = await A.call(liu.token, `/api/files?name=note.txt&declared=true&project=${pj}`, 'POST', null, enc('附件內容'));
  assert.equal(att.status, 201, JSON.stringify(att.body));
  await A.db.run("INSERT INTO app_settings (key, value) VALUES ('olink:p_x', '{\"h\":\"secret\"}')");

  // 只有管理員能匯出
  assert.equal((await A.call(chen.token, '/api/admin/backup')).status, 403, '非管理員不能匯出');
  assert.equal((await A.call(aiTok, '/api/admin/backup')).status, 403, 'AI 不能匯出');

  // 1、2、4. 匯出（含附件）
  const { info, backup, pages } = await exportAll(A, liu.token, true);
  assert.equal(info.appVersion, APP_VERSION, '有版本號');
  assert.equal(info.format, 'aigile-backup');
  assert.equal(info.empty, false);
  assert.ok(pages > EXPORT_TABLES.length, '分頁拿（訊息 600 多則不是一次）');
  assert.equal(backup.tables.messages.length, (await A.db.get('SELECT COUNT(*) AS n FROM messages')).n, '訊息全部');
  assert.ok(backup.tables.messages.length > 620);
  for (const t of ['participants', 'projects', 'messages', 'cards', 'skills', 'app_settings', 'docs', 'files']) assert.ok(backup.tables[t]?.length, '有 ' + t);
  for (const t of SKIP_TABLES) assert.equal(backup.tables[t], undefined, '不帶 ' + t);
  const text = JSON.stringify(backup);
  for (const tok of [liu.token, chen.token, aiTok]) assert.ok(!text.includes(tok), '不含 Token');
  assert.ok(!/pbkdf2/.test(text), '不含密碼雜湊');
  assert.ok(!backup.tables.participants.some(p => 'token' in p), '成員不帶 token 欄');
  assert.ok(!backup.tables.app_settings.some(s => s.key.startsWith('olink:')), '不帶 AI 接入連結');
  assert.equal(backup.docs.length, 1, '文件本體');
  assert.ok(backup.tables.file_chunks.some(c => c.file_id.startsWith('skillpack_')), '技能包本體');
  assert.ok(backup.tables.file_chunks.some(c => c.file_id.startsWith('file_')), '附件本體');
  // 不含附件：沒有 files、docs，但技能包還在
  const noFiles = (await exportAll(A, liu.token, false)).backup;
  assert.equal(noFiles.tables.files, undefined); assert.equal(noFiles.tables.docs, undefined); assert.equal(noFiles.docs.length, 0);
  assert.ok(noFiles.tables.file_chunks.every(c => c.file_id.startsWith('skillpack_')) && noFiles.tables.file_chunks.length, '不含附件時只帶技能包');

  // 3. 不是空站不能匯入
  assert.equal((await A.call(liu.token, '/api/admin/restore/begin', 'POST', backup)).body.error?.code, 'NOT_EMPTY');

  // ---- 站 B：新站，管理員同名（要能避開撞名）----
  const B = site('b');
  const me = (await B.call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body;
  assert.equal((await B.call(me.token, '/api/me/password', 'PUT', { username: 'newboss', newPassword: 'pass-word-2', newPasswordAgain: 'pass-word-2' })).status, 200);
  const dev = (await B.call(null, '/api/auth/password', 'POST', { username: 'newboss', password: 'pass-word-2' })).body.token;
  assert.ok(String(dev).startsWith('dv_'), '裝置登入');
  const bInfo = (await B.call(dev, '/api/admin/backup')).body;
  assert.equal(bInfo.empty, true, '新站是空站（可匯入）');
  assert.equal((await B.call(dev, '/api/admin/restore/begin', 'POST', { ...backup, format: 'x' })).status, 400, '不是備份檔');
  assert.equal((await B.call(dev, '/api/admin/restore/begin', 'POST', { ...backup, appVersion: '9.0.0' })).body.error?.code, 'BACKUP_TOO_NEW');
  assert.equal((await B.call(dev, '/api/admin/restore/rows', 'POST', { table: 'messages', rows: [] })).body.error?.code, 'NOT_RESTORING', '沒開始不能送資料');
  // 中途失敗：送一半就停，再從頭來一次
  assert.equal((await B.call(dev, '/api/admin/restore/begin', 'POST', backup)).status, 200);
  assert.equal((await B.call(dev, '/api/admin/restore/rows', 'POST', { table: 'participants', rows: backup.tables.participants })).status, 200);
  assert.equal((await B.call(dev, '/api/admin/restore/rows', 'POST', { table: 'devices', rows: [{}] })).status, 400, '不收登入用的表');
  const fin = await importAll(B, dev, backup);
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal(fin.body.admin.name, '王小明', '管理員是備份裡的');

  // 5. 資料一樣
  for (const t of ['participants', 'messages', 'cards', 'card_log', 'skills', 'docs', 'files', 'projects']) {
    assert.equal((await B.db.get(`SELECT COUNT(*) AS n FROM ${t}`)).n, backup.tables[t].length, t + ' 列數一樣');
  }
  const meB = (await B.call(dev, '/api/me')).body;
  assert.equal(meB.participantId, liu.participant.participantId, '你的裝置登入改掛到備份裡的管理員');
  assert.equal((await B.call(me.token, '/api/me')).body.participantId, liu.participant.participantId, '你的登入碼也跟著過去');
  assert.equal((await B.call(null, '/api/auth/password', 'POST', { username: 'newboss', password: 'pass-word-2' })).status, 200, '你的密碼照舊能登入');
  assert.equal((await B.call(null, '/api/auth/password', 'POST', { username: 'boss', password: 'pass-word-1' })).status, 400, '備份裡的密碼沒帶過來');
  assert.equal((await B.call(aiTok, '/api/me')).status, 401, 'AI 的舊 Token 不能用（要重發）');
  assert.equal((await B.call(chen.token, '/api/me')).status, 401, '其他人的舊登入不能用（要重設登入）');
  assert.equal((await B.db.get("SELECT COUNT(*) AS n FROM participants WHERE name LIKE '%匯入中%'")).n, 0, '暫時的你刪掉了');
  const decB = await B.call(dev, `/api/cards/${dec.cardId}`);
  assert.equal(decB.body.decision?.question, '？', '決策卡：' + JSON.stringify(decB.body).slice(0, 300));
  assert.equal((await B.call(dev, `/api/projects/${pj}/skills`)).body.items.length, 2, '技能（含技能包）');
  const pk = (await B.db.get("SELECT id FROM skills WHERE name = 'demo-pack'")).id;
  assert.ok(await B.db.get('SELECT 1 AS x FROM file_chunks WHERE file_id = ?', 'skillpack_' + pk), '技能包本體');
  const docId = doc.body.docId || doc.body.items?.[0]?.docId || doc.body.doc?.docId || backup.tables.docs[0].id;
  const got = await B.call(dev, `/api/projects/${pj}/docs/${docId}`);
  assert.equal(got.status, 200, '文件下載得到');
  assert.equal(new TextDecoder().decode(got.body), '# 規格\n內容');
  assert.equal(new TextDecoder().decode((await B.call(dev, `/api/files/${att.body.file.fileId}`)).body), '附件內容', '附件');
  assert.equal((await B.call(dev, '/api/admin/backup')).body.empty, false, '匯入後不是空站（不能再匯一次）');
  // 6. 匯入後其他人類要重設登入：管理員的成員清單標出來；發了重設連結就不再標
  const ppl = async tok => (await B.call(tok, '/api/participants')).body.items;
  const chenId = chen.participant.participantId;
  assert.equal((await ppl(dev)).find(p => p.participantId === chenId)?.needsLogin, true, '其他人類標「要重設登入」');
  assert.equal((await ppl(dev)).find(p => p.participantId === chenId)?.isOnline, false, '舊站的在線狀態不帶過來（他還進不來）');
  assert.ok(!(await ppl(dev)).find(p => p.participantId === meB.participantId)?.needsLogin, '自己不標');
  assert.ok((await ppl(dev)).filter(p => p.memberType === 'ai').every(p => !p.needsLogin), 'AI 不標（AI 是重發 Token）');
  assert.ok(!((await exportAll(B, dev, false)).backup.tables.app_settings || []).some(r => String(r.key).startsWith('relogin:')), '「要重設登入」標記不進備份');
  assert.equal((await B.call(dev, `/api/participants/${chenId}/reset-login`, 'POST', {})).status, 200, '重設登入');
  assert.ok(!(await ppl(dev)).find(p => p.participantId === chenId)?.needsLogin, '發了重設連結就不再標');
  console.log('backup-test：全部通過');
} catch (e) {
  console.error('backup-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
}
