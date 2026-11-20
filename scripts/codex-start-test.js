// 驗收測試：一行啟動選 Codex 也在前景開 codex 做接入；前景開著時背景執行完整工作回合
// 1. 網頁給的 Codex 一行啟動實際執行：最後開 codex（互動模式）帶入接入提示（簽到、aigile_me、「接好了，可以關掉…」），環境帶 AIGILE_AGENT、沙盒只開網路
// 2. 前景 codex 開著時有 foreground.lock（內容是一行啟動的程序），關掉就刪
// 3. Codex 喚醒腳本：前景鎖的程序還在 → 提醒先檢查工作樹；程序不在 → 清掉舊鎖照常跑；已有一輪在跑 → 不再開
// 4. 前景重接時收到點名 → 背景執行工作回合
// 5. Windows 沒設 Codex 沙盒 → 接入檢查印清楚、不幫忙改
// 全部用暫存資料夾、假的 codex／claude、暫存 CODEX_HOME（不動真的 ~/.codex）；測試開的 watcher 用 pid 停
// 用法：node scripts/codex-start-test.js
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
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p325-'));
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '10000' } });
let loseCheckinResponse = true;
const server = http.createServer(async (req, res) => {
  const f = /^\/(watcher|aigile-wait|aigile-setup|aigile-opencode|aigile-mcp|aigile-codex|aigile-codex-ui|aigile-start|aigile-hook)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  if (loseCheckinResponse && req.method === 'POST' && req.url === '/api/messages' && r.ok) {
    loseCheckinResponse = false;
    res.writeHead(503); res.end(); return;
  }
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const api = async (token, p, method = 'GET', body) => {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const tokenOf = async id => await testToken(db, id);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const testPids = new Set();
// 假的 codex：記下參數、AIGILE_AGENT、當下前景鎖在不在；mcp get 成功，其他（互動、exec）結束碼 0
const CXLOG = path.join(dataDir, 'codex.log');
const FAKE_CX = path.join(dataDir, 'fake-codex.mjs');
fs.writeFileSync(FAKE_CX, `import fs from 'node:fs';
const a = process.argv.slice(2);
if (a.includes('app-server')) {
  if (process.env.FAKE_APP_SERVER_HANG) setInterval(() => {}, 1000);
  else process.exit(2); // emulate an older CLI
  await new Promise(() => {});
}
const lock = process.env.FAKE_LOCK_FILE && fs.existsSync(process.env.FAKE_LOCK_FILE) ? fs.readFileSync(process.env.FAKE_LOCK_FILE, 'utf8').trim() : '';
fs.appendFileSync(${JSON.stringify(CXLOG)}, JSON.stringify({ args: a, agent: process.env.AIGILE_AGENT || '', lock }) + '\\n');
if (a[0] === '-c' && process.env.FAKE_FG_RELEASE) {
  while (!fs.existsSync(process.env.FAKE_FG_RELEASE)) await new Promise(resolve => setTimeout(resolve, 50));
}
process.exit(0);
`);
const FAKE_CL = path.join(dataDir, 'fake-claude.mjs');
fs.writeFileSync(FAKE_CL, "process.exit(process.argv[2] === 'mcp' && process.argv[3] === 'get' ? 1 : 0);\n");
const calls = () => (fs.existsSync(CXLOG) ? fs.readFileSync(CXLOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const runNode = (args, cwd, env = {}) => new Promise(ok => execFile(process.execPath, args, { cwd, timeout: 180_000, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_AGENT: '', AIGILE_CLAUDE_BIN: FAKE_CL, AIGILE_CODEX_BIN: FAKE_CX, CODEX_BIN: `node "${FAKE_CX}"`, ...env } },
  (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out) + String(err) })));

try {
  const boss = (await api(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const r0 = ROLES.find(x => x.key === 'PG');
  const ai = (await api(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: r0.role, name: '程式助手', duties: r0.duties, style: r0.style, autonomy: r0.autonomy, mustConfirm: r0.mustConfirm, handoff: r0.handoff })).body;
  const tok = await tokenOf(ai.participantId);
  const AG = (await api(tok, '/api/me/watcher-env')).body.agent;
  const other = (await api(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'QA', role: 'QA', name: '品質助手', duties: 'd', style: 's', autonomy: 'a', mustConfirm: 'm', handoff: 'h' })).body;
  const otherTok = await tokenOf(other.participantId);

  // 1～2. 網頁給的 Codex 一行啟動
  const link = (await api(boss.token, `/api/my-ais/${ai.participantId}/onboarding-link`, 'POST', { tool: 'codex', autoStandby: true, start: true })).body;
  assert.ok(link.startLine, 'Codex 也有一行啟動');
  const code = link.startLine.slice('node -e "'.length, -1);
  assert.match(code, /'--tool','codex'/);
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  const D = path.join(wd, '.aigile', AG);
  const LOCK = path.join(D, 'foreground.lock');
  const interrupted = await runNode(['-e', code], wd, { FAKE_LOCK_FILE: LOCK });
  assert.equal(interrupted.code, 1);
  assert.match(interrupted.out, /HTTP 503/);
  const initialState = JSON.parse(fs.readFileSync(path.join(D, 'state.json'), 'utf8'));
  let r = await runNode(['-e', code], wd, { FAKE_LOCK_FILE: LOCK, HEARTBEAT_MIN: '0.02', FAKE_APP_SERVER_HANG: '1' });
  const readPid = () => { try { return Number(fs.readFileSync(path.join(D, 'watcher.pid'), 'utf8').trim()) || 0; } catch { return 0; } };
  for (let i = 0; i < 50 && !readPid(); i++) await new Promise(ok => setTimeout(ok, 200));
  testPids.add(readPid());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /App Server startup timeout/);
  assert.ok(!fs.existsSync(path.join(D, 'foreground-ui.json')));
  assert.match(r.out, /✓ watcher 已在背景啟動/, 'watcher 照舊在背景');
  const fg = calls().find(c => c.args[0] !== 'mcp' && c.args[0] !== 'exec');
  assert.ok(fg, '有在前景開 codex：' + JSON.stringify(calls()));
  assert.equal(fg.agent, AG, '帶 AIGILE_AGENT');
  assert.deepEqual(fg.args.slice(0, 4), ['-c', 'sandbox_mode=workspace-write', '-c', 'sandbox_workspace_write.network_access=true'], '沙盒只開網路（不開完全權限）');
  const prompt = fg.args[fg.args.length - 1];
  assert.match(prompt, /已完成首次簽到/);
  const checkins = () => db.get('SELECT COUNT(*) AS n FROM messages WHERE author_id = ? AND request_id = ?', ai.participantId, 'req_checkin_' + ai.participantId);
  assert.equal((await checkins()).n, 1, '啟動器負責簽到，模型不必先核准讀檔');
  const cursor = JSON.parse(fs.readFileSync(path.join(D, 'state.json'), 'utf8')).messagesCursor;
  assert.ok(cursor);
  assert.equal(cursor, initialState.messagesCursor, '重試保留原本的基準');
  const installedToken = fs.readFileSync(path.join(D, '.token'), 'utf8').trim();
  assert.equal((await api(installedToken, '/api/me/state')).body.state.messagesCursor, cursor);
  assert.match(prompt, /呼叫 MCP 工具 aigile_me 確認 MCP 能用/, '確認 MCP 能用');
  assert.match(prompt, /「接好了，可以關掉，之後有事會在背景叫我」/, '最後告訴人可以關掉');
  assert.ok(!/aigile-wait\.mjs/.test(prompt), 'Codex 不開等待腳本');
  assert.ok(!prompt.includes(tok), '提示不含 Token');
  assert.ok(Number(fg.lock) > 0, '前景 codex 開著時有 foreground.lock：' + fg.lock);
  assert.ok(!fs.existsSync(LOCK), '關掉就刪 foreground.lock');
  assert.match(r.out, /✓ Codex 已關，watcher 會在背景處理待處理通知/);
  assert.ok(!calls().some(c => c.args[0] === 'exec'), '沒待處理：不補跑');
  console.log('✓ 1～2 Codex 一行啟動在前景開 codex，開著時有鎖');

  // 3. Codex 喚醒腳本看前景鎖
  const wakeCx = env => runNode([path.join(wd, '.aigile', 'watcher', 'aigile-codex.mjs'), '--agent', AG, '--mode', 'fresh'], wd, env);
  fs.rmSync(CXLOG, { force: true });
  fs.writeFileSync(LOCK, String(process.pid)); // 測試自己當「前景還開著」
  r = await wakeCx();
  assert.equal(r.code, 0);
  assert.ok(calls().some(c => c.args.includes('sandbox_mode=workspace-write')));
  fs.writeFileSync(LOCK, '999999'); // 程序已不在
  r = await wakeCx();
  assert.ok(calls().some(c => c.args[0] === 'exec'), '前景鎖的程序不在：照常叫 codex exec');
  assert.ok(!fs.existsSync(LOCK), '舊鎖清掉');
  assert.ok(!fs.existsSync(path.join(D, 'codex-run.lock')), '跑完刪掉自己的執行鎖');
  fs.rmSync(CXLOG, { force: true });
  fs.writeFileSync(path.join(D, 'codex-run.lock'), String(process.pid)); // 已有一輪在跑
  r = await wakeCx();
  assert.equal(calls().length, 0, '已有一輪在跑：不再開');
  assert.match(fs.readFileSync(path.join(D, 'wake.log'), 'utf8'), /已有一輪在跑（程序 \d+），這次不再開/);
  fs.rmSync(path.join(D, 'codex-run.lock'));
  console.log('✓ 3 前景開著使用可寫 codex exec、一次只跑一輪');

  // 4. 前景重接時收到點名 → 背景執行工作回合（重開機貼同一行＝重新接上）
  fs.rmSync(CXLOG, { force: true });
  const release = path.join(wd, 'release-foreground');
  const reconnect = runNode(['-e', code], wd, { FAKE_LOCK_FILE: LOCK, FAKE_FG_RELEASE: release });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(LOCK); i++) await new Promise(ok => setTimeout(ok, 100));
    assert.ok(fs.existsSync(LOCK), '重接時前景已就緒');
    await api(otherTok, '/api/messages', 'POST', { project: '預設專案', requestId: 'p325-1', text: '[需確認] 看一下\n\n問題1：好嗎？\n選項：\nA. 好\nB. 不好', recipientIds: [ai.participantId], replyFrom: [ai.participantId] });
    const replied = () => calls().some(c => c.args.includes('sandbox_mode=workspace-write'));
    for (let i = 0; i < 100 && !replied(); i++) await new Promise(ok => setTimeout(ok, 100));
    assert.ok(replied(), '前景開啟時背景收到點名');
  } finally {
    fs.writeFileSync(release, '');
    r = await reconnect;
  }
  assert.equal(r.code, 0, r.out);
  const fg2 = calls().find(c => c.args[0] !== 'mcp' && c.args[0] !== 'exec');
  assert.match(fg2.args[fg2.args.length - 1], new RegExp(`照 \\.aigile/${AG}/reconnect\\.md 重新接上（不要重新簽到`), '第二次：重新接上、不再簽到');
  for (let i = 0; i < 50 && !calls().some(c => c.args[0] === 'exec'); i++) await new Promise(ok => setTimeout(ok, 200));
  assert.ok(calls().some(c => c.args[0] === 'exec' && c.agent === AG), '背景補跑叫了 codex exec');
  assert.ok(!fs.existsSync(LOCK));
  console.log('✓ 4 前景重接時背景執行工作回合');
  assert.equal((await checkins()).n, 1, '重接不會重複簽到');

  // 5. Windows 沒設 Codex 沙盒 → 印清楚、不幫忙改
  const cxHome = fs.mkdtempSync(path.join(dataDir, 'cxh-'));
  const setup = env => runNode([pub('aigile-setup.mjs'), '--agent', AG, '--base', BASE, '--tool', 'codex'], wd, { CODEX_HOME: cxHome, AIGILE_SETUP_FAKE_WIN: '1', ...env });
  fs.writeFileSync(path.join(cxHome, 'config.toml'), 'model = "x"\n');
  r = await setup();
  assert.match(r.out, /! Codex 沙盒（Windows）：.*沒看到 \[windows\] 底下的 sandbox 設定.*接入檢查不會幫你改/, r.out);
  assert.ok(!/^\s*\[windows\]/m.test(fs.readFileSync(path.join(cxHome, 'config.toml'), 'utf8')), '不幫忙改沙盒設定');
  fs.writeFileSync(path.join(cxHome, 'config.toml'), 'model = "x"\n\n[windows]\nsandbox = "elevated"\n');
  r = await setup();
  assert.ok(!/Codex 沙盒（Windows）/.test(r.out), '設了就不提');
  assert.ok(!fs.existsSync(path.join(os.homedir(), '.codex', 'config.toml')) || !fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8').includes(dataDir.replace(/\\/g, '/')), '沒動到真的 Codex 設定');
  console.log('✓ 5 Windows 沙盒沒設：印清楚、不改');

  // 規格
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  assert.match(spec, /Codex 也在前景開一次/, '規格寫 Codex 一行啟動');
  console.log('codex-start-test：全部通過');
} catch (e) {
  console.error('codex-start-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('codex-start-test.js')) || '');
  process.exitCode = 1;
} finally {
  for (const pid of testPids) { try { if (pid > 0 && alive(pid)) process.kill(pid); } catch {} }
  server.close();
  db.close?.();
  await new Promise(ok => setTimeout(ok, 500));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
