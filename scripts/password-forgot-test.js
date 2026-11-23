// 已登入但忘了目前密碼：設定裡不填舊密碼就能設新的（POST /api/me/password/forgot）
// - 只給人類「裝置登入」：AI Token、直接拿登入碼呼叫的都擋；還沒設過帳號密碼的要走一般設定
// - 新密碼照一般規則（兩次一致、至少 8 碼）；每人每小時最多 3 次
// - 成功後：新密碼能登入、舊的不行；其他裝置全部登出（這台留著）、舊登入碼失效；留一筆 password_reset 安全通知
// - 原本「填目前密碼」的流程不受影響
// 修正前：忘了目前密碼只能請管理員重設登入（管理員自己忘了要用主機救援指令）
// 本機記憶體資料庫，不連正式站。用法：node scripts/password-forgot-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js'; // 資料庫只存雜湊：換一組已知的 Token

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-pwforgot-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', authFailLimit: '500' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const PW = 'correct horse 1', PW2 = 'battery staple 2', PW3 = 'third pass 333';
const forgot = (tok, a, b = a) => call(tok, '/api/me/password/forgot', 'POST', { newPassword: a, newPasswordAgain: b });
const login = (username, password) => call(null, '/api/auth/password', 'POST', { username, password });

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const code = liu.token; // 登入碼（不是裝置）
  const devA = (await call(null, '/api/auth/code', 'POST', { code })).body.token;
  assert.ok(devA, '用登入碼換到裝置 A');
  // 還沒設過帳號密碼：不能走忘記密碼
  let r = await forgot(devA, PW);
  assert.equal(r.status, 400, '還沒設過帳號密碼要走一般設定：' + JSON.stringify(r.body));
  assert.equal((await call(devA, '/api/me/password', 'PUT', { username: 'yuchih', newPassword: PW, newPasswordAgain: PW })).status, 200, '第一次設定');
  const devB = (await login('yuchih', PW)).body.token, devC = (await login('yuchih', PW)).body.token;
  assert.ok(devB && devC, '另外兩台用帳號密碼登入');
  const code2 = await testToken(db, liu.participant.participantId); // 他的登入碼

  // 擋：AI Token、直接用登入碼呼叫
  const ai = (await call(devA, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const aiTok = await testToken(db, ai.participantId);
  assert.equal((await forgot(aiTok, PW2)).status, 403, 'AI Token 被擋');
  r = await forgot(code2, PW2);
  assert.equal(r.status, 403, '直接用登入碼呼叫被擋'); assert.equal(r.body.error.code, 'DEVICE_REQUIRED');
  // 新密碼照一般規則
  assert.equal((await forgot(devA, PW2, PW2 + 'x')).status, 400, '兩次不一致');
  assert.equal((await forgot(devA, 'short')).status, 400, '太短');

  // 成功：不填舊密碼
  const msgs0 = (await db.get('SELECT COUNT(*) AS n FROM messages')).n;
  r = await forgot(devA, PW2);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.loggedOut >= 2 && r.body.username === 'yuchih', '其他裝置登出、帳號不變：' + JSON.stringify(r.body));
  assert.equal((await call(devA, '/api/me')).status, 200, '這台留著');
  assert.equal((await call(devB, '/api/me')).status, 401, '裝置 B 登出');
  assert.equal((await call(devC, '/api/me')).status, 401, '裝置 C 登出');
  assert.equal((await call(code2, '/api/me')).status, 401, '舊登入碼失效');
  assert.notEqual((await login('yuchih', PW)).status, 200, '舊密碼不能登入');
  assert.equal((await login('yuchih', PW2)).status, 200, '新密碼可以登入');
  const nts = (await call(devA, '/api/me/notices')).body.items;
  assert.ok(nts.some(n => n.kind === 'password_reset'), '留下安全通知：' + JSON.stringify(nts));
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM messages')).n, msgs0, '不發群組訊息');

  // 原本「填目前密碼」的流程照舊
  assert.equal((await call(devA, '/api/me/password', 'PUT', { username: 'yuchih', currentPassword: 'wrong pass 0', newPassword: PW3, newPasswordAgain: PW3 })).body.error.code, 'WRONG_PASSWORD', '舊流程：目前密碼錯照樣擋');
  assert.equal((await call(devA, '/api/me/password', 'PUT', { username: 'yuchih', currentPassword: PW2, newPassword: PW3, newPasswordAgain: PW3 })).status, 200, '舊流程：填對目前密碼可以改');

  // 每小時最多 3 次（上面成功 1 次，再 2 次可以，第 4 次擋）
  assert.equal((await forgot(devA, PW)).status, 200, '第 2 次');
  assert.equal((await forgot(devA, PW2)).status, 200, '第 3 次');
  r = await forgot(devA, PW3);
  assert.equal(r.status, 429, '第 4 次擋'); assert.equal(r.body.error.code, 'TOO_MANY_RESETS');
  assert.equal((await login('yuchih', PW2)).status, 200, '被擋那次沒有改到密碼');
  // 一小時後可以再來
  await db.run("UPDATE login_fails SET last_at = last_at - 3600001 WHERE username LIKE '#forgot:%'");
  assert.equal((await forgot(devA, PW3)).status, 200, '過了一小時可以再設');
  console.log('password-forgot-test：全部通過');
} catch (e) {
  console.error('password-forgot-test 失敗：', e.message, (e.stack || '').split('\n').slice(1, 3).join(' | '));
  process.exitCode = 1;
} finally {
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
