// 預設管理員：新站自動建「管理員」（帳號 admin、密碼 ADMIN_PASSWORD，沒設＝admin），第一次登入要先改帳號與密碼
// 測：沒設／有設 ADMIN_PASSWORD、改之前其他功能被擋、帳號和密碼都改才解除、改完能用、重啟不重建、同時兩個請求只建一位、
//     之後自己註冊的人是一般成員且沒有專案、預設密碼不出現在任何 API 回應與日誌、測試模式（不開）照舊第一位註冊＝管理員
// 用法：node scripts/default-admin-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-defadmin-'));
// 記下所有 API 回應與日誌，最後檢查預設密碼沒有出現
const seen = [];
const origLog = console.log, origErr = console.error;
console.log = (...a) => { seen.push(a.join(' ')); origLog(...a); };
console.error = (...a) => { seen.push(a.join(' ')); origErr(...a); };
const mk = (file, config, opts = { legacyProjects: false }) => {
  const db = openNodeDb(path.join(dataDir, file), opts);
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { rateLimitPerMin: '100000', teamCacheMs: '0', ...config } });
  const call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    const text = await r.text(); seen.push(text);
    let json = {}; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json };
  };
  return { db, call };
};
const login = (call, username, password) => call(null, '/api/auth/password', 'POST', { username, password });

try {
  // 1. 沒設 ADMIN_PASSWORD：admin／admin
  const A = mk('a.db', { defaultAdmin: '1' });
  assert.equal((await A.call(null, '/api/health')).status, 200, '第一個請求');
  let r = await login(A.call, 'admin', 'admin');
  assert.equal(r.status, 200, '用 admin／admin 登入：' + JSON.stringify(r.body));
  const tok = r.body.token;
  const me = (await A.call(tok, '/api/me')).body;
  assert.equal(me.mustChangeCredentials, true, '/api/me 標出還在用預設帳密');
  assert.ok(me.projects.includes((await A.db.get('SELECT id FROM projects LIMIT 1')).id), '預設管理員在所有專案');
  // 改之前：其他功能都被擋
  for (const [m, p] of [['GET', '/api/participants'], ['GET', '/api/messages?limit=5'], ['GET', '/api/projects'], ['POST', '/api/invites']]) {
    const x = await A.call(tok, p, m, m === 'POST' ? { name: 'x' } : undefined);
    assert.equal(x.body.error?.code, 'MUST_CHANGE_CREDENTIALS', `${m} ${p} 改之前被擋`);
  }
  // 只改一樣不行：帳號還是 admin、或沒給新密碼
  assert.equal((await A.call(tok, '/api/me/password', 'PUT', { username: 'admin', currentPassword: 'admin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' })).status, 400, '帳號還是 admin 不行');
  assert.equal((await A.call(tok, '/api/me/password', 'PUT', { username: 'boss.lin', currentPassword: 'admin' })).status, 400, '沒改密碼不行');
  assert.equal((await A.call(tok, '/api/me/password', 'PUT', { username: 'boss.lin', currentPassword: 'admin', newPassword: 'short', newPasswordAgain: 'short' })).status, 400, '新密碼照規則至少 8 碼');
  r = await A.call(tok, '/api/me/password', 'PUT', { username: 'boss.lin', currentPassword: 'admin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' });
  assert.equal(r.status, 200, '帳號和密碼都改：' + JSON.stringify(r.body));
  assert.ok(!(await A.call(tok, '/api/me')).body.mustChangeCredentials, '改完就不再標');
  assert.equal((await A.call(tok, '/api/participants')).status, 200, '改完其他功能能用');
  assert.equal((await login(A.call, 'admin', 'admin')).status, 400, '舊的 admin／admin 不能再登入');
  assert.equal((await login(A.call, 'boss.lin', 'longpassword1')).status, 200, '新帳密登入得了');

  // 2. 之後自己註冊的人：一般成員、沒有專案；管理員還是預設那位
  r = await A.call(null, '/api/join', 'POST', { name: '王小明', role: 'UX' });
  assert.equal(r.status, 201, '開放註冊：' + JSON.stringify(r.body));
  const mate = r.body;
  assert.deepEqual((await A.call(mate.token, '/api/me')).body.projects, [], '自己註冊的人沒有專案');
  assert.ok(!(await A.call(mate.token, '/api/me')).body.mustChangeCredentials, '一般成員不用改帳密');
  assert.equal((await A.call(mate.token, '/api/invites', 'POST', { name: 'x', projects: [] })).status, 403, '一般成員不是管理員（不能發邀請）');

  // 3. 重啟（同一個資料庫再開一次）不重建
  const A2 = mk('a.db', { defaultAdmin: '1' });
  await A2.call(null, '/api/health');
  assert.equal((await A2.db.get("SELECT COUNT(*) AS n FROM credentials WHERE username = 'admin'")).n, 0, '重啟不重建 admin');
  assert.equal((await A2.db.get("SELECT COUNT(*) AS n FROM participants WHERE kind = 'human'")).n, 2, '人數不變');

  // 4. 有設 ADMIN_PASSWORD：admin／admin 不行，要用設的密碼
  const SECRET = 'S3cret-only-in-env-77';
  const B = mk('b.db', { defaultAdmin: '1', adminPassword: SECRET });
  await B.call(null, '/api/health');
  assert.equal((await login(B.call, 'admin', 'admin')).status, 400, '設了 ADMIN_PASSWORD 就不能用 admin');
  r = await login(B.call, 'admin', SECRET);
  assert.equal(r.status, 200, '用 ADMIN_PASSWORD 登入');
  assert.equal((await B.call(r.body.token, '/api/me')).body.mustChangeCredentials, true, '一樣要先改');

  // 5. 兩份程式同時收到第一個請求：只建一位
  const file = path.join(dataDir, 'race.db');
  const C1 = mk('race.db', { defaultAdmin: '1' }), C2 = mk('race.db', { defaultAdmin: '1' });
  await Promise.all([C1.call(null, '/api/health'), C2.call(null, '/api/health')]);
  assert.equal((await C1.db.get("SELECT COUNT(*) AS n FROM participants WHERE kind = 'human'")).n, 1, '只建一位管理員：' + file);

  // 6. 已經有人類的站不建
  const D = mk('d.db', { openJoin: '1' });
  await D.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' });
  const D2 = mk('d.db', { defaultAdmin: '1' });
  await D2.call(null, '/api/health');
  assert.equal((await D2.db.get("SELECT COUNT(*) AS n FROM credentials WHERE username = 'admin'")).n, 0, '舊站不建 admin');

  // 7. 測試模式（defaultAdmin 沒開）：照舊第一位註冊＝管理員、在所有專案
  const E = mk('e.db', {}, {});
  const first = (await E.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  assert.ok((await E.call(first.token, '/api/me')).body.projects.length > 0, '沒開預設管理員：第一位註冊就是管理員');

  // 8. 預設密碼沒出現在任何 API 回應與日誌
  assert.ok(!seen.some(t => t.includes(SECRET)), 'ADMIN_PASSWORD 沒出現在回應或日誌');
  assert.ok(!seen.some(t => /"password"\s*:\s*"admin"|密碼[：:是]\s*admin\b/.test(t)), '預設密碼 admin 沒出現在回應或日誌');
  console.log = origLog; console.error = origErr;
  console.log('default-admin-test：全部通過');
} catch (e) {
  console.log = origLog; console.error = origErr;
  console.error('default-admin-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
