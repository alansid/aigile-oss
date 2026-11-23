// 驗收測試：叫醒合併、上限依角色、上限通知不貼群組（另：Token 檔換過 watcher 自己改用新的）
// 修正前：幾十秒內 3 則回覆各叫醒一次；PO 一小時被叫醒超過 12 次就暫停；上限通知由 AI 帳號貼專案群組（第 3 次實驗貼了 4 則）；
//         人類重發 Token 後 watcher 一直拿舊 Token 巡檢（401），要重開才好
// 修正後：
//   A 門鈴先等 WAKE_MERGE_SEC（預設 25 秒）再查，期間的門鈴併成一次叫醒
//   B PO 預設上限較高（echo 每小時 30、每天 150；其他 6／30），環境變數有設以環境變數為準
//   C 到上限由平台私訊所屬人類（平台通知），一天一次，不貼專案群組
//   D 測試：連續 3 則門鈴只叫醒 1 次；到上限不產生群組訊息
// 用法：node scripts/wake-merge-test.js
import { stopChild, stopServer } from './test-process.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { testToken } from './test-token.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const WATCHER = fileURLToPath(new URL('../public/watcher.mjs', import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p330-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// 假的 Supabase Realtime：只做 WebSocket 握手與送文字框（watcher 送來的 join、心跳不用回）
const sockets = new Set();
const rt = http.createServer((_, res) => { res.writeHead(404); res.end(); });
rt.on('upgrade', (req, sock) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  sockets.add(sock); sock.on('close', () => sockets.delete(sock)); sock.on('error', () => {}); sock.on('data', () => {});
});
await new Promise(r => rt.listen(0, '127.0.0.1', r));
const SB = `http://127.0.0.1:${rt.address().port}`;
const frame = s => { const b = Buffer.from(s); const h = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]); return Buffer.concat([h, b]); };
let bellN = 0;
function doorbell(ai) { // 跟平台一樣用 AI 的 Token 簽章
  const at = new Date().toISOString(), n = 'bell_' + (++bellN);
  const sig = createHmac('sha256', ai.tok).update(`doorbell|${ai.id}|${at}|${n}`).digest('hex').slice(0, 32);
  const msg = JSON.stringify({ topic: 'realtime:aigile-switch', event: 'broadcast', payload: { event: 'doorbell', payload: { ids: [ai.id], at, n, sigs: { [ai.id]: sig } } } });
  for (const s of sockets) s.write(frame(msg));
}

const procs = [];
function startWatcher(cwd, ai, extra) {
  const p = spawn(process.execPath, [WATCHER], { cwd, env: { ...process.env, AIGILE_BASE: BASE, AIGILE_TOKEN: ai.tok, AIGILE_ME: ai.id, SUPABASE_URL: '', SUPABASE_KEY: '', HEARTBEAT_MIN: '30', BELL_FILE: path.join(cwd, 'bell.json'), ...extra } });
  let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
  const w = { p, log: () => out, stop: async () => { p.kill(); await new Promise(r => p.exitCode !== null ? r() : p.on('exit', r)); } };
  procs.push(w); return w;
}
const until = async (fn, ms, label, w) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw new Error('等不到：' + label + (w ? '\n' + w.log().slice(-800) : '')); };
const cmd = `"${process.execPath}" -e "require('fs').appendFileSync('wakes.txt','w\\n')"`;
const wakesIn = dir => { try { return fs.readFileSync(path.join(dir, 'wakes.txt'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const mk = async (name, roleKey = 'PG') => { const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey, role: roleKey, name, duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body; return { id: a.participantId, tok: await testToken(db, a.participantId) }; };
  let k = 0;
  const notify = ai => call(liu.token, '/api/messages', 'POST', { project: '預設專案', requestId: `n-${++k}`, recipientIds: [ai.id], replyFrom: [ai.id], text: `[需確認] 第 ${k} 題\n選項：\nA. 好\nB. 不好` });

  // A／D：30 秒內 3 則門鈴只叫醒 1 次（合併等 2 秒）
  const a = await mk('合併助手'), wa = fs.mkdtempSync(path.join(dataDir, 'a-'));
  let w = startWatcher(wa, a, { WAKE_CMD: cmd, WAKE_MERGE_SEC: '2', WAKE_MAX_PER_HOUR: '100', WAKE_MAX_PER_DAY: '100', SUPABASE_URL: SB, SUPABASE_KEY: 'k' });
  await until(() => /已連上即時通道/.test(w.log()) && /連線後巡檢/.test(w.log()), 8000, '連上假頻道', w);
  for (let i = 0; i < 3; i++) { await notify(a); doorbell(a); await sleep(300); }
  await until(() => wakesIn(wa) >= 1, 8000, '合併後叫醒', w);
  await sleep(3000);
  assert.equal(wakesIn(wa), 1, '3 則門鈴只叫醒 1 次：\n' + w.log().slice(-800));
  assert.match(w.log(), /\[門鈴×3\]/, '日誌寫合併了幾個門鈴');
  // 預設等 25 秒（可設定）；0＝不等
  const src = fs.readFileSync(WATCHER, 'utf8');
  assert.match(src, /num\(env\.WAKE_MERGE_SEC, 25\)/);
  await w.stop();

  // B：PO 預設上限較高；環境變數有設照環境變數
  const po = await mk('產品助手', 'PO'), wp = fs.mkdtempSync(path.join(dataDir, 'p-'));
  w = startWatcher(wp, po, { WAKE_CMD: 'echo WAKE' });
  await until(() => /角色 PO：叫醒上限每小時 30、每天 150/.test(w.log()), 8000, 'PO 預設上限', w);
  await w.stop();
  w = startWatcher(wp, po, { WAKE_CMD: 'echo WAKE', WAKE_MAX_PER_HOUR: '5', WAKE_MAX_PER_DAY: '9' });
  await until(() => /啟動\]/.test(w.log()), 8000, '啟動', w);
  assert.ok(!/角色 PO/.test(w.log()), '環境變數都設了就不改');
  await w.stop();
  const pg = await mk('一般助手'), wg = fs.mkdtempSync(path.join(dataDir, 'g-'));
  w = startWatcher(wg, pg, { WAKE_CMD: 'echo WAKE' });
  await until(() => /啟動\]/.test(w.log()), 8000, '啟動', w);
  assert.ok(!/角色 PG：/.test(w.log()), 'PG 照原本預設');
  await w.stop();

  // C／D：到上限由平台私訊所屬人類，不貼群組；一天一次
  const c = await mk('上限助手'), wc = fs.mkdtempSync(path.join(dataDir, 'c-'));
  w = startWatcher(wc, c, { WAKE_CMD: cmd, WAKE_MAX_PER_HOUR: '1', HEARTBEAT_MIN: '0.01' });
  await notify(c); await sleep(1500); await notify(c);
  await until(() => /叫醒已達每小時上限 1 次/.test(w.log()), 8000, '到上限', w);
  await until(async () => (await db.all("SELECT 1 FROM dms WHERE from_id = 'system' AND ai_id = ?", c.id)).length === 1, 5000, '平台私訊', w);
  const dm = await db.get("SELECT * FROM dms WHERE from_id = 'system' AND ai_id = ?", c.id);
  assert.equal(dm.human_id, liu.participant.participantId, '私訊給所屬人類');
  assert.match(dm.text, /^\[通知\] 上限助手 這一小時被叫醒太多次（1 次），先暫停到 \d\d:\d\d 自動恢復，目前有 \d+ 則等它處理。急的話到它的電腦叫它看一下；常常這樣請找工程師調高上限。今天不再提醒。$/);
  assert.ok(!/watcher|WAKE_MAX/.test(dm.text), 'UX：給人看的不寫 watcher、環境變數名');
  assert.equal((await db.all('SELECT 1 FROM messages WHERE author_id = ?', c.id)).length, 0, '沒有貼群組');
  const again = (await call(c.tok, '/api/me/wake-cap', 'POST', { kind: '每天', max: 3, pending: 1 })).body;
  assert.equal(again.notified, false, '同一天第二次不再通知');
  assert.equal((await db.all("SELECT 1 FROM dms WHERE from_id = 'system' AND ai_id = ?", c.id)).length, 1);
  assert.equal((await call(liu.token, '/api/me/wake-cap', 'POST', {})).status, 403, '人類不能呼叫');
  // 人類的收件匣看得到（平台通知）
  const ln = (await call(liu.token, '/api/notifications?status=pending')).body.items.filter(n => n.dm && n.sender.system);
  assert.ok(ln.length >= 1, '人類收到平台通知');
  await w.stop();

  // Token 檔換過：401 時重讀，不用重開 watcher
  const t = await mk('換Token助手'), wt = fs.mkdtempSync(path.join(dataDir, 't-'));
  const tokFile = path.join(wt, '.token'); fs.writeFileSync(tokFile, t.tok);
  w = startWatcher(wt, t, { AIGILE_TOKEN: '', AIGILE_TOKEN_FILE: tokFile, WAKE_CMD: cmd, HEARTBEAT_MIN: '0.01', WAKE_MAX_PER_HOUR: '100' });
  await until(() => /啟動\]/.test(w.log()), 8000, '啟動', w);
  const re = (await call(liu.token, `/api/my-ais/${t.id}/reissue`, 'POST')).body;
  assert.ok(re.token && re.token !== t.tok);
  fs.writeFileSync(tokFile, re.token);
  await until(() => /Token 檔換過了，改用新的 Token/.test(w.log()), 8000, '重讀 Token', w);
  await notify(t);
  await until(() => wakesIn(wt) >= 1, 8000, '換 Token 後照常叫醒', w);
  await w.stop();

  console.log('wake-merge-test：全部通過');
} catch (e) {
  console.error('wake-merge-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  await Promise.all(procs.map(w => stopChild(w.p)));
  for (const s of sockets) s.destroy();
  await Promise.all([stopServer(server), stopServer(rt)]);
  await sleep(300);
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
