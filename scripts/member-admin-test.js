// 成員管理與憑證保存
// 1. 登入碼與 AI Token 只存雜湊：資料庫沒有原文、拿雜湊本身登入不算數；原文只在建立／重發／產生當下給一次
// 2. 舊資料（原文）照樣能用：驗證時順手轉成雜湊；啟動後第一個請求把全部舊的轉掉
// 3. 停用成員：裝置、登入碼、帳號密碼、他的 AI 全部不能用；名單標已停用；恢復後帳號密碼能登入，AI 要重發
// 4. 管理員是明確標記：可以交給別人；不再看誰最早加入；舊資料庫升級（migrations/001）把原本的管理員標起來
// 用法：node scripts/member-admin-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { migrateNode } from '../src/migrations.js';
import { hashOf } from './test-token.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-member-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const mk = () => createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', authFailLimit: '1000', joinLimitPerHour: '100000' } });
let app = mk();
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const S = { duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' };
const stored = async id => (await db.get('SELECT token FROM participants WHERE id = ?', id)).token;
const pwLogin = (username, password) => call(null, '/api/auth/password', 'POST', { username, password });

try {
  // ---------- 1. 只存雜湊 ----------
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO', username: 'boss.lin', password: 'longpassword1', passwordAgain: 'longpassword1' })).body;
  const B = boss.participant.participantId;
  assert.equal(await stored(B), hashOf(boss.token), '人類登入碼只存雜湊');
  const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', ...S })).body;
  assert.ok(ai.token, '建立當下給一次 Token 原文');
  assert.equal(await stored(ai.participantId), hashOf(ai.token), 'AI Token 只存雜湊');
  assert.equal((await call(ai.token, '/api/me')).status, 200, 'Token 照常能用');
  assert.equal((await call(await stored(ai.participantId), '/api/me')).status, 401, '拿資料庫裡的雜湊來用不算數');
  const list = (await call(boss.token, '/api/my-ais')).body.items;
  assert.ok(list.length && list.every(x => x.token === undefined), '我的 AI 清單不再帶 Token');
  const re = (await call(boss.token, `/api/my-ais/${ai.participantId}/reissue`, 'POST')).body;
  assert.ok(re.token && re.token !== ai.token, '重發給新的原文');
  assert.equal((await call(ai.token, '/api/me')).status, 401, '重發後舊的失效');
  assert.equal((await call(re.token, '/api/me')).status, 200);
  // 完整接入設定：手上有新 Token 就帶來（不換）；沒帶就換一組
  const keep = (await call(boss.token, `/api/my-ais/${ai.participantId}/onboarding`, 'POST', { token: re.token })).body;
  assert.equal(keep.rotated, false); assert.ok(keep.text.includes(re.token), '設定裡寫的是帶來的 Token');
  assert.equal((await call(boss.token, `/api/my-ais/${ai.participantId}/onboarding`, 'POST', { token: 'nope' })).status, 400, '帶錯的 Token 擋掉');
  const ob = (await call(boss.token, `/api/my-ais/${ai.participantId}/onboarding`)).body;
  assert.equal(ob.rotated, true); assert.ok(ob.text.includes(ob.token), '沒帶就換一組並寫進設定');
  assert.equal((await call(re.token, '/api/me')).status, 401, '換了之後舊的失效');
  let aiTok = ob.token;
  assert.equal((await call(aiTok, '/api/me')).status, 200);
  // 登入碼：讀不到原本的，產生新的
  assert.equal((await call(boss.token, '/api/me/login-code')).status, 410, '讀不到原本的登入碼');
  const code = (await call(boss.token, '/api/me/login-code', 'POST')).body.code;
  assert.ok(code && code !== boss.token);
  assert.equal((await call(boss.token, '/api/me')).status, 401, '產生新的之後舊登入碼失效');
  assert.equal((await call(null, '/api/auth/code', 'POST', { code })).status, 200, '新登入碼可以登入網頁');
  let bossTok = code;
  console.log('✓ 只存雜湊、原文只給一次');

  // ---------- 2. 舊資料（原文） ----------
  const mate = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG', username: 'chen.dw', password: 'longpassword2', passwordAgain: 'longpassword2' })).body;
  const M = mate.participant.participantId;
  await db.run('UPDATE participants SET token = ? WHERE id = ?', 'legacy-plain-code-123', M); // 模擬升級前的資料
  assert.equal((await call('legacy-plain-code-123', '/api/me')).status, 200, '舊的原文 Token 照樣能用');
  assert.equal(await stored(M), hashOf('legacy-plain-code-123'), '用過一次就轉成雜湊');
  assert.equal((await call('legacy-plain-code-123', '/api/me')).status, 200, '轉了之後照樣能用');
  await db.run('UPDATE participants SET token = ? WHERE id = ?', 'legacy-plain-code-456', M);
  app = mk(); // 新的一份程式：第一個請求把舊的全部轉掉
  await call(null, '/api/health');
  assert.equal(await stored(M), hashOf('legacy-plain-code-456'), '啟動後第一個請求就轉成雜湊');
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM participants WHERE token NOT LIKE 'h:%'")).n, 0, '沒有留下原文');
  assert.equal((await call('legacy-plain-code-456', '/api/me')).status, 200, '升級後舊 Token 還能用');
  console.log('✓ 舊 Token 自動轉雜湊、照樣能用');

  // ---------- 3. 停用成員 ----------
  const mdev = (await pwLogin('chen.dw', 'longpassword2')).body.token;
  assert.ok(mdev, '陳大文用帳號密碼登入（裝置）');
  await call(bossTok, `/api/participants/${M}/projects`, 'PUT', { projects: ['預設專案'] });
  const mai = (await call(mdev, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'QA', role: 'QA', name: '測試助手', ...S })).body;
  const mcode = (await call(mdev, '/api/me/login-code', 'POST')).body.code;
  assert.equal((await call(mdev, `/api/participants/${B}/disable`, 'POST')).status, 403, '不是管理員不能停用');
  assert.equal((await call(bossTok, `/api/participants/${B}/disable`, 'POST')).status, 400, '不能停用自己');
  const d = await call(bossTok, `/api/participants/${M}/disable`, 'POST');
  assert.equal(d.status, 200, JSON.stringify(d.body)); assert.equal(d.body.revokedAiTokens, 1);
  assert.equal(d.body.participant.disabled, true, '標已停用');
  assert.equal((await call(mdev, '/api/me')).status, 401, '裝置登出');
  assert.equal((await call(mcode, '/api/me')).status, 401, '登入碼作廢');
  assert.equal((await call(null, '/api/auth/code', 'POST', { code: mcode })).status >= 400, true, '登入碼不能登入網頁');
  assert.equal((await pwLogin('chen.dw', 'longpassword2')).status >= 400, true, '帳號密碼不能登入');
  assert.equal((await call(mai.token, '/api/me')).status, 401, '他的 AI 也不能用');
  assert.ok(!(await call(bossTok, '/api/participants')).body.items.some(p => p.participantId === M), '一般名單不列');
  assert.equal((await call(bossTok, '/api/participants')).body.items.find(p => p.participantId === mai.participantId)?.ownerDisabled, true, '他的 AI 標「主人已停用」');
  assert.deepEqual((await call(bossTok, '/api/participants/disabled')).body.items.map(p => p.name), ['陳大文'], '已停用名單列出來');
  assert.equal((await call(aiTok, '/api/participants/disabled')).status, 403, '只有管理員看得到已停用名單');
  const en = await call(bossTok, `/api/participants/${M}/enable`, 'POST');
  assert.equal(en.status, 200); assert.equal(en.body.participant.disabled, undefined);
  assert.equal((await call(mdev, '/api/me')).status, 401, '恢復後舊裝置照樣登出（要重新登入）');
  const mdev2 = (await pwLogin('chen.dw', 'longpassword2')).body.token;
  assert.equal((await call(mdev2, '/api/me')).status, 200, '恢復後帳號密碼能登入');
  assert.equal((await call(mai.token, '/api/me')).status, 401, 'AI 的舊 Token 不會復活');
  const mai2 = (await call(mdev2, `/api/my-ais/${mai.participantId}/reissue`, 'POST')).body;
  assert.equal((await call(mai2.token, '/api/me')).status, 200, '主人重發後 AI 能用');
  console.log('✓ 停用：所有登入方式失效；恢復後重新登入、AI 重發');

  // ---------- 4. 管理員明確標記 ----------
  const adminName = async tok => (await call(tok, '/api/projects')).body;
  assert.equal(Number((await db.get('SELECT is_admin FROM participants WHERE id = ?', B)).is_admin), 1, '第一位是管理員');
  assert.equal((await call(mdev2, '/api/admin/transfer', 'POST', { toId: M })).status, 403, '不是管理員不能交');
  assert.equal((await call(bossTok, '/api/admin/transfer', 'POST', { toId: ai.participantId })).status, 404, '不能交給 AI');
  const tr = await call(bossTok, '/api/admin/transfer', 'POST', { toId: M });
  assert.equal(tr.status, 200); assert.equal(tr.body.adminName, '陳大文');
  assert.equal((await call(bossTok, `/api/participants/${M}/disable`, 'POST')).status, 403, '交出去後原本的管理員不能再管');
  assert.equal((await call(mdev2, '/api/participants/disabled')).status, 200, '新的管理員可以');
  assert.equal((await call(mdev2, `/api/participants/${M}/disable`, 'POST')).status, 400, '管理員不能停用自己');
  // 最早加入的人換了也不影響
  await db.run("UPDATE participants SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", B);
  app = mk();
  assert.equal((await call(mdev2, '/api/participants/disabled')).status, 200, '不再看誰最早加入');
  assert.equal((await call(bossTok, '/api/participants/disabled')).status, 403);
  void adminName;
  console.log('✓ 管理員是明確標記、可以交給別人');

  // 舊資料庫升級：001 把原本的管理員（最早加入的人類）標起來
  {
    const OLD = fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8').replace(/\n\s*is_admin INTEGER[^\n]*/, '');
    assert.ok(!OLD.includes('is_admin'), '1.0 的結構沒有 is_admin');
    const odb = new DatabaseSync(path.join(dataDir, 'old.db'));
    odb.exec(OLD);
    const ins = odb.prepare("INSERT INTO participants (id, kind, name, code, token, created_at, updated_at) VALUES (?, 'human', ?, ?, ?, ?, ?)");
    ins.run('p_late', '後來的人', 'AAA2', 'tok-late', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');
    ins.run('p_first', '最早的人', 'AAA1', 'tok-first', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    const r = migrateNode(odb, { schema: fs.readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8'), dir: fileURLToPath(new URL('../migrations/', import.meta.url)) });
    assert.ok(r.applied.includes('001_admin_flag.sql'), JSON.stringify(r));
    assert.deepEqual(odb.prepare('SELECT id FROM participants WHERE is_admin = 1').all().map(x => x.id), ['p_first'], '升級後原本的管理員有標記');
    odb.close();
  }
  console.log('✓ 舊資料庫升級標出管理員');
  console.log('member-admin-test：全部通過');
} catch (e) {
  console.error('member-admin-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
}
