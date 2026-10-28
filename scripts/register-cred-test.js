// 自己註冊、邀請連結都能設帳號密碼，之後用帳號＋密碼登入；錯誤帶 field，網頁顯示在那一格下面
// 用法：node scripts/register-cred-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-regcred-'));
const db = openNodeDb(path.join(dataDir, 'a.db'), { legacyProjects: false });
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { rateLimitPerMin: '100000', teamCacheMs: '0', authFailLimit: '1000', defaultAdmin: '1' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const join = body => call(null, '/api/join', 'POST', { role: 'QA', ...body });
const loginPwd = (username, password) => call(null, '/api/auth/password', 'POST', { username, password });
try {
  await call(null, '/api/health');
  const boss = (await loginPwd('admin', 'admin')).body.token;
  await call(boss, '/api/me/password', 'PUT', { username: 'boss.lin', currentPassword: 'admin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' });

  // 自己註冊＋帳密 → 之後用帳密登入
  const j = await join({ name: '陳大文', username: 'Chen.DW', password: 'pass-word-1', passwordAgain: 'pass-word-1' });
  assert.equal(j.status, 201, JSON.stringify(j.body)); assert.equal(j.body.username, 'chen.dw', '帳號存小寫');
  const l = await loginPwd('chen.dw', 'pass-word-1');
  assert.equal(l.status, 200, '用帳密登入'); assert.equal(l.body.participant.name, '陳大文');
  assert.equal((await call(l.body.token, '/api/me/password')).body.username, 'chen.dw');

  // 錯誤：帶 field、清楚訊息；失敗不留人（名字還能用）
  const e1 = await join({ name: '王小明', username: 'chen.dw', password: 'pass-word-2', passwordAgain: 'pass-word-2' });
  assert.equal(e1.status, 409); assert.equal(e1.body.error.code, 'USERNAME_TAKEN'); assert.equal(e1.body.error.field, 'username');
  const e2 = await join({ name: '王小明', username: 'wang.xm', password: 'short', passwordAgain: 'short' });
  assert.equal(e2.body.error.field, 'password'); assert.match(e2.body.error.message, /至少 8 碼/);
  const e3 = await join({ name: '王小明', username: 'wang.xm', password: 'pass-word-2', passwordAgain: 'pass-word-3' });
  assert.equal(e3.body.error.field, 'passwordAgain'); assert.match(e3.body.error.message, /不一樣/);
  const e4 = await join({ name: '王小明', username: 'ab', password: 'pass-word-2', passwordAgain: 'pass-word-2' });
  assert.equal(e4.body.error.field, 'username'); assert.match(e4.body.error.message, /4～30/);
  const e5 = await join({ name: '王小明', username: 'admin', password: 'pass-word-2', passwordAgain: 'pass-word-2' });
  assert.equal(e5.body.error.field, 'username'); assert.match(e5.body.error.message, /保留/);
  const ok2 = await join({ name: '王小明', username: 'wang.xm', password: 'pass-word-2', passwordAgain: 'pass-word-2' });
  assert.equal(ok2.status, 201, '前面失敗沒有留下人，名字還能用');

  // 邀請連結＋帳密 → 用帳密登入
  const inv = await call(boss, '/api/invites', 'POST', { name: '張美玲', projects: [] });
  const tok = inv.body.url.split('/invite/')[1];
  const bad = await call(null, '/api/auth/invite', 'POST', { token: tok, name: '張美玲', username: 'chen.dw', password: 'pass-word-4', passwordAgain: 'pass-word-4' });
  assert.equal(bad.body.error.field, 'username', '邀請：帳號重複帶 field');
  const acc = await call(null, '/api/auth/invite', 'POST', { token: tok, name: '張美玲', username: 'mei.ling', password: 'pass-word-4', passwordAgain: 'pass-word-4' });
  assert.equal(acc.status, 200, '帳號錯了邀請還能用：' + JSON.stringify(acc.body));
  assert.equal((await loginPwd('mei.ling', 'pass-word-4')).status, 200, '邀請進來的人用帳密登入');
  // API 不帶帳密照舊（AI 工具、舊腳本）
  assert.equal((await join({ name: '李志豪' })).status, 201, '不帶帳密照舊');
  console.log('register-cred-test：全部通過');
} catch (e) {
  console.error('register-cred-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
