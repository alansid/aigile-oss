// 重現測試：接入檢查只印 MCP 指令，AI 讀成「不能跟別人同資料夾並存」而停下；以為腳本會自己裝
// 修正後：--tool claude 時腳本直接裝通用 MCP aigile（使用者範圍，整台電腦一次；已裝跳過、失敗印指令且不中斷）；Codex 寫進 config.toml（先備份）
// 用假的 claude（scripts/fake-claude.mjs）記錄呼叫，絕不動真的 Claude Code 設定
// 用法：node scripts/mcp-install-test.js
import './test-home.mjs'; // 不寫到真的家目錄
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
import { scriptHashes } from './script-hashes.mjs';
import { testToken } from './test-token.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const FAKE = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));
const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-t1-'))); // macOS 的 /var 其實是 /private/var，腳本印的是真實路徑
const db = await openTestDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '10000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const server = http.createServer(async (req, res) => {
  const f = /^\/(watcher|aigile-wait|aigile-setup|aigile-opencode|aigile-mcp|aigile-codex|aigile-codex-ui|aigile-antigravity|aigile-start|aigile-hook)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

try {
  const boss = (await call(null, '/api/join', 'POST', { name: '林志明', role: 'PO' })).body;
  const ai = (await call(boss.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: 'PG', role: 'PG', name: '程式助手', duties: 'x', style: 'x', autonomy: 'x', mustConfirm: 'x', handoff: 'x' })).body;
  const tok = (await testToken(db, ai.participantId));
  const AG = (await call(tok, '/api/me/watcher-env')).body.agent, NAME = 'aigile';
  const HOME = path.join(dataDir, 'home'), CODEX_HOME = path.join(dataDir, 'codexhome'); fs.mkdirSync(CODEX_HOME, { recursive: true }); // 暫存家目錄，不碰真的設定
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  fs.mkdirSync(path.join(wd, '.aigile', AG), { recursive: true });
  fs.writeFileSync(path.join(wd, '.aigile', AG, '.token'), tok);
  const log = path.join(dataDir, 'claude.log');
  const setup = (tool, env = {}) => { fs.rmSync(log, { force: true }); return new Promise(ok => execFile(process.execPath, [pub('aigile-setup.mjs'), '--agent', AG, '--base', BASE, '--tool', tool],
    { cwd: wd, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_HAS: '', FAKE_CLAUDE_FAIL: '', AIGILE_HOME: HOME, CODEX_HOME, AIGILE_CODEX_BIN: fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), ...env } },
    (e, out) => ok({ code: e ? e.code : 0, out, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [] }))); };
  const mcp = path.join(HOME, '.aigile', 'aigile-mcp.mjs').replace(/\\/g, '/'); // 通用轉接腳本放家目錄

  // 1. Claude Code、還沒裝 → 腳本直接裝（通用 aigile、使用者範圍、家目錄的轉接腳本）
  let r = await setup('claude');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, [['mcp', 'get', NAME], ['mcp', 'add', '-s', 'user', NAME, '--', 'node', mcp], ['mcp', 'get', 'aigile-' + AG.toLowerCase()]], '先查再裝：' + JSON.stringify(r.calls));
  assert.match(r.out, /✓ MCP：已幫 Claude Code 裝好通用的 aigile（使用者範圍，整台電腦一次/);
  assert.ok(fs.existsSync(mcp), '轉接腳本複製到家目錄');
  // 2. 已裝 → 跳過、印已裝
  r = await setup('claude', { FAKE_CLAUDE_HAS: NAME });
  assert.deepEqual(r.calls, [['mcp', 'get', NAME], ['mcp', 'get', 'aigile-' + AG.toLowerCase()]], '已裝就不再 add（另查舊名稱還在不在）');
  assert.match(r.out, /✓ MCP：Claude Code 已裝通用的 aigile（整台電腦一次，不重裝）/);
  // 3. 裝失敗 → 印指令讓 AI 手動裝，不中斷（照樣跑完、結束碼 0）
  r = await setup('claude', { FAKE_CLAUDE_FAIL: '1' });
  assert.equal(r.code, 0, '不中斷');
  assert.match(r.out, /! MCP 沒裝成（fake claude: add failed）：請自己執行 /);
  assert.match(r.out, /完成：/, '其他檢查照樣做完');
  // 4. Codex：寫進 config.toml（整台電腦一個，含 env_vars）
  r = await setup('codex');
  assert.equal(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8'), /\[mcp_servers\.aigile\]\ncommand = "node"\nargs = \[".*aigile-mcp\.mjs"\]\nenv_vars = \["AIGILE_AGENT"\]/, 'config.toml 有 [mcp_servers.aigile]');
  const target = path.join(CODEX_HOME, 'config.toml');
  const installed = fs.readFileSync(target, 'utf8');
  const toolHeader = '[mcp_servers.aigile.tools.aigile_read]';
  assert.ok(installed.includes(toolHeader));
  const oldConfig = installed.replace(toolHeader + '\napproval_mode = "approve"\n', '')
    .replace('[mcp_servers.aigile.tools.aigile_me]\napproval_mode = "approve"', '[mcp_servers.aigile.tools.aigile_me]\napproval_mode = "prompt"');
  fs.writeFileSync(target, oldConfig);
  r = await setup('codex');
  assert.equal(r.code, 0, r.out);
  const upgraded = fs.readFileSync(target, 'utf8');
  assert.ok(upgraded.includes(toolHeader));
  assert.ok(upgraded.includes('[mcp_servers.aigile.tools.aigile_me]\napproval_mode = "prompt"'));
  assert.ok(fs.readdirSync(path.dirname(target)).filter(n => n.startsWith('config.toml.aigile-bak-'))
    .some(n => fs.readFileSync(path.join(path.dirname(target), n), 'utf8') === oldConfig));
  console.log('mcp-install-test：全部通過');
} catch (e) {
  console.error('mcp-install-test 失敗：', e.message);
  process.exitCode = 1;
} finally {
  server.close();
  db.close?.();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
