// 驗收測試：已簽到的 AI 重複貼一行啟動不掛掉
// 1. 同一隻 AI 重複貼一行啟動（含已簽到過且換工具／不同簽到文字）：不回 409、不卡 pendingCheckin、exit 0
// 2. 貼到已用過／失效（410／409）的連結：印白話提示與下一步（「請所屬人類在網頁「我的 AI」重新複製一行啟動」），不爆錯
// 3. Token 重發或過期＋watcher 執行中：重新貼一行啟動自動換新 Token、停舊 watcher、開新 watcher
// 4. 空的 foreground.lock 不永久卡死；非簽到 requestId 內容不同仍回 409（不破壞一般冪等檢查）
// 用法：node scripts/start-repeat-test.js
import { stopServer } from './test-process.js';
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { ROLES } from '../src/roles.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p466-oss-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '10000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j, text };
};
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/setup/force-409') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { code: 'CONFLICT', message: 'already onboarded' } }));
  }
  const f = /^\/(watcher|aigile-wait|aigile-setup|aigile-opencode|aigile-mcp|aigile-codex|aigile-codex-ui|aigile-antigravity|aigile-start|aigile-hook)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const killPid = pid => { try { if (pid > 0) process.kill(pid); } catch {} };
const alive = pid => { if (!(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const pids = [];

const FAKE_BIN = path.join(dataDir, 'fake-cli.mjs');
fs.writeFileSync(FAKE_BIN, 'process.exit(0);\n');

const runStart = (args, cwd, extraEnv = {}) => new Promise(ok => {
  execFile(process.execPath, [pub('aigile-start.mjs'), ...args], {
    cwd,
    timeout: 120_000,
    env: {
      ...process.env,
      AIGILE_BASE: '',
      AIGILE_TOKEN: '',
      AIGILE_AGENT: '',
      AIGILE_CLAUDE_BIN: FAKE_BIN,
      AIGILE_CODEX_BIN: FAKE_BIN,
      AIGILE_ANTIGRAVITY_BIN: FAKE_BIN,
      ...extraEnv,
    },
  }, (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out) + String(err) }));
});

const readWatcherPid = (wd, agent) => {
  const f = path.join(wd, '.aigile', agent, 'watcher.pid');
  try { return Number(fs.readFileSync(f, 'utf8').trim()); } catch { return 0; }
};
const waitWatcherPid = async (wd, agent, notPid = 0) => {
  for (let i = 0; i < 40; i++) {
    const p = readWatcherPid(wd, agent);
    if (p > 0 && p !== notPid && alive(p)) { pids.push(p); return p; }
    await new Promise(r => setTimeout(r, 150));
  }
  return 0;
};

try {
  const human = (await call(null, '/api/join', 'POST', { name: '測試人', role: 'PO' })).body;
  const rPg = ROLES.find(x => x.key === 'PG');
  const ai = (await call(human.token, '/api/my-ais', 'POST', {
    projects: ['預設專案'], roleKey: 'PG', role: rPg.role, name: '重複啟動測試',
    duties: rPg.duties, style: rPg.style, autonomy: rPg.autonomy, mustConfirm: rPg.mustConfirm, handoff: rPg.handoff,
  })).body;
  const tok1 = await testToken(db, ai.participantId);
  const agent = (await call(tok1, '/api/me/watcher-env')).body.agent;

  // 1. 伺服器冪等：已簽到過（不同文字）再送 req_checkin_<id> 不回 409；一般 requestId 仍回 409
  const c1 = await call(tok1, '/api/messages', 'POST', { project: '預設專案', requestId: 'req_checkin_' + ai.participantId, text: '[AI 簽到] 第一次用 Claude 簽到。' });
  assert.equal(c1.status, 201, JSON.stringify(c1));
  const c2 = await call(tok1, '/api/messages', 'POST', { project: '預設專案', requestId: 'req_checkin_' + ai.participantId, text: '[AI 簽到] 第二次改用 Antigravity 簽到。' });
  assert.equal(c2.status, 200, '已簽到過再送不同文字的 req_checkin 不應 409：' + JSON.stringify(c2));
  assert.equal(c2.body.messageId, c1.body.messageId, '沿用原本那筆簽到訊息');

  const n1 = await call(tok1, '/api/messages', 'POST', { project: '預設專案', requestId: 'req_normal_1', text: '第一則' });
  assert.equal(n1.status, 201);
  const n2 = await call(tok1, '/api/messages', 'POST', { project: '預設專案', requestId: 'req_normal_1', text: '不同內容' });
  assert.equal(n2.status, 409, '一般 requestId 內容不同仍應回 409');
  console.log('✓ 1 伺服器 req_checkin 冪等不回 409，一般 requestId 仍擋衝突');

  // 2. 同一隻已簽到的 AI：首次用一行啟動（帶 pendingCheckin）＋第二次重貼同一行，且空的 foreground.lock 不會卡死
  const wd = fs.mkdtempSync(path.join(dataDir, 'wd-'));
  const link1 = (await call(human.token, `/api/my-ais/${ai.participantId}/onboarding-link`, 'POST', { tool: 'antigravity', start: true })).body;
  assert.ok(link1.url, JSON.stringify(link1));
  // 模擬先前留下空的 foreground.lock 與待簽到檔
  fs.mkdirSync(path.join(wd, '.aigile', agent), { recursive: true });
  fs.writeFileSync(path.join(wd, '.aigile', agent, 'foreground.lock'), '');
  fs.writeFileSync(path.join(wd, '.aigile', agent, 'antigravity-checkin.pending'), agent);

  const run1 = await runStart(['--agent', agent, '--base', BASE, '--setup', link1.url.replace('http://localhost', BASE), '--tool', 'antigravity'], wd);
  assert.equal(run1.code, 0, '已簽到的 AI 第一次貼一行啟動應成功：\n' + run1.out);
  assert.ok(!fs.existsSync(path.join(wd, '.aigile', agent, 'antigravity-checkin.pending')), 'pendingCheckin 應被清掉');
  const wpid1 = await waitWatcherPid(wd, agent);
  assert.ok(wpid1 > 0, 'watcher 應已啟動');

  // 立刻再貼「同一行」（裡面的 link1.url 已被用過，但本機 .token 有效）
  const run2 = await runStart(['--agent', agent, '--base', BASE, '--setup', link1.url.replace('http://localhost', BASE), '--tool', 'antigravity'], wd);
  assert.equal(run2.code, 0, '第二次貼同一行應成功接回：\n' + run2.out);
  assert.match(run2.out, /watcher 已在執行/, '第二次貼同一行應沿用同一個 watcher：\n' + run2.out);
  console.log('✓ 2 已簽到 AI 連續貼兩次一行啟動皆成功，空 foreground.lock 不卡死');

  // 3. 貼到已用過（410）與 409 的連結（本機沒有 .token）：印白話提示與下一步
  const wdGone = fs.mkdtempSync(path.join(dataDir, 'wd-gone-'));
  const runGone = await runStart(['--agent', agent, '--base', BASE, '--setup', link1.url.replace('http://localhost', BASE), '--tool', 'claude', '--no-launch'], wdGone);
  assert.equal(runGone.code, 1, '已用過的連結在沒有 .token 時應結束碼 1');
  assert.match(runGone.out, /已失效或已用過/, '應印白話說明：\n' + runGone.out);
  assert.match(runGone.out, /重新複製一行啟動/, '應印下一步：\n' + runGone.out);

  const run409 = await runStart(['--agent', agent, '--base', BASE, '--setup', `${BASE}/api/setup/force-409`, '--tool', 'claude', '--no-launch'], wdGone);
  assert.equal(run409.code, 1);
  assert.match(run409.out, /已失效或已用過/, '409 也印白話說明：\n' + run409.out);
  console.log('✓ 3 已用過／失效（410／409）連結印白話提示與下一步');

  // 4. Token 過期後直接產一次性連結，重貼新的一行啟動：自動換新 Token、停掉舊 watcher、啟動新 watcher
  await db.run('UPDATE participants SET token_expires_at = ? WHERE id = ?', Date.now() - 60_000, ai.participantId);
  const link2Res = await call(human.token, `/api/my-ais/${ai.participantId}/onboarding-link`, 'POST', { tool: 'antigravity', start: true });
  assert.equal(link2Res.status, 200, 'Token 過期也能產生一次性連結：' + JSON.stringify(link2Res));
  const link2 = link2Res.body;

  const oldTok = fs.readFileSync(path.join(wd, '.aigile', agent, '.token'), 'utf8').trim();
  const run3 = await runStart(['--agent', agent, '--base', BASE, '--setup', link2.url.replace('http://localhost', BASE), '--tool', 'antigravity'], wd);
  assert.equal(run3.code, 0, 'Token 重發後重貼新一行應成功：\n' + run3.out);
  const newTok = fs.readFileSync(path.join(wd, '.aigile', agent, '.token'), 'utf8').trim();
  assert.notEqual(newTok, oldTok, '.token 應已換成新的');
  assert.match(run3.out, /已換新 Token，停止舊 watcher/, '應印出停舊 watcher 並重啟：\n' + run3.out);
  const wpid2 = await waitWatcherPid(wd, agent, wpid1);
  assert.ok(wpid2 > 0 && wpid2 !== wpid1, `應啟動新 watcher（舊 ${wpid1}，新 ${wpid2}）`);
  console.log('✓ 4 Token 重發後重貼一行啟動：換新 Token 並重啟 watcher');

  console.log('start-repeat-test：全部通過');
} finally {
  for (const p of pids) killPid(p);
  await stopServer(server);
  await db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
