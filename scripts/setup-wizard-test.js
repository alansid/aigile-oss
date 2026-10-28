// 第一次設定引導：預設管理員改完帳密後 /api/me 帶 setupWizard；做完（POST /api/setup-wizard/done）就不再出現
// 只有管理員看得到、只有管理員能結束；重啟不會再出現；沒開預設管理員的站（測試模式、舊站）不出現
// 用法：node scripts/setup-wizard-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wizard-'));
const mk = (file, config, opts = { legacyProjects: false }) => {
  const db = openNodeDb(path.join(dataDir, file), opts);
  const app = createApp({ db, storage: dbStorage(db), docText: '', config: { rateLimitPerMin: '100000', teamCacheMs: '0', ...config } });
  return async (token, p, method = 'GET', body) => {
    const r = await app(new Request('http://localhost' + encodeURI(p), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
};
try {
  const call = mk('a.db', { defaultAdmin: '1' });
  await call(null, '/api/health');
  const tok = (await call(null, '/api/auth/password', 'POST', { username: 'admin', password: 'admin' })).body.token;
  assert.ok(tok, '預設管理員登入');
  assert.equal((await call(tok, '/api/me/password', 'PUT', { username: 'boss.lin', currentPassword: 'admin', newPassword: 'longpassword1', newPasswordAgain: 'longpassword1' })).status, 200, '改帳密');
  assert.equal((await call(tok, '/api/me')).body.setupWizard, true, '改完帳密：管理員要做第一次設定');

  // 引導用到的設定都能做（群組名稱、專案名稱與網址代號、邀請、建 AI 與接入連結）
  const pj = (await call(tok, '/api/projects')).body.items[0];
  assert.equal((await call(tok, '/api/group', 'PUT', { name: '我們的團隊' })).status, 200, '群組名稱');
  assert.equal((await call(tok, `/api/projects/${pj.id}`, 'PATCH', { name: '官網改版' })).status, 200, '專案名稱');
  assert.equal((await call(tok, `/api/projects/${pj.id}/slug`, 'PUT', { slug: 'web' })).status, 200, '網址代號');
  const inv = await call(tok, '/api/invites', 'POST', { name: '王小明', projects: [pj.id] });
  assert.equal(inv.status, 201, '邀請連結：' + JSON.stringify(inv.body)); assert.ok(inv.body.url);
  const ai = await call(tok, '/api/my-ais', 'POST', { projects: [pj.id], roleKey: 'PG', role: '程式開發', name: '管理員的程式開發助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' });
  assert.equal(ai.status, 201, '建 AI');
  assert.ok((await call(tok, `/api/my-ais/${ai.body.participantId}/onboarding-link`, 'POST', {})).body.url, '接入連結');

  // 只有管理員看得到、能結束
  const mate = (await call(null, '/api/join', 'POST', { name: '陳大文', role: 'QA' })).body;
  assert.ok(!(await call(mate.token, '/api/me')).body.setupWizard, '一般成員看不到引導');
  assert.equal((await call(mate.token, '/api/setup-wizard/done', 'POST')).status, 403, '一般成員不能結束引導');
  assert.equal((await call(tok, '/api/me')).body.setupWizard, true, '還沒做完就還在');
  assert.equal((await call(tok, '/api/setup-wizard/done', 'POST')).status, 200, '管理員結束引導');
  assert.ok(!(await call(tok, '/api/me')).body.setupWizard, '做完不再出現');

  // 重啟不再出現
  const again = mk('a.db', { defaultAdmin: '1' });
  assert.ok(!(await again(tok, '/api/me')).body.setupWizard, '重啟後也不出現');

  // 沒開預設管理員的站：不出現
  const t = mk('t.db', {}, {});
  const first = (await t(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  assert.ok(!(await t(first.token, '/api/me')).body.setupWizard, '測試模式、舊站不出現引導');
  console.log('setup-wizard-test：全部通過');
} catch (e) {
  console.error('setup-wizard-test 失敗：', e.stack || e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
