// 版本紀錄與流程圖
// - 產生的版本紀錄要新的在上面、時間一律 UTC、事故對照兩邊都標到
// - 要登入才讀得到，不放 public（重現測試： 退回，/releases.json、/flows.md 不登入就讀得到）
// 用法：node scripts/releases-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';

const root = new URL('../', import.meta.url);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rel-'));
try {
  execFileSync('node', ['scripts/releases.mjs'], { cwd: root, encoding: 'utf8' });
  const j = JSON.parse(fs.readFileSync(new URL('generated/releases.json', root), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version;
  const notes = JSON.parse(fs.readFileSync(new URL('docs/releases-notes.json', root), 'utf8'));
  assert.ok(j.items.length >= notes.releases.length && notes.releases.length >= 1, '有版本資料（發行說明的版本都在）');
  assert.ok(j.items.every(r => /Z$/.test(r.at)), '時間一律 UTC（Z 結尾）');
  for (let i = 1; i < j.items.length; i++) assert.ok(Date.parse(j.items[i - 1].at) >= Date.parse(j.items[i].at), `新的在上面：${j.items[i - 1].version} 要在 ${j.items[i].version} 前面`);
  assert.equal(j.current, pkg, 'current＝package.json 版本');
  assert.ok(j.items.some(r => r.version === pkg), '目前版本在版本紀錄裡');
  for (const n of notes.releases) assert.ok(j.items.find(r => r.version === n.version)?.commits.some(c => c.title === n.title), `發行說明 v${n.version} 的標題有帶進去`);

  // 沒有 git 也產生得出來：在沒有 .git 的暫存資料夾跑一次
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-rel-bare-'));
  for (const d of ['scripts', 'docs', 'public']) fs.cpSync(new URL(d + '/', root), path.join(bare, d), { recursive: true });
  fs.copyFileSync(new URL('package.json', root), path.join(bare, 'package.json'));
  execFileSync('node', ['scripts/releases.mjs'], { cwd: bare, encoding: 'utf8', env: { ...process.env, GIT_DIR: path.join(bare, 'no-git'), GIT_CEILING_DIRECTORIES: path.dirname(bare) } });
  const jb = JSON.parse(fs.readFileSync(path.join(bare, 'generated', 'releases.json'), 'utf8'));
  assert.deepEqual(jb.items.map(r => r.version), notes.releases.map(r => r.version).sort().reverse(), '沒有 git：版本照發行說明');
  fs.rmSync(bare, { recursive: true, force: true });

  // 不放 public（外人讀不到）；要登入才讀得到
  assert.ok(!fs.existsSync(new URL('public/releases.json', root)) && !fs.existsSync(new URL('public/flows.md', root)), 'public 沒有版本紀錄與流程圖');
  const flowsText = fs.readFileSync(new URL('docs/flows.md', root), 'utf8');
  const db = openNodeDb(path.join(dataDir, 'switch.db'));
  const app = createApp({ db, storage: dbStorage(db), docText: '', flowsText, releases: j, config: { openJoin: '1', rateLimitPerMin: '10000' } });
  const get = async (p, token) => { const r = await app(new Request('http://localhost' + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} }), 'http://localhost'); return { status: r.status, text: await r.text() }; };
  assert.equal((await get('/api/releases')).status, 401, '不登入讀不到版本紀錄');
  assert.equal((await get('/api/flows')).status, 401, '不登入讀不到流程圖');
  const boss = await (await app(new Request('http://localhost/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '林志明', role: 'PO' }) }), 'http://localhost')).json();
  const r1 = await get('/api/releases', boss.token);
  assert.equal(r1.status, 200); assert.equal(JSON.parse(r1.text).items.length, j.items.length, '登入讀得到版本紀錄');
  const r2 = await get('/api/flows', boss.token);
  assert.equal(r2.status, 200); assert.ok(r2.text.includes('## 一、登入（L）'), '登入讀得到流程圖');
  console.log('releases-test：全部通過');
} catch (e) {
  console.error('releases-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
