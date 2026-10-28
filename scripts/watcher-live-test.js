// 驗收測試：watcher 連平台內建即時通道（真的 node server.js＋真的 watcher）
// 1. 不設 Supabase：watcher 連上 /api/live，被 @ 幾秒內就叫醒（保底巡檢設成 60 分鐘，所以不是巡檢叫醒的）
// 2. 平台重開（斷線）：watcher 自己重連，再被 @ 照樣幾秒內醒
// 3. 平台關掉內建即時通道（LIVE=0）：watcher 寫「沒有內建即時通道」，退回巡檢
// 用法：node scripts/watcher-live-test.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testToken } from './test-token.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SERVER = fileURLToPath(new URL('../server.js', import.meta.url));
const WATCHER = fileURLToPath(new URL('../public/watcher.mjs', import.meta.url));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wlive-'));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const until = async (fn, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw new Error('等不到：' + label); };
const procs = [];
const run = (file, env, cwd) => { const p = spawn(process.execPath, [file], { cwd, env: { ...process.env, ...env } }); let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); const w = { p, log: () => out, stop: async () => { if (p.exitCode === null && p.signalCode === null) { const done = new Promise(r => p.once('exit', r)); p.kill(); await done; } } }; procs.push(w); return w; };

try {
  const PORT = await freePort(), BASE = `http://127.0.0.1:${PORT}`;
  const startServer = (extra = {}) => run(SERVER, { PORT: String(PORT), DATA_DIR: path.join(dir, 'data'), AIGILE_TEST_PROJECTS: '1', RATE_LIMIT_PER_MIN: '10000', ...extra });
  const call = async (t, p, m = 'GET', b) => { const r = await fetch(BASE + encodeURI(p), { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  let srv = startServer();
  await until(async () => (await fetch(BASE + '/api/health').then(r => r.ok).catch(() => false)), 15000, '伺服器');
  assert.equal((await call(null, '/api/health')).body.live, true, '本機版有內建即時通道');
  const boss = (await call(null, '/api/join', 'POST', { name: '王小明', role: 'PO' })).body;
  const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '王的PG', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const { DatabaseSync } = await import('node:sqlite');
  const d = new DatabaseSync(path.join(dir, 'data', 'switch.db')); const tok = await testToken(d, ai.participantId); d.close();
  const wd = fs.mkdtempSync(path.join(dir, 'w-')), wakeLog = path.join(wd, 'wakes.txt');
  const wakes = () => { try { return fs.readFileSync(wakeLog, 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
  const cmd = `"${process.execPath}" -e "require('fs').appendFileSync('wakes.txt','w\\n')"`; // 在 watcher 的工作資料夾寫
  const w = run(WATCHER, { AIGILE_BASE: BASE, AIGILE_TOKEN: tok, AIGILE_ME: ai.participantId, SUPABASE_URL: '', SUPABASE_KEY: '', HEARTBEAT_MIN: '60', WAKE_CMD: cmd, WAKE_MAX_PER_HOUR: '0', WAKE_MAX_PER_DAY: '0' }, wd);
  await until(() => /已連上平台內建即時通道/.test(w.log()), 10000, 'watcher 連上內建即時通道：' + w.log());
  assert.ok(!/Supabase/.test(w.log().split('已連上平台內建即時通道')[0]), '沒去連 Supabase');
  await sleep(500);
  const n0 = wakes();
  // 1. 被 @：幾秒內醒
  let t0 = Date.now();
  assert.equal((await call(boss.token, '/api/messages', 'POST', { requestId: 'm1', project: '預設專案', text: '幫忙看登入頁', recipientIds: [ai.participantId] })).status, 201);
  try { await until(() => wakes() > n0, 5000, '被 @ 幾秒內醒'); } catch (e) { console.log('WATCHER LOG:\n' + w.log()); console.log('SERVER LOG:\n' + srv.log()); console.log('PENDING', JSON.stringify((await call(tok, '/api/notifications?status=pending')).body).slice(0, 300)); throw e; }
  assert.ok(Date.now() - t0 < 5000, '5 秒內');
  assert.match(w.log(), /收到門鈴（內建即時通道）/);
  await call(tok, '/api/notifications/ack', 'POST', { notificationIds: (await call(tok, '/api/notifications?status=pending')).body.items.map(n => n.notificationId) });
  // 2. 平台重開：watcher 自己重連（15 秒），再被 @ 照樣醒
  await srv.stop();
  await until(() => /內建即時通道(中斷|關閉|連不上)/.test(w.log()), 10000, 'watcher 發現斷線');
  srv = startServer();
  await until(async () => (await fetch(BASE + '/api/health').then(r => r.ok).catch(() => false)), 15000, '伺服器重開');
  await until(() => (w.log().match(/已連上平台內建即時通道/g) || []).length >= 2, 40000, 'watcher 自己重連：' + w.log());
  await sleep(500);
  const n1 = wakes();
  t0 = Date.now();
  await call(boss.token, '/api/messages', 'POST', { requestId: 'm2', project: '預設專案', text: '再看一次', recipientIds: [ai.participantId] });
  await until(() => wakes() > n1, 5000, '重連後被 @ 照樣醒');
  await w.stop(); await srv.stop();
  // 3. LIVE=0：退回巡檢
  srv = startServer({ LIVE: '0' });
  await until(async () => (await fetch(BASE + '/api/health').then(r => r.ok).catch(() => false)), 15000, '伺服器（LIVE=0）');
  assert.equal((await call(null, '/api/health')).body.live, false);
  const w2 = run(WATCHER, { AIGILE_BASE: BASE, AIGILE_TOKEN: tok, AIGILE_ME: ai.participantId, SUPABASE_URL: '', SUPABASE_KEY: '', HEARTBEAT_MIN: '60', WAKE_CMD: cmd }, wd);
  await until(() => /平台沒有內建即時通道/.test(w2.log()) && /只做每 60 分鐘巡檢/.test(w2.log()), 10000, 'LIVE=0 退回巡檢：' + w2.log());
  console.log('watcher-live-test：全部通過');
} catch (e) {
  console.error('watcher-live-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  for (const p of procs) await p.stop();
}
