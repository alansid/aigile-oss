// Codex 接入、閒置巡檢與關窗後保留通知
import './test-home.mjs'; // 不寫到真的家目錄
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const CX = pub('aigile-codex.mjs');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-codex-standby-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '100000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})), text: '' };
};
let countCalls = 0;
const server = http.createServer(async (req, res) => {
  const f = /^\/(watcher|aigile-wait|aigile-setup|aigile-opencode|aigile-mcp|aigile-codex|aigile-codex-ui|aigile-antigravity|aigile-start|aigile-hook)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  if (req.url.startsWith('/api/notifications/count')) countCalls++;
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// 假的 codex：記下參數；新對話印 thread.started（或照設定不印、改寫 Codex 對話檔）；也模擬 AI 把 Token 印出來
const FAKE = fileURLToPath(new URL('./fake-codex.mjs', import.meta.url));
const calls = d => fs.existsSync(path.join(d, 'codex-calls.jsonl')) ? fs.readFileSync(path.join(d, 'codex-calls.jsonl'), 'utf8').trim().split('\n') : [];
try {
  // 接入檢查 --tool codex：WAKE_CMD 設成 Codex 喚醒腳本；不印前景等待腳本
  const liu = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const ai = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = await testToken(db, ai.participantId);
  const AG = (await call(tok, '/api/me/watcher-env')).body.agent;
  const wd = fs.mkdtempSync(path.join(dataDir, 's-'));
  fs.mkdirSync(path.join(wd, '.aigile', AG), { recursive: true });
  fs.writeFileSync(path.join(wd, '.aigile', AG, '.token'), tok);
  const setup = (...extra) => new Promise(ok => execFile(process.execPath, [pub('aigile-setup.mjs'), '--agent', AG, '--base', BASE, ...extra],
    { cwd: wd, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', CODEX_HOME: process.env.AIGILE_TEST_CODEX_HOME, AIGILE_CLAUDE_BIN: path.join(dataDir, 'no-claude.mjs') } }, (e, out) => ok({ code: e ? e.code : 0, out })));
  const wakeCmd = () => /^WAKE_CMD=(.*)$/m.exec(fs.readFileSync(path.join(wd, '.aigile', AG, 'watcher.env'), 'utf8'))[1];
  let r = await setup('--tool', 'codex', '--mode', 'fresh');
  assert.equal(r.code, 0, r.out);
  assert.equal(wakeCmd(), `node .aigile/watcher/aigile-codex.mjs --agent ${AG} --mode fresh`, 'WAKE_CMD 指向 Codex 喚醒腳本');
  assert.ok(fs.existsSync(path.join(wd, '.aigile/watcher/aigile-codex.mjs')), '喚醒腳本一起下載核對');
  assert.match(r.out, /Codex 視窗開著才會處理工作/);
  assert.ok(!/aigile-wait\.mjs --agent/.test(r.out), 'Codex 不印前景等待腳本');
  r = await setup('--tool', 'codex', '--mode', 'auto');
  assert.match(wakeCmd(), /--mode auto$/, '換接續方式跟著改');
  r = await setup('--tool', 'codex');
  assert.match(wakeCmd(), /--mode auto$/, '沒帶 --mode 沿用');
  fs.writeFileSync(path.join(wd, '.aigile', AG, 'watcher.env'), fs.readFileSync(path.join(wd, '.aigile', AG, 'watcher.env'), 'utf8').replace(/^WAKE_CMD=.*$/m, 'WAKE_CMD=my-own-wake.cmd'));
  await setup('--tool', 'codex', '--mode', 'keep');
  assert.equal(wakeCmd(), 'my-own-wake.cmd', '自己寫的 WAKE_CMD 不動');
  const wd2 = fs.mkdtempSync(path.join(dataDir, 's-')); fs.mkdirSync(path.join(wd2, '.aigile', AG), { recursive: true }); fs.writeFileSync(path.join(wd2, '.aigile', AG, '.token'), tok);
  r = await new Promise(ok => execFile(process.execPath, [pub('aigile-setup.mjs'), '--agent', AG, '--base', BASE, '--tool', 'claude'], { cwd: wd2, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_CLAUDE_BIN: path.join(dataDir, 'no-claude.mjs') } }, (e, out) => ok({ out })));
  assert.match(fs.readFileSync(path.join(wd2, '.aigile', AG, 'watcher.env'), 'utf8'), /^WAKE_CMD=echo WAKE$/m, 'Claude Code 照舊 echo');
  assert.match(r.out, /等待腳本：node/, 'Claude Code 照舊印等待腳本');

  // 7. 一整天沒事叫醒 0 次：watcher 用 Codex 喚醒腳本，巡檢 96 次（15 分鐘一次×24 小時，這裡縮成 0.1 秒一次）都沒有待處理就不執行
  const env = { ...process.env, AIGILE_BASE: BASE, AIGILE_TOKEN: '', AIGILE_TOKEN_FILE: `.aigile/${AG}/.token`, AIGILE_ME: ai.participantId, SUPABASE_URL: '', SUPABASE_KEY: '',
    HEARTBEAT_MIN: String(0.1 / 60), WAKE_CMD: `node "${CX}" --agent ${AG} --mode auto`, CODEX_BIN: FAKE, AIGILE_CODEX_BIN: FAKE, FAKE_CODEX_LOG: path.join(wd, 'codex-calls.jsonl'), CODEX_HOME: path.join(wd, 'codex-home'), PID_FILE: path.join(wd, '.aigile', AG, 'watcher.pid'), BELL_FILE: '' };
  for (const n of (await call(tok, '/api/notifications?limit=50')).body.notifications || []) await call(tok, '/api/notifications/ack', 'POST', { notificationIds: [n.notificationId] });
  fs.rmSync(path.join(wd, 'codex-calls.jsonl'), { force: true });
  countCalls = 0;
  const w = spawn(process.execPath, [pub('watcher.mjs')], { cwd: wd, env });
  let wout = ''; w.stdout.on('data', d => { wout += d; }); w.stderr.on('data', d => { wout += d; });
  const until = async (fn, ms, label) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw new Error('等不到：' + label + '\n' + wout.slice(-800)); };
  try {
    await until(() => countCalls >= 97, 60_000, '巡檢 96 次');
    assert.equal(calls(wd).length, 0, `一整天（${countCalls} 次巡檢）沒事：叫醒 0 次`);
    assert.ok(!/喚醒：/.test(wout), 'watcher 日誌沒有喚醒紀錄');
    console.log(`codex-standby-test：一整天沒事 ${countCalls} 次巡檢、叫醒 ${calls(wd).length} 次`);
    // 人類點名時視窗關閉：巡檢記錄待處理通知
    const posted = await call(liu.token, '/api/messages', 'POST', { requestId: 'codex-standby-wake', project: '預設專案', text: '[通知] 測試叫醒', recipientIds: [ai.participantId], replyFrom: [ai.participantId] });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    await until(() => /視窗沒開，等開視窗再處理/.test(wout), 15_000, 'closed window retains the notification');
    assert.equal(calls(wd).length, 0);
    assert.ok(!wout.includes(tok));
  } finally { w.kill(); }

  // 8. 接入設定（Codex 版）與規格
  const ob = async q => (await (await app(new Request(`http://localhost/api/my-ais/${ai.participantId}/onboarding${q}`, { headers: { Authorization: `Bearer ${liu.token}` } }), 'http://localhost')).json()).text;
  const cx = await ob('?tool=codex');
  const sec = cx.slice(cx.indexOf('## 五、待命：Codex'), cx.indexOf('## ', cx.indexOf('## 五、待命：Codex') + 5));
  assert.ok(sec.length > 100, 'Codex 第五節');
  assert.ok(!/aigile-wait\.mjs|前景跑|前景執行|保持進行中/.test(sec), 'Codex 不再前景跑等待腳本：' + sec);
  assert.match(sec, /--tool codex --mode auto/, '預設太長才換新，接入檢查帶 --mode');
  assert.match(sec, /Codex 視窗開著才會處理工作/);
  assert.match(sec, /太長＝同一個對話叫醒滿 10 次，由喚醒腳本數），免得對話越來越長、每次叫醒重讀越來越貴/, '--every 白話說明');
  assert.match(sec, /push、merge、部署不做/, '叫醒那一輪不 push／merge／部署');
  assert.match(sec, /同意 commit（針對第 N 則）.*非背景 codex exec/, '接入設定寫明前景 commit 的範圍');
  assert.match(sec, /codex\.exe 與 node\.exe/, '寫明怎麼確認已停');
  assert.match(sec, /watcher 在跑、日誌有連線或巡檢紀錄才算成功/, '成功判定改成 watcher');
  assert.match(await ob('?tool=codex&convo=fresh'), /--tool codex --mode fresh/);
  assert.ok(!/免得對話越來越長/.test(await ob('?tool=codex&convo=keep')), '一直接續不寫換新');
  for (const q of ['?tool=codex', '?tool=codex&convo=fresh&autoStandby=1']) assert.ok([...await ob(q)].length <= 6500, `Codex 接入設定 ≤ 6,500 字（${q}）`);
  const spec = (fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('../docs/api-reference.md', import.meta.url), 'utf8'));
  assert.match(spec, /Codex 視窗開著才會處理工作/);
  console.log('codex-standby-test：全部通過');
} catch (e) {
  console.error('codex-standby-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  server.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
