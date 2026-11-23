// 安全標頭單元測試（src/security-headers.js 與 public/_headers、API 回應標頭）
// 用法：node scripts/security-headers-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CSP, PAGE_HEADERS, API_HEADERS } from '../src/security-headers.js';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

// 1. 基本匯出型別與鍵值結構
assert.equal(typeof CSP, 'string', 'CSP 應為字串');
assert.ok(CSP.length > 0, 'CSP 不可為空字串');
assert.equal(typeof PAGE_HEADERS, 'object');
assert.notEqual(PAGE_HEADERS, null);
assert.equal(typeof API_HEADERS, 'object');
assert.notEqual(API_HEADERS, null);

assert.deepEqual(
  Object.keys(PAGE_HEADERS).sort(),
  ['Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'X-Frame-Options'],
  'PAGE_HEADERS 應只包含預期的四個安全標頭',
);

assert.deepEqual(
  Object.keys(API_HEADERS).sort(),
  ['Referrer-Policy', 'X-Content-Type-Options'],
  'API_HEADERS 應只包含 X-Content-Type-Options 與 Referrer-Policy',
);

// 確認 security-headers.js 本身不額外注入未定義的 HSTS / Permissions-Policy / Cache-Control
for (const unexpected of ['Strict-Transport-Security', 'Permissions-Policy', 'Cache-Control']) {
  assert.equal(Object.hasOwn(PAGE_HEADERS, unexpected), false, `PAGE_HEADERS 不應包含 ${unexpected}`);
  assert.equal(Object.hasOwn(API_HEADERS, unexpected), false, `API_HEADERS 不應包含 ${unexpected}`);
}

// 2. CSP 指令解析與嚴格性驗證
const directives = CSP.split('; ');
assert.equal(directives.length, 11, 'CSP 應包含 11 個指令');
assert.equal(CSP.endsWith(';'), false, 'CSP 結尾不應有多餘分號');

const directiveMap = new Map();
for (const entry of directives) {
  const trimmed = entry.trim();
  assert.equal(entry, trimmed, `CSP 指令不應有多餘空白：${entry}`);
  const spaceIdx = entry.indexOf(' ');
  assert.ok(spaceIdx > 0, `CSP 指令應包含名稱與值：${entry}`);
  const name = entry.slice(0, spaceIdx);
  const value = entry.slice(spaceIdx + 1);
  assert.equal(directiveMap.has(name), false, `CSP 指令不可重複：${name}`);
  directiveMap.set(name, value);
}

const expectedDirectives = {
  'default-src': "'self'",
  'script-src': "'self' https://cdnjs.cloudflare.com https://challenges.cloudflare.com",
  'style-src': "'self' 'unsafe-inline'",
  'img-src': "'self' data: blob:",
  'connect-src': "'self'",
  'frame-src': 'https://challenges.cloudflare.com',
  'font-src': "'self' data:",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'self'",
  'frame-ancestors': "'none'",
};

for (const [name, expectedValue] of Object.entries(expectedDirectives)) {
  assert.equal(directiveMap.get(name), expectedValue, `CSP 指令 ${name} 不符預期`);
}

// 腳本來源不可放寬為 unsafe-inline / unsafe-eval / 萬用字元 / 明文 http
const scriptSrc = directiveMap.get('script-src');
for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", '*', 'http://']) {
  assert.equal(scriptSrc.includes(forbidden), false, `script-src 不可包含 ${forbidden}`);
}

// 3. PAGE_HEADERS 與 API_HEADERS 值檢查
assert.equal(PAGE_HEADERS['Content-Security-Policy'], CSP);
assert.equal(PAGE_HEADERS['X-Content-Type-Options'], 'nosniff');
assert.equal(PAGE_HEADERS['X-Frame-Options'], 'DENY');
assert.equal(PAGE_HEADERS['Referrer-Policy'], 'no-referrer');

assert.equal(API_HEADERS['X-Content-Type-Options'], 'nosniff');
assert.equal(API_HEADERS['Referrer-Policy'], 'no-referrer');
assert.equal(API_HEADERS['X-Content-Type-Options'], PAGE_HEADERS['X-Content-Type-Options']);
assert.equal(API_HEADERS['Referrer-Policy'], PAGE_HEADERS['Referrer-Policy']);

// 4. public/_headers 與 PAGE_HEADERS 的共通標頭一致
{
  const headersFile = fs.readFileSync(path.join(ROOT_DIR, 'public', '_headers'), 'utf8');
  for (const key of ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy']) {
    const expectedLine = `${key}: ${PAGE_HEADERS[key]}`;
    assert.ok(headersFile.includes(expectedLine), `public/_headers 應包含「${expectedLine}」`);
  }
}

// 5. 整合驗證：core.js 的 API 回應帶有 API_HEADERS 與 Cache-Control: no-store
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-sec-headers-'));
  let db;
  try {
    db = await openTestDb(path.join(tmpDir, 'switch.db'), { legacyProjects: false });
    const app = createApp({
      db,
      storage: dbStorage(db),
      docText: '',
      config: { openJoin: '1', rateLimitPerMin: '100000', teamCacheMs: '0' },
    });
    const healthRes = await app(new Request('http://localhost/api/health'), 'http://localhost');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthRes.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(healthRes.headers.get('cache-control'), 'no-store');

    const notFoundRes = await app(new Request('http://localhost/api/nonexistent-route'), 'http://localhost');
    assert.equal(notFoundRes.status, 404);
    assert.equal(notFoundRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(notFoundRes.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(notFoundRes.headers.get('cache-control'), 'no-store');
  } finally {
    await db?.close?.();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log('security-headers-test: all assertions passed');
