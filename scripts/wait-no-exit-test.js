// 驗收測試：等待腳本時間到、沒有事時不叫醒 AI
// 修正前：等待腳本 110 分鐘 TIMEOUT 就結束，Claude Code 被叫醒再重開，一天約 13 次空轉；電腦睡醒會誤判 watcher 不在
// 修正後：--max-min 是健康檢查間隔，沒事繼續等；結束就是有事（待處理、錯誤、Token 失效）；睡醒給 watcher 7 分鐘緩衝
// 用本機記憶體資料庫，不連正式庫
// 用法：node scripts/wait-no-exit-test.js
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WAIT = fileURLToPath(new URL('../public/aigile-wait.mjs', import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-wait-no-exit-'));
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '1000000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// 測試用伺服器：記等待腳本查了幾次；可以暫時回 500（網路／平台錯誤）或 401（Token 過期）
let waitCounts = 0, mode = 'ok';
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/notifications/count') && req.headers['x-aigile-source'] === 'wait') {
    waitCounts++;
    if (mode === '500') { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":{"code":"INTERNAL"}}'); }
    if (mode === '401') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":{"code":"TOKEN_EXPIRED","message":"Token 已過期"}}'); }
  }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const work = fs.mkdtempSync(path.join(dataDir, 'w-'));
const dir = path.join(work, '.aigile', 'T');
fs.mkdirSync(dir, { recursive: true });
const SKEW = path.join(dataDir, 'skew.txt');
let skew = 0;
const setSkew = ms => { skew = ms; fs.writeFileSync(SKEW, String(ms)); };
// 用測試程序自己當「活著的 watcher」；心跳時間跟著模擬時鐘走
const alive = () => fs.writeFileSync(path.join(dir, 'watcher.pid'), String(process.pid));
let seq = 1;
const writeBell = (pending = 0, agoMs = 0) => fs.writeFileSync(path.join(dir, 'bell.json'), JSON.stringify({ v: 1, seq: seq++, pending, heartbeatAt: new Date(Date.now() + skew - agoMs).toISOString(), pid: process.pid }));
const heartbeat = () => { const b = JSON.parse(fs.readFileSync(path.join(dir, 'bell.json'), 'utf8')); b.heartbeatAt = new Date(Date.now() + skew).toISOString(); fs.writeFileSync(path.join(dir, 'bell.json'), JSON.stringify(b)); };
const procs = [];
function startWait(args, env = {}) {
  const p = spawn(process.execPath, [WAIT, '--agent', 'T', ...args], { cwd: work, env: { ...process.env, AIGILE_BASE: BASE, AIGILE_TOKEN: '', AIGILE_TOKEN_FILE: '', AIGILE_WAIT_TEST_SKEW_FILE: SKEW, ...env }, stdio: 'pipe' });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const done = new Promise(r => p.on('exit', code => r(code)));
  const w = { p, out: () => out, lines: () => out.trim().split('\n').filter(Boolean), last: () => out.trim().split('\n').pop(), running: () => p.exitCode === null, done, kill: async () => { if (p.exitCode === null) { p.kill(); await done; } } };
  procs.push(w); return w;
}
const until = async (fn, ms, label, w) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(50); } throw new Error('等不到：' + label + (w ? '\n' + w.out().slice(-600) : '')); };
const TICK = String(0.1 / 60); // 健康檢查 0.1 秒一次（正式 110 分鐘）

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = await testToken(db, ai.participantId);
  fs.writeFileSync(path.join(dir, '.token'), tok);
  let n = 0;
  const ping = async () => assert.equal((await call(liu.token, '/api/messages', 'POST', { project: '預設專案', requestId: 'p' + (++n), text: '請看 ' + n, recipientIds: [ai.participantId], replyFrom: [ai.participantId] })).status, 201);
  const ackAll = async () => { const items = (await call(tok, '/api/notifications?status=pending&limit=50')).body.items || []; if (items.length) await call(tok, '/api/notifications/ack', 'POST', { notificationIds: items.map(x => x.notificationId) }); };
  setSkew(0);

  // 1. 模擬一整天沒事：健康檢查 96 次（110 分鐘一次縮成 0.1 秒），腳本不結束、叫醒 0 次
  alive(); writeBell(0);
  waitCounts = 0;
  let w = startWait([`--max-min=${TICK}`]);
  await until(() => waitCounts >= 97, 30_000, '健康檢查 96 次', w);
  assert.ok(w.running(), '一整天沒事：等待腳本沒有結束（叫醒 0 次）');
  assert.ok(!/TIMEOUT|PENDING|RECOVERED|WARN/.test(w.out()), '沒印 TIMEOUT／PENDING／WARN：' + w.out());
  console.log(`wait-no-exit-test：一整天沒事 ${waitCounts - 1} 次健康檢查、叫醒 0 次`);
  // 有待處理照常結束：健康檢查抓到
  await ping();
  assert.equal(await w.done, 0); assert.equal(w.last(), 'PENDING 1', '健康檢查抓到待處理就結束');
  await ackAll();
  // 門鈴：數秒內結束
  alive(); writeBell(0);
  w = startWait(['--look-sec=1']);
  await sleep(800); writeBell(2);
  const t0 = Date.now(); assert.equal(await w.done, 0); assert.equal(w.last(), 'PENDING 2');
  assert.ok(Date.now() - t0 < 5000, '門鈴數秒內醒');

  // 2. 健康檢查遇到 401：馬上結束，印原因與 UNAUTHORIZED；其他錯誤（500）記一行、繼續等
  alive(); writeBell(0);
  w = startWait([`--max-min=${TICK}`]);
  await until(() => waitCounts > 0 && w.running(), 5000, '啟動');
  mode = '500'; const c0 = waitCounts;
  await until(() => waitCounts >= c0 + 5, 10_000, '500 也繼續健康檢查', w);
  assert.ok(w.running(), '平台錯誤不結束、繼續等');
  assert.match(w.out(), /WARN 健康檢查查待處理數失敗（HTTP 500），繼續等/);
  mode = '401';
  assert.equal(await w.done, 20, '401 結束碼 20');
  assert.equal(w.last(), 'UNAUTHORIZED');
  assert.match(w.out(), /Token 無效或過期（TOKEN_EXPIRED）：停止 watcher 與等待腳本，告訴所屬人類/, '印出清楚的結束原因');
  mode = 'ok';

  // 3. 電腦睡醒：時鐘跳 1 小時（門鈴檔心跳看起來舊了），watcher 程序還在 → 不印 WARN；先查一次待處理數
  setSkew(0); alive(); writeBell(0);
  w = startWait(['--alive-sec=0.2', '--wake-grace-min=0.05']); // 緩衝 3 秒
  await sleep(700);
  const c1 = waitCounts;
  setSkew(60 * 60_000);
  await until(() => /偵測到電腦睡醒（停了約 60 分鐘）/.test(w.out()), 5000, '偵測睡醒', w);
  await until(() => waitCounts > c1, 3000, '睡醒先查一次待處理數', w);
  await sleep(800);
  assert.ok(!/WARN watcher 不在/.test(w.out()), '緩衝期間不誤判 watcher 不在');
  heartbeat(); // watcher 醒來補寫心跳
  await sleep(3500); // 緩衝過了
  assert.ok(!/WARN/.test(w.out()), 'watcher 補了心跳：一直都不印 WARN：' + w.out());
  assert.ok(w.running(), '睡醒不結束');
  await w.kill();
  // 睡醒後 watcher 真的沒回來（緩衝過了心跳還是舊的）→ 印 WARN、改備援，不結束
  setSkew(0); alive(); writeBell(0);
  w = startWait(['--alive-sec=0.2', '--wake-grace-min=0.05', '--poll-sec=1']);
  await sleep(700); setSkew(60 * 60_000);
  await until(() => /偵測到電腦睡醒/.test(w.out()), 5000, '偵測睡醒', w);
  await until(() => /WARN watcher 不在/.test(w.out()), 8000, '緩衝過了還沒心跳就印 WARN', w);
  assert.ok(w.running(), '改備援輪詢，不結束');
  await ping();
  assert.equal(await w.done, 0); assert.equal(w.last(), 'PENDING 1', '備援輪詢照常抓到');
  await ackAll(); setSkew(0);
  // watcher 真的死掉（沒睡醒）：照樣印 WARN
  fs.rmSync(path.join(dir, 'watcher.pid'), { force: true });
  w = startWait(['--alive-sec=0.2', '--poll-sec=60']);
  await until(() => /WARN watcher 不在/.test(w.out()), 5000, 'watcher 死掉印 WARN', w);
  await w.kill();

  // 4. 要舊行為：--exit-on-timeout 時間到照舊 TIMEOUT 結束
  alive(); writeBell(0);
  w = startWait(['--max-min=0.02', '--exit-on-timeout']);
  assert.equal(await w.done, 10); assert.equal(w.last(), 'TIMEOUT', '--exit-on-timeout 照舊');

  // 5. 規格、接入設定、接入檢查
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.ok(spec.includes('等待腳本沒事不會結束；它結束就是有事（待處理、錯誤或 Token 失效），處理完再重開。'), '規格那句白話');
  assert.ok(!/`TIMEOUT` → 直接再執行；/.test(spec) && /`TIMEOUT`（只有加 `--exit-on-timeout` 才會出現）/.test(spec), '規格 TIMEOUT 改寫');
  assert.ok(!/--max-min=110/.test(spec), '規格的等待指令拿掉 --max-min=110');
  assert.match(spec, /電腦睡醒先查一次，給 watcher 7 分鐘補心跳/);
  const ob = (await (await app(new Request(`http://localhost/api/my-ais/${ai.participantId}/onboarding?tool=claude`, { headers: { Authorization: `Bearer ${liu.token}` } }), 'http://localhost')).json()).text;
  assert.ok(!/TIMEOUT|--max-min=110/.test(ob), '接入設定不再寫 TIMEOUT → 直接再執行、--max-min=110');
  assert.match(ob, /沒事不會結束，結束就是有事。PENDING →/);
  assert.match(ob, /UNAUTHORIZED／NETWORK_ERROR／CONFIG_ERROR 就停止回報/, '401 等錯誤照舊停止回報');
  assert.ok([...ob].length <= 6500, '接入設定 ≤ 6,500 字：' + [...ob].length);
  const setup = fs.readFileSync(new URL('../public/aigile-setup.mjs', import.meta.url), 'utf8');
  assert.match(setup, /等待腳本：node \$\{envArg\} \.aigile\/watcher\/aigile-wait\.mjs --agent \$\{AGENT\}（沒事不會結束，結束就是有事）/);
  console.log('wait-no-exit-test：全部通過');
} catch (e) {
  console.error('wait-no-exit-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  for (const w of procs) await w.kill().catch(() => {});
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
