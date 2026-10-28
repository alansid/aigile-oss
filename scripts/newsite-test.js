// 重現測試：全新的站（沒有「預設專案」「第二專案」）也能用
// 修正前：新站沒有寫死的專案時，有些功能找不到專案
// 用法：node scripts/newsite-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-new-'));
const mk = (file, opts) => { const db = openNodeDb(path.join(dataDir, file), opts); return { db, app: createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '10000' } }) }; };
const caller = app => async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

try {
  // 全新的站：沒有任何專案 → 第一次啟動自動建「預設專案」，第一個人（管理員）在裡面
  const { app, db } = mk('new.db', { legacyProjects: false });
  const call = caller(app);
  assert.equal((await call(null, '/api/health')).body.setup, true, '還沒有人');
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  let r = await call(boss.token, '/api/projects');
  const ops = r.body.items.find(p => p.name === '預設專案');
  assert.ok(ops, '自動建「預設專案」');
  assert.ok(!r.body.items.some(p => p.id === '預設專案' || p.id === '第二專案'), '新站不自帶「預設專案」「第二專案」');
  assert.ok((await call(boss.token, '/api/me')).body.projects.includes(ops.id), '管理員在預設專案');
  assert.equal(r.body.feedbackProject, undefined, '沒有回報收件專案');
  assert.ok(!(await db.get("SELECT 1 AS x FROM app_settings WHERE key = 'feedback_project'")), '新站不寫回報收件專案的設定');
  // 開源版沒有回報問題與許願池
  for (const [m, p] of [['GET', '/api/reports'], ['POST', '/api/reports'], ['GET', '/api/wishes'], ['POST', '/api/wishes'], ['PUT', '/api/settings/feedback-project']]) {
    assert.equal((await call(boss.token, p, m, m === 'GET' ? undefined : { title: 'x', project: ops.id })).status, 404, `${m} ${p} 已拿掉`);
  }
  for (const t of ['reports', 'report_shots', 'wishes', 'wish_votes']) assert.ok(!(await db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", t)), `不建 ${t} 資料表`);

  // 管理員可以再建專案
  const pj2 = (await call(boss.token, '/api/projects', 'POST', { name: '外食減脂助手' })).body.id;
  assert.ok(pj2, '建第二個專案');

  // 原本的站：照舊有「預設專案」，不多建
  const legacy = caller(mk('legacy.db').app);
  const a = (await legacy(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  r = await legacy(a.token, '/api/projects');
  assert.equal(r.body.items.filter(p => p.name === '預設專案').length, 1, '原本的站不多建一個');
  console.log('newsite-test：全部通過');
} catch (e) {
  console.error('newsite-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
