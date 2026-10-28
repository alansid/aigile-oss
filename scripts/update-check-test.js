// 驗收測試：管理頁「有新版本」（測試不連 GitHub：用假的 fetch）
// 1. GitHub 最新 release 比目前新：回 newer（版本、版本說明連結）；一樣或比較舊、草稿、預先發行版都不算
// 2. 一天最多查一次，結果快取在資料庫；過一天才再查
// 3. 查不到（網路錯、GitHub 回錯誤）：不顯示新版本、不報錯，回 failed 讓畫面寫「查不到」（不是「已經是最新版」），一天內不重查
// 4. UPDATE_CHECK=0 關掉：不查；只有管理員能看
// 用法：node scripts/update-check-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { APP_VERSION, cmpVersion } from '../src/version.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-upd-'));
let calls = 0, reply = null;
const fakeFetch = async (url, opts) => {
  calls++;
  assert.equal(url, 'https://api.github.com/repos/alansid/aigile-oss/releases/latest');
  assert.ok(opts.headers['User-Agent'], 'GitHub 要 User-Agent');
  if (reply instanceof Error) throw reply;
  return new Response(JSON.stringify(reply.body), { status: reply.status || 200 });
};
const site = (name, config = {}) => {
  const db = openNodeDb(path.join(dataDir, name + '.db'), { legacyProjects: false });
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000', updateFetch: fakeFetch, ...config } });
  const call = async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { db, call };
};
const [ma, mi, pa] = APP_VERSION.split('.').map(Number);
const newer = `${ma}.${mi + 1}.${pa}`, older = `${ma}.${mi}.${Math.max(0, pa - 1)}`;
const release = (tag, extra = {}) => ({ body: { tag_name: tag, name: '新版說明', html_url: `https://github.com/alansid/aigile-oss/releases/tag/${tag}`, draft: false, prerelease: false, ...extra } });

try {
  assert.ok(cmpVersion('1.10.0', '1.9.9') > 0 && cmpVersion('v1.0.0', '1.0.0') === 0 && cmpVersion('1.0.0', '1.0.1') < 0, '版本比較');
  const A = site('a');
  const boss = (await A.call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body;
  const chen = (await A.call(null, '/api/join', 'POST', { name: '陳大文', role: 'PG' })).body;
  const check = tok => A.call(tok, '/api/admin/update-check');
  const age = ms => A.db.run("UPDATE app_settings SET value = json_set(value, '$.at', ?) WHERE key = 'update_check'", Date.now() - ms);

  // 4. 只有管理員
  assert.equal((await check(chen.token)).status, 403, '非管理員不能看');
  assert.equal(calls, 0, '非管理員不會觸發查詢');

  // 1. 有新版
  reply = release('v' + newer);
  let r = (await check(boss.token)).body;
  assert.equal(r.enabled, true);
  assert.equal(r.current, APP_VERSION);
  assert.equal(r.newer?.version, newer, '有新版本');
  assert.equal(r.failed, undefined, '查得到就沒有 failed');
  assert.equal(r.newer.url, `https://github.com/alansid/aigile-oss/releases/tag/v${newer}`, '版本說明連結');
  assert.equal(calls, 1);
  // 2. 一天內不重查
  r = (await check(boss.token)).body;
  assert.equal(r.newer?.version, newer);
  assert.equal(calls, 1, '一天內只查一次');
  // 過一天才再查：這次是一樣的版本 → 不顯示
  await age(25 * 3600_000);
  reply = release('v' + APP_VERSION);
  r = (await check(boss.token)).body;
  assert.equal(calls, 2, '過一天再查');
  assert.equal(r.newer, undefined, '一樣的版本不算新');
  for (const [rel, why] of [[release(older), '比較舊'], [release('v' + newer, { draft: true }), '草稿'], [release('v' + newer, { prerelease: true }), '預先發行版'], [release('nightly'), '看不懂的版本號']]) {
    await age(25 * 3600_000); reply = rel;
    assert.equal((await check(boss.token)).body.newer, undefined, why + '不算');
  }
  // 連結不是 GitHub 的，改成 releases 頁
  await age(25 * 3600_000); reply = release('v' + newer, { html_url: 'https://evil.example/x' });
  assert.equal((await check(boss.token)).body.newer.url, 'https://github.com/alansid/aigile-oss/releases', '只連到 GitHub');

  // 3. 查不到：不顯示、不報錯；一天內不重查
  await age(25 * 3600_000); reply = new Error('網路斷了');
  const before = calls;
  r = await check(boss.token);
  assert.equal(r.status, 200, '查不到不報錯');
  assert.equal(r.body.newer, undefined, '查不到不顯示');
  assert.equal(r.body.failed, true, '查不到要說查不到（不能當成已經是最新版）');
  await check(boss.token);
  assert.equal(calls, before + 1, '查不到也一天內不重查');
  await age(25 * 3600_000); reply = { status: 403, body: { message: 'rate limit' } };
  const r404 = (await check(boss.token)).body;
  assert.equal(r404.newer, undefined, 'GitHub 回錯誤也不顯示');
  assert.equal(r404.failed, true, 'GitHub 回 404（還沒有這個 repo）也是查不到');

  // 4. UPDATE_CHECK=0
  const B = site('b', { updateCheck: '0' });
  const bb = (await B.call(null, '/api/join', 'POST', { name: '管理者', role: 'PO' })).body;
  const n0 = calls;
  r = (await B.call(bb.token, '/api/admin/update-check')).body;
  assert.equal(r.enabled, false, 'UPDATE_CHECK=0 關掉');
  assert.equal(calls, n0, '關掉就不查');
  console.log('update-check-test：全部通過');
} catch (e) {
  console.error('update-check-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
}
