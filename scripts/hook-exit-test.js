// 驗收測試：Windows 上 hook 打過網路後不能 process.exit（Node 24 間歇觸發 libuv 斷言、結束碼 127，Claude Code 丟掉輸出）
// 1. 原始碼：aigile-hook.mjs 一個 process.exit 都沒有；aigile-wait.mjs 打過網路後的結束（UNAUTHORIZED、NETWORK_ERROR）改設 exitCode；
//    aigile-mcp.mjs 關閉時不馬上 exit；watcher 收到停止訊號稍等再結束
// 2. 實跑：hook session（/clear）連跑 N 次（預設 20，HOOK_RUNS 可改），每次結束碼都是 0、輸出完整（含整份重新接上設定）
// 3. 實跑：hook stop 與 compact 也是 0；等待腳本 Token 失效時結束碼是 20（UNAUTHORIZED），不是 127
// 用法：node scripts/hook-exit-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openTestDb } from './test-db.js';
import { dbStorage } from '../src/storage-db.js';
import { ROLES } from '../src/roles.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const RUNS = Math.max(1, Number(process.env.HOOK_RUNS) || 20);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p326-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '10000' } });
const server = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const api = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
// 照 Claude Code 的方式跑 hook：stdin 寫一則 JSON 就關，收 stdout／stderr、結束碼
const hook = (file, mode, input, cwd) => new Promise(ok => {
  const p = spawn(process.execPath, [file, mode], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, AIGILE_AGENT: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
  p.on('close', code => ok({ code, out, err }));
  p.stdin.end(JSON.stringify(input));
});

try {
  // 1. 原始碼
  const src = f => fs.readFileSync(pub(f), 'utf8');
  const hookSrc = src('aigile-hook.mjs');
  assert.ok(!/process\.exit\(/.test(hookSrc), 'aigile-hook.mjs 不呼叫 process.exit');
  assert.match(hookSrc, /process\.exitCode = 0;/);
  const waitSrc = src('aigile-wait.mjs');
  assert.match(waitSrc, /const finish = \(line, code\) => \{ if \(ending\) return; ending = true; for \(const h of handles\) \{ clearInterval\(h\); h\?\.close\?\.\(\); \} console\.log\(line\); process\.exitCode = code; \};/, 'wait 的 finish 改設 exitCode');
  assert.equal((waitSrc.match(/process\.exit\(/g) || []).length, 2, 'wait 只剩打網路之前的 CONFIG_ERROR、ALREADY_RUNNING用 process.exit');
  assert.ok(waitSrc.indexOf("process.exit(50)") < waitSrc.indexOf("await fetch(`${BASE}/api/me/online`"), 'ALREADY_RUNNING 在第一次打網路之前');
  assert.match(src('aigile-mcp.mjs'), /process\.exitCode = 0; setTimeout\(\(\) => process\.exit\(0\), 5000\)\.unref/, 'MCP 關閉時先自然結束');
  assert.match(src('watcher.mjs'), /setTimeout\(\(\) => process\.exit\(0\), 300\)/, 'watcher 停止時稍等再結束');
  console.log('✓ 1 原始碼：打過網路後不馬上 process.exit');

  // 準備一隻 AI 的工作資料夾
  const liu = (await api(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const r0 = ROLES.find(x => x.key === 'PG');
  const ai = (await api(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: r0.role, name: '程式助手', duties: r0.duties, style: r0.style, autonomy: r0.autonomy, mustConfirm: r0.mustConfirm, handoff: r0.handoff })).body;
  const tok = await testToken(db, ai.participantId);
  await api(tok, '/api/me/state', 'PUT', { currentTask: { title: 'x' } }); // 有工作記憶＝重新接上
  const AG = (await api(tok, '/api/me/watcher-env')).body.agent;
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  const D = path.join(wd, '.aigile', AG);
  fs.mkdirSync(D, { recursive: true });
  fs.writeFileSync(path.join(D, '.token'), tok);
  fs.writeFileSync(path.join(D, 'watcher.env'), `AIGILE_BASE=${BASE}\nSKILL_TOOL=claude\n`);
  const full = (await fetch(`${BASE}/api/me/reconnect?tool=claude`, { headers: { Authorization: `Bearer ${tok}` } }).then(r => r.text()));
  assert.ok(full.length > 3000, '重新接上設定有內容');

  // 2. session 連跑 RUNS 次
  const codes = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await hook(process.env.HOOK_SCRIPT || pub('aigile-hook.mjs'), 'session', { source: 'clear', hook_event_name: 'SessionStart' }, wd); // HOOK_SCRIPT：拿舊版對照用
    codes.push(r.code);
    assert.equal(r.code, 0, `第 ${i + 1} 次結束碼 ${r.code}：${r.err.slice(0, 300)}`);
    assert.ok(r.out.includes(full.trim().slice(-200)), `第 ${i + 1} 次輸出完整（${r.out.length} 字）`);
    assert.ok(!/Assertion failed/.test(r.err), `第 ${i + 1} 次沒有 libuv 斷言`);
  }
  console.log(`✓ 2 hook session 連跑 ${RUNS} 次：結束碼都是 0、輸出完整（${codes.join('')}）`);

  // 3. stop、compact、等待腳本 401
  fs.writeFileSync(path.join(D, 'watcher.pid'), String(process.pid));
  let r = await hook(pub('aigile-hook.mjs'), 'stop', {}, wd);
  assert.equal(r.code, 0); assert.equal(JSON.parse(r.out).decision, 'block', 'stop：等待腳本不在擋一次');
  r = await hook(pub('aigile-hook.mjs'), 'stop', {}, wd);
  assert.equal(r.code, 0); assert.equal(r.out.trim(), '', '只提醒一次');
  r = await hook(pub('aigile-hook.mjs'), 'session', { source: 'compact' }, wd);
  assert.equal(r.code, 0); assert.match(r.out, /對話剛壓縮/);
  r = await hook(pub('aigile-hook.mjs'), 'session', { source: 'clear' }, fs.mkdtempSync(path.join(dataDir, 'none-')));
  assert.equal(r.code, 0); assert.equal(r.out, '', '沒接平台：不做事、結束碼 0');
  fs.writeFileSync(path.join(D, '.token'), 'bad-token-xxxxxxxxxxxx');
  r = await new Promise(ok => execFile(process.execPath, [pub('aigile-wait.mjs'), '--agent', AG], { cwd: wd, timeout: 60_000, env: { ...process.env, AIGILE_BASE: BASE, AIGILE_TOKEN: '' } }, (e, out, err) => ok({ code: e ? e.code : 0, out: String(out), err: String(err) })));
  assert.equal(r.code, 20, `等待腳本 Token 失效：結束碼 20（UNAUTHORIZED），不是 127：${r.code} ${r.err.slice(0, 200)}`);
  assert.match(r.out, /UNAUTHORIZED/);
  assert.ok(!fs.existsSync(path.join(D, 'wait.pid')), '結束時刪掉 wait.pid');
  console.log('✓ 3 stop、compact、等待腳本 401 的結束碼都對');
  console.log('hook-exit-test：全部通過');
} catch (e) {
  console.error('hook-exit-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('hook-exit-test.js')) || '');
  process.exitCode = 1;
} finally {
  server.close();
  db.close?.();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
