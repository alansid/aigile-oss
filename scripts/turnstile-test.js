// Cloudflare Turnstile 人機驗證（不連 Cloudflare：驗證網址指到本機假驗證器）
// 兩個 key 都設才啟用；自己註冊一律要驗證；登入同一 IP 失敗 3 次後要驗證；伺服器端驗證 token，失敗回清楚錯誤；secret 不外露
// 用法：node scripts/turnstile-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const SECRET = 'ts-secret-for-test-8841';
// 假驗證器：token 以 ok- 開頭才算過；記下收到的 secret 與 remoteip
const got = [];
const fake = http.createServer((req, res) => {
  let s = ''; req.on('data', d => s += d).on('end', () => {
    const f = new URLSearchParams(s); got.push(Object.fromEntries(f));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: f.get('secret') === SECRET && /^ok-/.test(f.get('response') || '') }));
  });
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const VERIFY = `http://127.0.0.1:${fake.address().port}/siteverify`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-turnstile-'));
const seen = [];
const mk = (file, config) => {
  const db = openNodeDb(path.join(dataDir, file), {});
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { rateLimitPerMin: '100000', teamCacheMs: '0', authFailLimit: '1000', ...config } });
  return async (token, p, method = 'GET', body, ip = '203.0.113.5') => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    const text = await r.text(); seen.push(text);
    let json = {}; try { json = JSON.parse(text); } catch {}
    return { status: r.status, body: json };
  };
};
const TS = { turnstileSiteKey: '0x4AAAA-site-key', turnstileSecret: SECRET, turnstileVerifyUrl: VERIFY };
try {
  // 沒設 key：照舊，不要驗證
  const off = mk('off.db', {});
  assert.equal((await off(null, '/api/health')).body.turnstileSiteKey, undefined, '沒設就不回 site key');
  assert.equal((await off(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).status, 201, '沒設照舊註冊');
  // 只設一個也不啟用
  const half = mk('half.db', { turnstileSiteKey: 'x', turnstileVerifyUrl: VERIFY });
  assert.equal((await half(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).status, 201, '只設一個不啟用');
  assert.equal(got.length, 0, '沒啟用時不呼叫驗證器');

  const call = mk('on.db', TS);
  const h = (await call(null, '/api/health')).body;
  assert.equal(h.turnstileSiteKey, '0x4AAAA-site-key'); assert.equal(h.captchaAfterFails, 3);

  // 自己註冊：沒 token、token 錯、token 對
  const j1 = await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' });
  assert.equal(j1.status, 403); assert.equal(j1.body.error.code, 'CAPTCHA_REQUIRED'); assert.equal(j1.body.error.captchaRequired, true);
  const j2 = await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO', turnstileToken: 'bad' });
  assert.equal(j2.body.error.code, 'CAPTCHA_FAILED'); assert.match(j2.body.error.message, /人機驗證/);
  const boss = await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO', turnstileToken: 'ok-1' });
  assert.equal(boss.status, 201, '驗證通過才註冊');
  assert.equal(got.at(-1).secret, SECRET, '伺服器帶 secret 去驗證'); assert.equal(got.at(-1).remoteip, '203.0.113.5', '帶使用者 IP');

  // 群組密碼：先驗人機，才比對群組密碼（沒過驗證就不告訴你密碼對不對）
  await call(boss.body.token, '/api/group/settings', 'PUT', { roomCode: 'room-1234' });
  assert.equal((await call(null, '/api/join', 'POST', { name: '陳大文', role: 'QA', roomCode: 'wrong' })).body.error.code, 'CAPTCHA_REQUIRED');
  assert.equal((await call(null, '/api/join', 'POST', { name: '陳大文', role: 'QA', roomCode: 'wrong', turnstileToken: 'ok-2' })).body.error.message, '群組密碼錯誤');
  assert.equal((await call(null, '/api/join', 'POST', { name: '陳大文', role: 'QA', roomCode: 'room-1234', turnstileToken: 'ok-3' })).status, 201);

  // 登入：前 2 次失敗不用驗證；第 3 次失敗後回 captchaRequired；之後沒 token 擋、token 對才比對帳密
  await call(boss.body.token, '/api/me/password', 'PUT', { username: 'boss.lin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' });
  const ip = '198.51.100.9';
  for (let i = 1; i <= 3; i++) {
    const r = await call(null, '/api/auth/password', 'POST', { username: 'boss.lin', password: 'nope' + i }, ip);
    assert.equal(r.body.error.code, 'LOGIN_FAILED');
    assert.equal(!!r.body.error.captchaRequired, i >= 3, `第 ${i} 次失敗${i >= 3 ? '後要驗證' : '還不用'}`);
  }
  const n = got.length;
  const l1 = await call(null, '/api/auth/password', 'POST', { username: 'boss.lin', password: 'longpassword1' }, ip);
  assert.equal(l1.body.error?.code, 'CAPTCHA_REQUIRED', '失敗多次後，密碼對也要先驗證');
  assert.equal((await call(null, '/api/auth/password', 'POST', { username: 'boss.lin', password: 'longpassword1', turnstileToken: 'bad' }, ip)).body.error.code, 'CAPTCHA_FAILED');
  assert.equal((await call(null, '/api/auth/password', 'POST', { username: 'boss.lin', password: 'longpassword1', turnstileToken: 'ok-4' }, ip)).status, 200, '驗證通過＋密碼對就登入');
  assert.ok(got.length > n);
  assert.equal((await call(null, '/api/auth/password', 'POST', { username: 'boss.lin', password: 'longpassword1' }, '192.0.2.77')).status, 200, '別的 IP 不受影響');
  // 配對碼、登入碼一樣算
  assert.equal((await call(null, '/api/auth/code', 'POST', { code: 'nope' }, ip)).body.error.captchaRequired, true, '登入碼失敗也要驗證');

  // 驗證器連不上：503 清楚錯誤
  const down = mk('down.db', { ...TS, turnstileVerifyUrl: 'http://127.0.0.1:1/siteverify' });
  const d1 = await down(null, '/api/join', 'POST', { name: '林志明', role: 'PO', turnstileToken: 'ok-5' });
  assert.equal(d1.status, 503); assert.equal(d1.body.error.code, 'CAPTCHA_UNAVAILABLE');

  assert.ok(!seen.some(t => t.includes(SECRET)), 'secret 沒出現在任何 API 回應');
  console.log('turnstile-test：全部通過');
} catch (e) {
  console.error('turnstile-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  fake.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
