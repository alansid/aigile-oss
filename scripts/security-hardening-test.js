// 公開部署前的安全加固（在程式內呼叫＋真的啟動 server.js）
// A. 登入：同時送很多次只驗前 5 次；沒有「全站封鎖」（別人亂試不會讓所有人登不進來）；每個 IP 的限制照舊
// B. 第一次改帳密沒帶帳號（沿用 admin）也要擋
// C. 自己註冊每個 IP 有次數限制；群組密碼錯太多次要等
// D. API 有安全標頭；MCP 送 null、壞的 % 編碼、/api/auth/constructor 都不是 500
// E. server.js：Host 不合法不會當掉；沒設 TRUST_PROXY 時 X-Forwarded-For 不算數；請求太大回 413；網頁有 CSP；APP_URL 用在連結
// 用法：node scripts/security-hardening-test.js
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { startKit } from './browser-kit.js';
import { testToken } from './test-token.js';

const dirs = [];
function mk(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-harden-')); dirs.push(dir);
  const db = openNodeDb(path.join(dir, 'switch.db'), { legacyProjects: false });
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0', ...config } });
  const call = async (token, p, method = 'GET', body, ip = '198.51.100.1', raw) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) }), 'http://localhost');
    return { status: r.status, headers: r.headers, body: await r.json().catch(() => ({})) };
  };
  return { db, call };
}
const kits = [];
try {
  // ---------- A. 登入 ----------
  {
    const { call } = mk({ authFailLimit: '10' });
    const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO', username: 'boss.lin', password: 'longpassword1', passwordAgain: 'longpassword1' }, '10.0.0.1')).body;
    assert.ok(boss.token);
    // 同時 30 個錯的：只有前 5 個真的拿去驗（400），其他直接 429
    const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => call(null, '/api/auth/password', 'POST', { username: 'boss.lin', password: 'wrong-' + i }, `10.1.0.${i}`)));
    const evaluated = burst.filter(r => r.status === 400).length;
    assert.ok(evaluated <= 5, `同時送也只驗前 5 次（實際 ${evaluated} 次）`);
    assert.ok(burst.some(r => r.status === 429), '超過的直接擋');
    assert.equal((await call(null, '/api/auth/password', 'POST', { username: 'boss.lin', password: 'longpassword1' }, '10.2.0.1')).status, 429, '鎖住期間密碼對也不行');
  }
  {
    const { call } = mk({ authFailLimit: '10' });
    await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO', username: 'boss.lin', password: 'longpassword1', passwordAgain: 'longpassword1' }, '10.0.0.1');
    // 很多個 IP 亂試不存在的帳號 150 次：沒有全站封鎖
    for (let i = 0; i < 150; i++) await call(null, '/api/auth/password', 'POST', { username: 'nobody' + i, password: 'xxxxxxxxx' }, `172.16.${i >> 8}.${i & 255}`);
    assert.equal((await call(null, '/api/auth/password', 'POST', { username: 'boss.lin', password: 'longpassword1' }, '10.9.9.9')).status, 200, '別人亂試不會讓所有人都登不進來');
    // 同一個 IP 錯 10 次：第 11 次 429
    for (let i = 0; i < 10; i++) await call(null, '/api/auth/password', 'POST', { username: 'x' + i, password: 'xxxxxxxxx' }, '10.5.5.5');
    assert.equal((await call(null, '/api/auth/password', 'POST', { username: 'boss.lin', password: 'longpassword1' }, '10.5.5.5')).status, 429, '同一個 IP 的限制照舊');
  }
  // ---------- B. 第一次改帳密 ----------
  {
    const { call } = mk({ defaultAdmin: '1' });
    await call(null, '/api/health');
    const t = (await call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' })).body.token;
    const r = await call(t, '/api/me/password', 'PUT', { currentPassword: 'admin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' });
    assert.equal(r.status, 400, '沒帶帳號（沿用 admin）要擋');
    assert.equal((await call(t, '/api/me')).body.mustChangeCredentials, true, '還在改帳密關卡');
  }
  // ---------- C. 註冊與群組密碼次數 ----------
  {
    const { call } = mk({ joinLimitPerHour: '3', roomCode: 'garden-77' });
    for (let i = 0; i < 3; i++) assert.equal((await call(null, '/api/join', 'POST', { name: '人' + i + '號', roomCode: 'garden-77' }, '203.0.113.7')).status, 201);
    const r = await call(null, '/api/join', 'POST', { name: '人9號', roomCode: 'garden-77' }, '203.0.113.7');
    assert.equal(r.status, 429); assert.equal(r.body.error.code, 'TOO_MANY_SIGNUPS');
    assert.equal((await call(null, '/api/join', 'POST', { name: '別處來的', roomCode: 'garden-77' }, '203.0.113.8')).status, 201, '別的 IP 不受影響');
    for (let i = 0; i < 10; i++) assert.equal((await call(null, '/api/join', 'POST', { name: '猜密碼' + i, roomCode: 'guess' + i }, '203.0.113.9')).status, 403);
    assert.equal((await call(null, '/api/join', 'POST', { name: '猜中了', roomCode: 'garden-77' }, '203.0.113.9')).status, 429, '群組密碼錯 10 次後要等');
  }
  // ---------- D. API 標頭與錯誤處理 ----------
  {
    const { call, db } = mk();
    const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
    const h = (await call(boss.token, '/api/me')).headers;
    assert.equal(h.get('x-content-type-options'), 'nosniff'); assert.equal(h.get('referrer-policy'), 'no-referrer');
    const myPj = (await call(boss.token, '/api/me')).body.projects;
    const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: myPj, roleKey: 'PG', role: 'PG', name: '助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
    const aiTok = (await testToken(db, ai.participantId));
    for (const raw of ['null', '[null]', '[1, "x"]']) assert.notEqual((await call(aiTok, '/api/mcp', 'POST', null, undefined, raw)).status, 500, 'MCP 送 ' + raw + ' 不是 500');
    assert.equal((await call(boss.token, '/api/cards/%E0%A4%A')).status, 400, '壞的 % 編碼回 400');
    for (const m of ['constructor', 'toString', '__proto__']) assert.equal((await call(null, '/api/auth/' + m, 'POST', {})).status, 404, `/api/auth/${m} 回 404`);
  }
  // ---------- E. 真的啟動 server.js ----------
  {
    const kit = await startKit('harden', { env: { AUTH_FAIL_LIMIT: '3', MAX_BODY_MB: '1', APP_URL: 'https://team.example.com' } }); kits.push(kit);
    const port = Number(new URL(kit.BASE).port);
    // Host 不合法：回 400，程式還活著
    const rawRes = await new Promise(res => { const s = net.connect(port, '127.0.0.1', () => s.end('GET /api/health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n')); let d = ''; s.on('data', c => d += c); s.on('end', () => res(d)); s.on('error', () => res('ERR')); });
    assert.match(rawRes, /^HTTP\/1\.1 400/, '壞 Host 回 400：' + rawRes.slice(0, 40));
    assert.equal((await fetch(kit.BASE + '/api/health')).status, 200, '程式沒有當掉');
    // X-Forwarded-For 不算數：換 IP 標頭也一樣被擋
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(kit.BASE + '/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `1.2.3.${i}`, 'CF-Connecting-IP': `5.6.7.${i}` }, body: JSON.stringify({ username: 'nobody' + i, password: 'xxxxxxxxx' }) })).status);
    assert.equal(statuses.at(-1), 429, '偽造 IP 標頭繞不過每個 IP 的限制：' + statuses.join(','));
    // 請求太大
    const big = await fetch(kit.BASE + '/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(1.5 * 1048576) });
    assert.equal(big.status, 413, '超過 MAX_BODY_MB 回 413');
    // 網頁的安全標頭
    const page = await fetch(kit.BASE + '/');
    assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/, '網頁有 CSP');
    assert.match(page.headers.get('content-security-policy') || '', /base-uri 'none'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(kit.BASE + '/app.js')).headers.get('x-content-type-options'), 'nosniff', '靜態檔 nosniff');
    // APP_URL：邀請連結用設定的網址，不看 Host
    const boss = (await kit.call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
    const inv = await fetch(kit.BASE + '/api/invites', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + boss.token, 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'http' }, body: JSON.stringify({ name: '王小明', projects: [] }) }).then(r => r.json());
    assert.match(inv.url, /^https:\/\/team\.example\.com\/invite\//, '邀請連結用 APP_URL：' + inv.url);
  }
  console.log('security-hardening-test：全部通過');
} catch (e) {
  console.error('security-hardening-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  for (const k of kits) await k.stop().catch(() => {});
  for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}
