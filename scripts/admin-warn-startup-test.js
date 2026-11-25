// 驗收測試：server.js 啟動時的 admin／admin 警告只在新站或尚未改預設帳密時印出，已改過帳密的站重開不再印；並檢查中英文文件一致性
// 用法：node scripts/admin-warn-startup-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { stopChild } from './test-process.js';

const ROOT = new URL('..', import.meta.url);
const read = p => fs.readFileSync(new URL(p, ROOT), 'utf8');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-admwarn-'));

async function startOnce(port) {
  let out = '';
  const env = { ...process.env, DATA_DIR: dataDir, UPDATE_CHECK: '0' };
  delete env.ADMIN_PASSWORD;
  delete env.AIGILE_TEST_PROJECTS;
  const child = spawn(process.execPath, ['server.js', '-p', String(port), '--host', '127.0.0.1'], {
    cwd: new URL('..', import.meta.url),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  await new Promise(r => setTimeout(r, 200));
  return { child, base, logs: () => out };
}

try {
  // 1) 中英文文件一致性檢查
  assert.match(read('README.md'), /unpdf[\s\S]*可選文字的 PDF/);
  assert.doesNotMatch(read('README.md'), /PDF 和圖片不抽字/);
  assert.match(read('README.en.md'), /selectable-text PDFs[\s\S]*unpdf/i);
  assert.doesNotMatch(read('README.en.md'), /\.\s+PDFs and images are kept as original files only/);
  assert.match(read('docs/connect-your-ai.md'), /管理員設定 › 群組設定/);
  assert.doesNotMatch(read('docs/connect-your-ai.md'), /成員管理 › 群組/);
  assert.match(read('docs/connect-your-ai.md'), /Claude Code、Codex、Antigravity CLI 或 Copilot CLI 才有/);
  assert.match(read('docs/connect-your-ai.en.md'), /Admin settings › Group settings/);
  assert.doesNotMatch(read('docs/connect-your-ai.en.md'), /Member management › Group/);
  assert.match(read('docs/connect-your-ai.en.md'), /Claude Code, Codex, Antigravity CLI or Copilot CLI/);

  // 2) 全新空站啟動：應該印出 admin／admin 警告
  const port = 18500 + Math.floor(Math.random() * 500);
  let s = await startOnce(port);
  try {
    assert.match(s.logs(), /新站的管理員帳號密碼是 admin／admin/, '空站首次啟動應印警告：' + s.logs());
    // 用 admin/admin 登入但先不改帳密
    const login = await (await fetch(s.base + '/api/auth/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })).json();
    assert.ok(login.token, 'admin/admin 登入成功');
  } finally {
    await stopChild(s.child);
  }

  // 3) 預設管理員已建但還沒改帳密：重開仍應印出警告
  s = await startOnce(port);
  try {
    assert.match(s.logs(), /新站的管理員帳號密碼是 admin／admin/, '尚未改預設帳密時重開仍應印警告：' + s.logs());
    const login = await (await fetch(s.base + '/api/auth/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    })).json();
    const chg = await fetch(s.base + '/api/me/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token },
      body: JSON.stringify({ currentPassword: 'admin', username: 'realboss', newPassword: 'password1234', newPasswordAgain: 'password1234' }),
    });
    assert.equal(chg.status, 200, '改帳密成功');
  } finally {
    await stopChild(s.child);
  }

  // 4) 已改過帳密的舊站重開：不再印出 admin／admin 警告
  s = await startOnce(port);
  try {
    assert.doesNotMatch(s.logs(), /新站的管理員帳號密碼是 admin／admin/, '已改過帳密的站重開不應再印警告：' + s.logs());
  } finally {
    await stopChild(s.child);
  }

  console.log('admin-warn-startup-test：全部通過');
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
