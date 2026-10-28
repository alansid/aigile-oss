// 網址英文名選填：留空自動產生；填了不合規則回 400 INVALID_SLUG＋建議值；撞號回 409 SLUG_TAKEN＋建議值；新增專案同一套規則
// 新站（預設管理員）的預設專案還沒設網址英文名時，/api/projects 的 slug 是專案 id（有底線），網頁不能拿它當預設值
// 用法：node scripts/slug-optional-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-slug-'));
const db = openNodeDb(path.join(dataDir, 'a.db'), { legacyProjects: false });
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { rateLimitPerMin: '100000', teamCacheMs: '0', defaultAdmin: '1' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
try {
  await call(null, '/api/health');
  const tok = (await call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' })).body.token;
  await call(tok, '/api/me/password', 'PUT', { username: 'boss.lin', currentPassword: 'admin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' });
  const projects = async () => (await call(tok, '/api/projects')).body.items;
  const pj = (await projects())[0];
  assert.equal(pj.slug, pj.id, '還沒設：slug 回專案 id（網頁要當成沒設）');
  const slugOf = async id => (await projects()).find(p => p.id === id).slug;
  const put = (id, slug) => call(tok, `/api/projects/${id}/slug`, 'PUT', { slug });

  // 只改中文名稱、網址英文名留空 → project-1
  await call(tok, `/api/projects/${pj.id}`, 'PATCH', { name: '測試' });
  assert.equal((await put(pj.id, '')).status, 200, '留空能過');
  assert.equal(await slugOf(pj.id), 'project-1', '中文名稱留空 → project-1');
  // 改成 test
  assert.equal((await put(pj.id, 'test')).status, 200, '改成 test 能過');
  assert.equal(await slugOf(pj.id), 'test');
  assert.equal((await put(pj.id, 'TEST')).status, 200, '大寫自動轉小寫，沒變就不動');

  // 英文名稱留空 → 轉小寫加 -
  const en = (await call(tok, '/api/projects', 'POST', { name: 'My App' })).body.id;
  assert.equal(await slugOf(en), 'my-app', '英文名稱 → my-app');
  // 中文名稱新增專案、沒填 → project-N 不撞號
  const zh = (await call(tok, '/api/projects', 'POST', { name: '行銷' })).body.id;
  assert.equal(await slugOf(zh), 'project-1', 'project-1 已被釋出（第一個專案改成 test），新的拿 project-1');
  const zh2 = (await call(tok, '/api/projects', 'POST', { name: '業務' })).body.id;
  assert.equal(await slugOf(zh2), 'project-2', '撞號往後排');
  // 英文名撞號 → my-app-2
  const en2 = (await call(tok, '/api/projects', 'POST', { name: 'my_app' })).body.id;
  assert.equal(await slugOf(en2), 'my-app-2', '英文名撞號往後加 -2');

  // 填了但不合規則：說哪裡不對＋建議值
  const bad1 = await put(zh, '行銷 site');
  assert.equal(bad1.status, 400); assert.equal(bad1.body.error.code, 'INVALID_SLUG');
  assert.match(bad1.body.error.message, /不能有「行銷空白」/); assert.equal(bad1.body.error.suggestion, 'site');
  const bad2 = await put(zh, 'prj_lXbpTxn6');
  assert.equal(bad2.body.error.suggestion, 'prj-lxbptxn6', '底線換成 -');
  const bad3 = await put(zh, 'a');
  assert.match(bad3.body.error.message, /至少 2 個字/); assert.match(bad3.body.error.suggestion, /^project-\d+$/, '太短 → 依名稱產生');
  const bad4 = await put(zh, 'api');
  assert.match(bad4.body.error.message, /保留字/); assert.equal(bad4.body.error.suggestion, 'api-2');
  const bad5 = await put(zh, '-abc');
  assert.match(bad5.body.error.message, /開頭不能是 -/); assert.equal(bad5.body.error.suggestion, 'abc');
  // 撞號
  const taken = await put(zh, 'my-app');
  assert.equal(taken.status, 409); assert.equal(taken.body.error.code, 'SLUG_TAKEN'); assert.equal(taken.body.error.suggestion, 'my-app-3');
  // 新增專案同一套規則
  const np1 = await call(tok, '/api/projects', 'POST', { name: '客服', slug: '客服' });
  assert.equal(np1.status, 400); assert.equal(np1.body.error.code, 'INVALID_SLUG'); assert.ok(np1.body.error.suggestion);
  const np2 = await call(tok, '/api/projects', 'POST', { name: '客服', slug: 'test' });
  assert.equal(np2.status, 409); assert.equal(np2.body.error.suggestion, 'test-2');
  const np3 = await call(tok, '/api/projects', 'POST', { name: '客服', slug: 'Support' });
  assert.equal(np3.status, 201); assert.equal(await slugOf(np3.body.id), 'support', '填了合法的就用它（轉小寫）');
  // 網址能用新的英文名開
  assert.ok((await projects()).every(p => /^[a-z0-9][a-z0-9-]{1,39}$/.test(p.slug)), '所有專案都有合法的網址英文名：' + JSON.stringify((await projects()).map(p => p.slug)));
  console.log('slug-optional-test：全部通過');
} catch (e) {
  console.error('slug-optional-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
