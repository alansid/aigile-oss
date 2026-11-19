// 驗收測試：通用 MCP＋一行啟動＋/clear 自動接回＋回合結束檢查等待腳本
// 1. 通用 MCP（aigile-mcp.mjs 不帶 --agent）：資料夾只有一隻 AI → 直接是它；兩隻 → 只給 aigile_use，選了送 tools/list_changed；AIGILE_AGENT 優先
// 2. 工具由伺服器依 Token 角色給（試用者沒有改卡、交接）
// 3. GET /api/me/reconnect：AI 自己拿「重新接上」設定，不含 Token；人類 403
// 4. hook：session 印重新接上設定；stop 等待腳本不在擋一次、只提醒一次、stop_hook_active 不擋、等待腳本在就不擋
// 5. 接入檢查 --tool claude 寫 .claude/settings.local.json 的 hook（不重複、保留原本設定）
// 6. 一行啟動：網頁給的那一行實際執行（下載核對、存 Token、接入檢查、背景 watcher、帶 AIGILE_AGENT 開 claude）；第二次貼同一行就接回
// 7. 等待腳本寫 wait.pid、結束時刪掉
// 全部用暫存資料夾、假的 claude（不動真的 Claude Code 設定、不寫真的家目錄）；測試開的 watcher 用 pid 停
// 用法：node scripts/one-line-start-test.js
import './test-home.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/core.js';
import { openNodeDb } from '../src/db-node.js';
import { dbStorage } from '../src/storage-db.js';
import { ROLES } from '../src/roles.js';
import { scriptHashes } from './script-hashes.mjs';
import { testToken, hashOf } from './test-token.js';

const pub = f => fileURLToPath(new URL('../public/' + f, import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigile-p323-'));
const REQ_LOG = path.join(dataDir, 'requests.log'); // 測試伺服器收到的每個網址
fs.writeFileSync(REQ_LOG, '');
const db = openNodeDb(path.join(dataDir, 'switch.db'));
const app = createApp({ db, storage: dbStorage(db), docText: '', scriptHashes: scriptHashes(), config: { openJoin: '1', rateLimitPerMin: '10000' } });
const call = async (token, p, method = 'GET', body) => {
  const r = await app(new Request('http://localhost' + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }), 'http://localhost');
  const text = await r.text();
  let j = {}; try { j = JSON.parse(text); } catch {}
  return { status: r.status, body: j, text };
};
let mcpHits = 0; // 打到 /api/mcp 的次數（驗「沒接平台就不打網路」）
const server = http.createServer(async (req, res) => {
  if (req.url === '/api/mcp') mcpHits++;
  fs.appendFileSync(REQ_LOG, req.url + String.fromCharCode(10));
  const f = /^\/(watcher|aigile-wait|aigile-setup|aigile-opencode|aigile-mcp|aigile-codex|aigile-codex-ui|aigile-start|aigile-hook)\.mjs$/.exec(req.url);
  if (f) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(pub(f[0].slice(1)))); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const base = `http://${req.headers.host}`;
  const r = await app(new Request(new URL(req.url, base), { method: req.method, headers: req.headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), base);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const tokenOf = async id => await testToken(db, id);
const killPid = pid => { try { if (pid > 0) process.kill(pid); } catch {} };
const testPids = [];
// 假的 claude：記下參數與 AIGILE_AGENT；mcp get 一律「沒裝」、mcp add 成功
const FAKE = path.join(dataDir, 'fake-claude.mjs');
const FAKE_LOG = path.join(dataDir, 'claude.log');
fs.writeFileSync(FAKE, `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(FAKE_LOG)}, JSON.stringify({ args: process.argv.slice(2), agent: process.env.AIGILE_AGENT || '', cwd: process.cwd() }) + '\\n');\nprocess.exit(process.argv[2] === 'mcp' && process.argv[3] === 'get' ? 1 : 0);\n`);
const fakeCalls = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
const run = (file, args, { cwd, env = {}, input } = {}) => new Promise(ok => {
  const p = execFile(process.execPath, [file, ...args], { cwd, timeout: 120_000, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_AGENT: '', CLAUDE_PROJECT_DIR: '', AIGILE_CLAUDE_BIN: FAKE, ...env } },
    (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out), err: String(err) }));
  if (input !== undefined) { p.stdin.end(input); }
});

// 開一支通用 MCP 轉接，回傳 rpc(method, params) 與收到的通知
function bridge(cwd, env = {}) {
  const p = spawn(process.execPath, [pub('aigile-mcp.mjs')], { cwd, env: { ...process.env, AIGILE_AGENT: '', AIGILE_DIR: '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '', id = 0;
  const waiting = new Map(), notes = [];
  p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l); if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } else notes.push(m); } });
  let err = ''; p.stderr.on('data', d => (err += d));
  const rpc = (method, params) => new Promise((ok, no) => { const n = ++id; waiting.set(n, ok); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, ...(params ? { params } : {}) }) + '\n'); setTimeout(() => no(new Error(`${method} 逾時；stderr：${err}`)), 20_000).unref(); });
  return { rpc, notes, close: () => p.stdin.end(), err: () => err };
}
// 一行啟動：照網頁給的那一行，用 node -e 跑（stdout、stderr 一起收）
const runLine = (cwd, env) => new Promise(ok => execFile(process.execPath, ['-e', globalThis.__line], { cwd, timeout: 180_000, env: { ...process.env, ...env } }, (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out) + String(err) })));
const toolText = r => r.result?.content?.[0]?.text || '';
const mkWork = (agents, base = BASE) => {
  const wd = fs.mkdtempSync(path.join(dataDir, 'w-'));
  for (const [ag, tok] of agents) { fs.mkdirSync(path.join(wd, '.aigile', ag), { recursive: true }); fs.writeFileSync(path.join(wd, '.aigile', ag, '.token'), tok); fs.writeFileSync(path.join(wd, '.aigile', ag, 'watcher.env'), `AIGILE_BASE=${base}\n`); }
  return wd;
};

try {
  const liu = (await call(null, '/api/join', 'POST', { name: '王大明', role: 'PO' })).body;
  const mkAi = async (key, name) => {
    const r = ROLES.find(x => x.key === key);
    const a = (await call(liu.token, '/api/my-ais', 'POST', { projects: ['預設專案'], roleKey: key, role: r.role, name, duties: r.duties, style: r.style, autonomy: r.autonomy, mustConfirm: r.mustConfirm, handoff: r.handoff })).body;
    assert.ok(a.participantId, JSON.stringify(a));
    const tok = await tokenOf(a.participantId);
    return { id: a.participantId, tok, agent: (await call(tok, '/api/me/watcher-env')).body.agent };
  };
  const pg = await mkAi('PG', '程式助手');
  const qa = await mkAi('QA', '品質助手');
  const tr = await mkAi('TRY', '試用助手');

  // 1. 通用 MCP：只有一隻 AI
  let b = bridge(mkWork([[pg.agent, pg.tok]]));
  let r = await b.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(r.result.capabilities.tools.listChanged, true, '通用版宣告會換工具清單');
  r = await b.rpc('tools/list');
  const names = r.result.tools.map(t => t.name);
  assert.ok(names.includes('aigile_inbox') && names.includes('aigile_card_update'), '資料夾只有一隻 AI：直接給它的工具');
  assert.ok(!names.includes('aigile_use'), '只有一隻就不用 aigile_use');
  r = await b.rpc('tools/call', { name: 'aigile_me', arguments: {} });
  assert.equal(JSON.parse(toolText(r)).participantId, pg.id, '用資料夾唯一的 Token');
  b.close();
  console.log('✓ 1a 資料夾只有一隻 AI：直接認得');

  // 兩隻 AI、沒帶 AIGILE_AGENT → 只有 aigile_use
  const two = mkWork([[pg.agent, pg.tok], [qa.agent, qa.tok]]);
  b = bridge(two);
  r = await b.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.match(r.result.instructions, /aigile_use/, '還不知道身分：說明要先 aigile_use');
  r = await b.rpc('tools/list');
  assert.deepEqual(r.result.tools.map(t => t.name), ['aigile_use'], '兩隻 AI：只給 aigile_use');
  r = await b.rpc('tools/call', { name: 'aigile_inbox', arguments: {} });
  assert.ok(r.result.isError && /aigile_use/.test(toolText(r)), '沒選身分就呼叫別的工具：請先 aigile_use');
  r = await b.rpc('tools/call', { name: 'aigile_use', arguments: { agent: 'PG_NOPE' } });
  assert.ok(r.result.isError && toolText(r).includes(pg.agent) && toolText(r).includes(qa.agent), '選錯代號：列出這個資料夾有的代號');
  r = await b.rpc('tools/call', { name: 'aigile_use', arguments: { agent: qa.agent } });
  assert.ok(!r.result.isError, toolText(r));
  await new Promise(ok => setTimeout(ok, 200));
  assert.ok(b.notes.some(n => n.method === 'notifications/tools/list_changed'), '選好送 tools/list_changed');
  r = await b.rpc('tools/list');
  assert.ok(r.result.tools.some(t => t.name === 'aigile_post') && r.result.tools.some(t => t.name === 'aigile_use'), '換成角色的工具；多隻 AI 時保留 aigile_use');
  r = await b.rpc('tools/call', { name: 'aigile_me', arguments: {} });
  assert.equal(JSON.parse(toolText(r)).participantId, qa.id, 'aigile_use 選的身分');
  assert.ok(!b.err().includes(qa.tok) && !b.err().includes(pg.tok), '不印 Token');
  b.close();
  // AIGILE_AGENT 優先
  b = bridge(two, { AIGILE_AGENT: pg.agent });
  r = await b.rpc('tools/call', { name: 'aigile_me', arguments: {} });
  assert.equal(JSON.parse(toolText(r)).participantId, pg.id, 'AIGILE_AGENT 指定的身分');
  b.close();
  console.log('✓ 1b 多隻 AI：aigile_use、tools/list_changed、AIGILE_AGENT 優先');

  // PO 補充 1：一個程序只定一次身分，選完鎖定
  b = bridge(two);
  r = await b.rpc('tools/call', { name: 'aigile_use', arguments: { agent: qa.agent } });
  assert.match(toolText(r), /已選定並鎖定/);
  r = await b.rpc('tools/call', { name: 'aigile_use', arguments: { agent: pg.agent } });
  assert.ok(r.result.isError && new RegExp(`已鎖定為 ${qa.agent}.*重開對話`).test(toolText(r)), '選完不能換成別人：' + toolText(r));
  r = await b.rpc('tools/call', { name: 'aigile_use', arguments: { agent: qa.agent } });
  assert.ok(!r.result.isError && new RegExp(`目前身分：${qa.agent}`).test(toolText(r)), '再選同一個：回目前身分');
  r = await b.rpc('tools/call', { name: 'aigile_me', arguments: {} });
  assert.equal(JSON.parse(toolText(r)).participantId, qa.id, '還是原本的身分');
  b.close();
  b = bridge(two, { AIGILE_AGENT: pg.agent });
  r = await b.rpc('tools/call', { name: 'aigile_use', arguments: { agent: qa.agent } });
  assert.ok(r.result.isError && /已鎖定為/.test(toolText(r)), 'AIGILE_AGENT 定好的也鎖定');
  b.close();
  b = bridge(two, { AIGILE_WAKE_AGENT: pg.agent });
  r = await b.rpc('tools/list');
  assert.deepEqual(r.result.tools.map(t => t.name).sort(), [...names, 'aigile_use'].sort(), '背景工具清單含平台工具與本機身分確認');
  r = await b.rpc('tools/call', { name: 'aigile_use', arguments: { agent: pg.agent } });
  assert.match(toolText(r), /目前身分/, '喚醒時已鎖定，可直接確認身分');
  r = await b.rpc('tools/call', { name: 'aigile_use', arguments: { agent: qa.agent } });
  assert.ok(r.result.isError, '喚醒回合只能確認自己的身分');
  b.close();
  const missingWake = await run(pub('aigile-mcp.mjs'), [], {
    cwd: two, env: { AIGILE_WAKE_AGENT: 'PG_MISSING', AIGILE_AGENT: qa.agent }, input: '',
  });
  assert.notEqual(missingWake.code, 0);
  assert.match(missingWake.err, /喚醒身分/, '指定身分無法綁定時，MCP 在接受工具呼叫前停止');
  console.log('✓ PO 補充 1 身分選完鎖定');

  // PO 補充 2：從子資料夾開也找得到；沒有 .aigile 不打網路、只說這裡沒有接入平台；家目錄的 .aigile 不給底下的專案
  const one = mkWork([[pg.agent, pg.tok]]);
  const sub = path.join(one, 'src', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  b = bridge(sub);
  r = await b.rpc('tools/call', { name: 'aigile_me', arguments: {} });
  assert.equal(JSON.parse(toolText(r)).participantId, pg.id, '子資料夾往上找到 .aigile');
  b.close();
  const none = fs.mkdtempSync(path.join(dataDir, 'none-'));
  const hits0 = mcpHits;
  b = bridge(none);
  r = await b.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.match(r.result.instructions, /這裡沒有接入平台/);
  r = await b.rpc('tools/list');
  assert.deepEqual(r.result.tools, [], '沒接平台：不給工具');
  r = await b.rpc('tools/call', { name: 'aigile_inbox', arguments: {} });
  assert.ok(r.result.isError && /這裡沒有接入平台/.test(toolText(r)));
  b.close();
  assert.equal(mcpHits, hits0, '沒接平台：完全不打網路');
  const fakeHome = mkWork([[pg.agent, pg.tok]]);
  const proj = path.join(fakeHome, 'proj');
  fs.mkdirSync(proj);
  b = bridge(proj, { USERPROFILE: fakeHome, HOME: fakeHome });
  r = await b.rpc('tools/list');
  assert.deepEqual(r.result.tools, [], '家目錄底下的專案不會用到家目錄的 .aigile');
  b.close();
  b = bridge(fakeHome, { USERPROFILE: fakeHome, HOME: fakeHome });
  r = await b.rpc('tools/call', { name: 'aigile_me', arguments: {} });
  assert.equal(JSON.parse(toolText(r)).participantId, pg.id, '在家目錄開就用家目錄的');
  b.close();
  r = await run(pub('aigile-hook.mjs'), ['session'], { cwd: sub, input: '{"source":"clear"}', env: { CLAUDE_PROJECT_DIR: sub } });
  assert.match(r.out, new RegExp(`你是 ${pg.agent}`), 'hook 也從子資料夾往上找');
  for (const mode of ['session', 'stop']) {
    r = await run(pub('aigile-hook.mjs'), [mode], { cwd: none, input: '{}', env: { CLAUDE_PROJECT_DIR: none } });
    assert.equal(r.out.trim(), '', `沒接平台的資料夾：${mode} hook 不做事`);
  }
  console.log('✓ PO 補充 2 往上找、沒接平台不打網路、家目錄不外溢');

  // 2. 工具依角色：試用者沒有改卡與交接
  b = bridge(mkWork([[tr.agent, tr.tok]]));
  r = await b.rpc('tools/list');
  const tn = r.result.tools.map(t => t.name);
  assert.ok(tn.includes('aigile_inbox') && !tn.includes('aigile_card_update') && !tn.includes('aigile_card_handover'), '試用者：' + tn.join(','));
  r = await b.rpc('tools/call', { name: 'aigile_card_update', arguments: { cardId: 'MAIN-1', status: '進行中' } });
  assert.ok(r.error && /沒有這個工具/.test(r.error.message), '清單外的工具呼叫也擋');
  b.close();
  console.log('✓ 2 工具依 Token 角色');

  // 3. GET /api/me/reconnect
  r = await call(pg.tok, '/api/me/reconnect?tool=claude');
  assert.equal(r.status, 200);
  assert.match(r.text, /（重新接上）/, '重新接上版');
  assert.ok(!r.text.includes(pg.tok), '不含 Token');
  assert.match(r.text, new RegExp(`Token 已存在 \\.aigile/${pg.agent}/\\.token`), '寫 Token 在哪');
  assert.equal((await call(liu.token, '/api/me/reconnect')).status, 403, '人類不能拿');
  console.log('✓ 3 /api/me/reconnect 不含 Token');

  // 4. hook
  const hw = mkWork([[pg.agent, pg.tok]]);
  const D = path.join(hw, '.aigile', pg.agent);
  const hook = (mode, input, env = {}) => run(pub('aigile-hook.mjs'), [mode], { cwd: hw, input: JSON.stringify(input), env: { CLAUDE_PROJECT_DIR: hw, ...env } });
  r = await hook('session', { source: 'clear' });
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`對話剛清空：你是 ${pg.agent}`));
  assert.match(r.out, /（重新接上）/, 'session hook 帶入重新接上設定');
  assert.ok(!r.out.includes(pg.tok), 'hook 不印 Token');
  assert.ok(fs.existsSync(path.join(D, 'reconnect.md')), '另存 reconnect.md');
  // PO 補充 8（使用者 11/17）：compact 只印一句短提示，不帶整份、不打網路
  const reconnHits = () => fs.readFileSync(REQ_LOG, 'utf8').split('\n').filter(l => l.startsWith('/api/me/reconnect')).length;
  const rh0 = reconnHits();
  r = await hook('session', { source: 'compact' });
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`對話剛壓縮：你是 ${pg.agent}。照 \\.aigile/${pg.agent}/reconnect\\.md 與工作記憶`), r.out);
  assert.match(r.out, /等待腳本要開著/);
  assert.ok(!/（重新接上）/.test(r.out) && r.out.trim().split('\n').length === 1 && r.out.length < 400, 'compact 不帶整份設定，只一句：' + r.out.length);
  assert.equal(reconnHits(), rh0, 'compact 不打網路');
  console.log('✓ PO 補充 8 compact 只印一句');
  // stop：沒在待命（watcher 沒跑）→ 不擋
  r = await hook('stop', {});
  assert.equal(r.out.trim(), '', 'watcher 沒跑＝沒在待命：不擋');
  // watcher 在跑（用測試自己的 pid 假裝）、等待腳本不在 → 擋一次
  fs.writeFileSync(path.join(D, 'watcher.pid'), String(process.pid));
  r = await hook('stop', {});
  const blk = JSON.parse(r.out);
  assert.equal(blk.decision, 'block', '等待腳本不在：擋');
  assert.match(blk.reason, new RegExp(`aigile-wait\\.mjs --agent ${pg.agent}`), '附重開指令');
  r = await hook('stop', {});
  assert.equal(r.out.trim(), '', '同一次不在只提醒一次');
  r = await hook('stop', { stop_hook_active: true });
  assert.equal(r.out.trim(), '', 'stop_hook_active 不擋');
  fs.writeFileSync(path.join(D, 'wait.pid'), String(process.pid));
  r = await hook('stop', {});
  assert.equal(r.out.trim(), '', '等待腳本在：不擋');
  assert.ok(!fs.existsSync(path.join(D, 'wait-reminded')), '等待腳本回來就清掉提醒記號');
  fs.rmSync(path.join(D, 'wait.pid'));
  r = await hook('stop', {});
  assert.equal(JSON.parse(r.out).decision, 'block', '下一次不在再提醒');
  fs.writeFileSync(path.join(hw, '.aigile', pg.agent, 'watcher.env'), `AIGILE_BASE=${BASE}\nSKILL_TOOL=codex\n`);
  r = await hook('stop', {});
  assert.equal(r.out.trim(), '', 'Codex 不跑等待腳本：不擋');
  r = await run(pub('aigile-hook.mjs'), ['stop'], { cwd: two, input: '{}', env: { CLAUDE_PROJECT_DIR: two } });
  assert.equal(r.out.trim(), '', '認不出身分（兩隻 AI、沒帶 AIGILE_AGENT）：什麼都不做');
  // PO 補充 4：多隻 AI、沒有 AIGILE_AGENT → hook 一律不做事、不擋（就算 watcher 在跑）
  for (const ag of [pg.agent, qa.agent]) fs.writeFileSync(path.join(two, '.aigile', ag, 'watcher.pid'), String(process.pid));
  for (const [mode, input] of [['session', { source: 'clear' }], ['stop', {}]]) {
    r = await run(pub('aigile-hook.mjs'), [mode], { cwd: two, input: JSON.stringify(input), env: { CLAUDE_PROJECT_DIR: two } });
    assert.equal(r.out.trim(), '', `認不出唯一身分：${mode} hook 不做事`);
  }
  r = await run(pub('aigile-hook.mjs'), ['stop'], { cwd: two, input: '{}', env: { CLAUDE_PROJECT_DIR: two, AIGILE_AGENT: qa.agent } });
  assert.equal(JSON.parse(r.out).decision, 'block', '帶 AIGILE_AGENT 才檢查那一隻');
  assert.ok(fs.existsSync(path.join(two, '.aigile', qa.agent, 'wait-reminded')) && !fs.existsSync(path.join(two, '.aigile', pg.agent, 'wait-reminded')), '只記在那一隻自己的資料夾');
  console.log('✓ 4 hook：/clear 接回、等待腳本不在只提醒一次、認不出身分不做事');

  // 5. 接入檢查寫 hook 設定（保留原本設定、不重複）
  const sw = mkWork([[pg.agent, pg.tok]]);
  fs.mkdirSync(path.join(sw, '.claude'));
  fs.writeFileSync(path.join(sw, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  r = await run(pub('aigile-setup.mjs'), ['--agent', pg.agent, '--base', BASE, '--tool', 'claude'], { cwd: sw });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ hook：\.claude\/settings\.local\.json 加了 3 個/);
  let st = JSON.parse(fs.readFileSync(path.join(sw, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(st.permissions, { allow: ['Bash(ls:*)'] }, '原本的設定保留');
  assert.deepEqual(st.hooks.SessionStart.map(g => g.matcher), ['clear', 'compact']);
  assert.equal(st.hooks.Stop.length, 2, '原本的 Stop hook 保留＋加一個');
  const absHook = path.join(fs.realpathSync.native(sw), '.aigile', 'watcher', 'aigile-hook.mjs').replace(/\\/g, '/'); // 腳本寫的是實際路徑（macOS 暫存資料夾 /var 實為 /private/var）
  assert.ok(st.hooks.Stop.some(g => g.hooks[0].command === `node "${absHook}" stop`), 'hook 用絕對路徑（PO 驗收建議：從子資料夾開對話也找得到）：' + JSON.stringify(st.hooks.Stop));
  // 照設定檔裡的指令，從子資料夾用 shell 實際執行（Claude Code 從子資料夾開時 hook 的工作目錄就是子資料夾）
  const sessCmd = st.hooks.SessionStart.find(g => g.matcher === 'clear').hooks[0].command;
  const subdir = path.join(sw, 'pkg', 'inner');
  fs.mkdirSync(subdir, { recursive: true });
  const sr = await new Promise(ok => { const p = spawn(sessCmd, { cwd: subdir, shell: true, env: { ...process.env, CLAUDE_PROJECT_DIR: '', AIGILE_AGENT: '' } }); let o = ''; p.stdout.on('data', d => (o += d)); p.on('close', () => ok(o)); p.stdin.end('{"source":"clear"}'); });
  assert.match(sr, new RegExp(`你是 ${pg.agent}`), '從子資料夾執行 hook 指令找得到腳本與 .aigile：' + sr.slice(0, 200));
  assert.ok(fs.existsSync(path.join(sw, '.aigile', 'watcher', 'aigile-hook.mjs')) && fs.existsSync(path.join(sw, '.aigile', 'watcher', 'aigile-start.mjs')), 'hook 與一行啟動腳本一起下載核對');
  r = await run(pub('aigile-setup.mjs'), ['--agent', pg.agent, '--base', BASE, '--tool', 'claude'], { cwd: sw });
  assert.match(r.out, /✓ hook：\.claude\/settings\.local\.json 已有/, '再跑不重複加');
  assert.equal(JSON.parse(fs.readFileSync(path.join(sw, '.claude', 'settings.local.json'), 'utf8')).hooks.Stop.length, 2);
  // 舊的相對路徑（驗收前的寫法）→ 再跑一次換成絕對路徑，不重複加
  const st2 = JSON.parse(fs.readFileSync(path.join(sw, '.claude', 'settings.local.json'), 'utf8'));
  for (const g of st2.hooks.Stop) for (const h of g.hooks) if (/aigile-hook/.test(h.command)) h.command = 'node .aigile/watcher/aigile-hook.mjs stop';
  fs.writeFileSync(path.join(sw, '.claude', 'settings.local.json'), JSON.stringify(st2));
  r = await run(pub('aigile-setup.mjs'), ['--agent', pg.agent, '--base', BASE, '--tool', 'claude'], { cwd: sw });
  const st3 = JSON.parse(fs.readFileSync(path.join(sw, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(st3.hooks.Stop.length, 2, '不重複加');
  assert.ok(st3.hooks.Stop.some(g => g.hooks[0].command === `node "${absHook}" stop`), '舊的相對路徑換成絕對路徑');
  r = await run(pub('aigile-setup.mjs'), ['--agent', pg.agent, '--base', BASE, '--tool', 'codex'], { cwd: mkWork([[pg.agent, pg.tok]]) });
  assert.ok(!/✓ hook：/.test(r.out), 'Codex 不寫 Claude Code hook');
  assert.ok(r.out.includes('加好通用的 aigile（含 env_vars）'), 'Codex 設定帶 env_vars（實測：Codex 預設不傳環境變數給 MCP；PO 補充 7 起自動寫，詳見下面）：' + r.out.slice(-600));
  console.log('✓ 5 接入檢查寫 hook（保留原設定、不重複）');

  // 6. 一行啟動：實際執行網頁給的那一行
  assert.equal((await call(liu.token, `/api/my-ais/${qa.id}/onboarding-link`, 'POST', { tool: 'other' })).body.startLine, undefined, '「其他」工具沒有一行啟動（先產這個：重產會讓舊連結失效）');
  // 經過測試伺服器拿（網址才是 BASE）
  const link = await (await fetch(`${BASE}/api/my-ais/${qa.id}/onboarding-link`, { method: 'POST', headers: { Authorization: `Bearer ${liu.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'claude', autoStandby: true, start: true }) })).json(); // 跟網頁「複製一行啟動」一樣帶 start
  const line = link.startLine;
  assert.ok(line && line.startsWith('node -e "') && line.endsWith('"'), '有一行啟動：' + line);
  const code = line.slice('node -e "'.length, -1);
  globalThis.__line = code;
  assert.ok(!/["$%`]/.test(code), '裡面沒有雙引號、$、%、反引號（PowerShell、cmd、bash 都能貼）');
  assert.ok(!/!(?!=)/.test(code), '驚嘆號只有 !=（bash 不會展開）');
  assert.ok(code.includes(scriptHashes()['aigile-start.mjs']), '寫了 aigile-start.mjs 的 SHA-256');
  const sd = fs.mkdtempSync(path.join(dataDir, 's-'));
  fs.rmSync(FAKE_LOG, { force: true });
  const QD = path.join(sd, '.aigile', qa.agent);
  r = await runLine(sd, { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_AGENT: '', AIGILE_CLAUDE_BIN: FAKE });
  assert.equal(r.code, 0, r.out);
  { // 開源版：讀連結那一刻發新 Token（資料庫只存雜湊），舊的立刻失效
    const saved = fs.readFileSync(path.join(QD, '.token'), 'utf8').trim();
    assert.equal(hashOf(saved), (await db.get('SELECT token FROM participants WHERE id = ?', qa.id)).token, 'Token 從一次性連結存好（是剛發的那組）');
    qa.tok = saved;
  }
  const onb = fs.readFileSync(path.join(QD, 'onboarding.md'), 'utf8');
  assert.ok(/9\. 接好就換新對話：[^\n]*打 \/clear（hook 會自動帶入/.test(onb) && !/重新貼接入提示/.test(onb), '一行啟動接的：第 9 步叫人打 /clear，不叫人重貼用過的接入提示');
  assert.ok(!onb.includes(qa.tok), 'onboarding.md 去掉 Token');
  assert.match(onb, /（初次接入）/);
  assert.match(r.out, /✓ watcher 已在背景啟動/);
  const calls = fakeCalls();
  assert.ok(calls.some(c => c.args.join(' ') === `mcp add -s user aigile -- node ${path.join(process.env.AIGILE_HOME, '.aigile', 'aigile-mcp.mjs').replace(/\\/g, '/')}`), '裝通用 MCP：' + JSON.stringify(calls));
  const launch = calls.find(c => c.args[0] !== 'mcp');
  assert.ok(launch, '有開 claude');
  assert.equal(launch.agent, qa.agent, '開 claude 帶 AIGILE_AGENT');
  assert.match(launch.args[0], new RegExp(`照 \\.aigile/${qa.agent}/onboarding\\.md 做`), '初次：待命提示指向 onboarding.md');
  assert.match(launch.args[0], /aigile-wait\.mjs/, '待命提示帶等待腳本指令');
  assert.ok(fs.existsSync(path.join(sd, '.claude', 'settings.local.json')), '一行啟動也裝好 hook');
  // 等 watcher 寫 pid
  const readPid = () => { try { return Number(fs.readFileSync(path.join(QD, 'watcher.pid'), 'utf8').trim()) || 0; } catch { return 0; } };
  for (let i = 0; i < 75 && !readPid(); i++) await new Promise(ok => setTimeout(ok, 200));
  const wpid = readPid();
  if (!wpid) { let log = ''; try { log = fs.readFileSync(path.join(QD, 'watcher.log'), 'utf8'); } catch {} throw new Error('watcher 沒寫 pid；watcher.log：' + log.slice(-800)); }
  testPids.push(wpid);
  assert.ok(wpid > 0, 'watcher 寫了 pid');
  // 重開機貼同一行：連結已用過也能接回；watcher 在跑就不再開；待命提示換成 reconnect.md
  fs.rmSync(FAKE_LOG, { force: true });
  r = await runLine(sd, { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_AGENT: '', AIGILE_CLAUDE_BIN: FAKE });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`✓ watcher 已在執行（程序 ${wpid}）`), '第二次不重開 watcher');
  const l2 = fakeCalls().find(c => c.args[0] !== 'mcp');
  assert.match(l2.args[0], new RegExp(`照 \\.aigile/${qa.agent}/reconnect\\.md 重新接上`), '第二次：重新接上');
  const rc = fs.readFileSync(path.join(QD, 'reconnect.md'), 'utf8');
  assert.ok(!rc.includes(qa.tok) && /（重新接上）/.test(rc), 'reconnect.md 不含 Token');
  // PO 實測退回：Token 重發後，本機舊的 .token 401；新複製的一行帶著有效連結 → 用連結換新 Token、舊檔備份、照常接回
  assert.equal((await call(liu.token, `/api/my-ais/${qa.id}/reissue`, 'POST')).status, 200, '重發 Token');
  const link2 = await (await fetch(`${BASE}/api/my-ais/${qa.id}/onboarding-link`, { method: 'POST', headers: { Authorization: `Bearer ${liu.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: 'claude', autoStandby: true, start: true }) })).json();
  const code2 = link2.startLine.slice('node -e "'.length, -1);
  fs.rmSync(FAKE_LOG, { force: true });
  r = await new Promise(ok => execFile(process.execPath, ['-e', code2], { cwd: sd, timeout: 180_000, env: { ...process.env, AIGILE_BASE: '', AIGILE_TOKEN: '', CLAUDECODE: '', AIGILE_AGENT: '', AIGILE_CLAUDE_BIN: FAKE } }, (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out) + String(err) })));
  testPids.push(readPid());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /! 本機的 Token 平台不認得了（401.*改用這一行的一次性連結拿新的；舊檔備份成/, r.out);
  const qaTok2 = fs.readFileSync(path.join(QD, '.token'), 'utf8').trim(); // 開源版：讀連結時才發新 Token
  assert.ok(qaTok2 !== qa.tok && hashOf(qaTok2) === (await db.get('SELECT token FROM participants WHERE id = ?', qa.id)).token, '換成新的 Token');
  const tbak = fs.readdirSync(QD).filter(n => n.startsWith('.token.bak-'));
  assert.equal(tbak.length, 1, '舊的 .token 先備份');
  assert.equal(fs.readFileSync(path.join(QD, tbak[0]), 'utf8').trim(), qa.tok, '備份是舊的 Token');
  assert.ok(fakeCalls().some(c => c.args[0] !== 'mcp' && c.agent === qa.agent), '接著照常開 claude');
  assert.ok(!r.out.includes(qaTok2) && !r.out.includes(qa.tok), '不印 Token');
  // 連結也過期（410）→ 才請人回網頁重新複製
  fs.writeFileSync(path.join(QD, '.token'), 'stale-token-xxxxxxxxxxxx');
  r = await new Promise(ok => execFile(process.execPath, ['-e', code2], { cwd: sd, timeout: 60_000, env: { ...process.env, AIGILE_CLAUDE_BIN: FAKE } }, (e, out, err) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out) + String(err) })));
  assert.notEqual(r.code, 0);
  assert.match(r.out, /接入連結：已失效.*重新複製一行啟動/s, '本機 401、連結也用過：請重新複製');
  fs.writeFileSync(path.join(QD, '.token'), qaTok2);
  console.log('✓ PO 實測退回：重發 Token 後貼新的一行就接回');
  // 換成別人的資料夾、連結已用過、沒有 Token → 說清楚
  r = await new Promise(ok => execFile(process.execPath, ['-e', code], { cwd: fs.mkdtempSync(path.join(dataDir, 'n-')), timeout: 60_000, env: { ...process.env, AIGILE_CLAUDE_BIN: FAKE } }, (e, out) => ok({ code: e ? (e.code ?? 1) : 0, out: String(out) })));
  assert.notEqual(r.code, 0);
  assert.match(r.out, /接入連結：已失效.*重新複製一行啟動/s, '連結過期又沒有 Token：請重新複製');
  console.log('✓ 6 一行啟動：初次接入、重開機同一行接回');

  // 7. 等待腳本寫 wait.pid、結束刪掉（有待處理 → 馬上結束）
  await call(pg.tok, '/api/messages', 'POST', { project: '預設專案', requestId: 'p323-wake', text: '[需確認] 請看一下\n\n問題1：好嗎？\n選項：\nA. 好\nB. 不好', recipientIds: [qa.id], replyFrom: [qa.id] });
  fs.writeFileSync(path.join(QD, 'wait-reminded'), 'x');
  r = await run(path.join(sd, '.aigile', 'watcher', 'aigile-wait.mjs'), ['--agent', qa.agent], { cwd: sd, env: { AIGILE_BASE: BASE } });
  assert.match(r.out, /PENDING/, r.out);
  assert.ok(!fs.existsSync(path.join(QD, 'wait.pid')), '結束後刪掉 wait.pid');
  assert.ok(!fs.existsSync(path.join(QD, 'wait-reminded')), '等待腳本啟動就清掉提醒記號');
  const ws = fs.readFileSync(pub('aigile-wait.mjs'), 'utf8');
  assert.match(ws, /fs\.writeFileSync\(WAITPID, String\(process\.pid\)\)/, '啟動時寫 wait.pid');
  console.log('✓ 7 等待腳本 wait.pid');

  // 規格、接入設定
  const spec = fs.readFileSync(new URL('../docs/ai-integration.md', import.meta.url), 'utf8');
  for (const k of ['通用 MCP 叫 `aigile`', '**一行啟動**', 'GET /api/me/reconnect', '`.claude/settings.local.json`']) assert.ok(spec.includes(k), '規格有：' + k);
  const ob = (await call(liu.token, `/api/my-ais/${pg.id}/onboarding?tool=claude`)).body.text;
  assert.match(ob, /通用 MCP aigile/, '接入設定寫通用 MCP');
  // 用一行啟動（start=1）＝所屬人類同意待命；/clear 的 hook 看 started-by-line 記號帶 start=1
  pg.tok = await testToken(db, pg.id); // 前面步驟換過 Token，取一組現在有效的
  let t1 = (await call(pg.tok, '/api/me/reconnect?tool=claude&start=1')).text;
  assert.ok(t1.includes('已用一行啟動同意自動待命'), '一行啟動（start=1）：寫明已同意待命：' + String(t1).slice(0, 200));
  const lk = (await call(liu.token, `/api/my-ais/${pg.id}/onboarding-link`, 'POST', { tool: 'claude', autoStandby: true, start: true })).body;
  assert.ok(lk.startLine && lk.url, '一行啟動的連結');
  assert.ok(fs.existsSync(path.join(sd, '.aigile', qa.agent, 'started-by-line')), '一行啟動留下記號');
  console.log('✓ 6 一行啟動＝同意待命');

  // PO 補充 7：Codex 也自動裝通用 MCP（~/.codex/config.toml；先備份、只附加、驗證失敗還原）
  const cxHome = fs.mkdtempSync(path.join(dataDir, 'codexhome-'));
  const cxFile = path.join(cxHome, 'config.toml');
  const orig = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
  fs.writeFileSync(cxFile, orig);
  const cxLog = path.join(dataDir, 'codex.log');
  const cx = (env = {}) => run(pub('aigile-setup.mjs'), ['--agent', pg.agent, '--base', BASE, '--tool', 'codex'], { cwd: mkWork([[pg.agent, pg.tok]]), env: { CODEX_HOME: cxHome, AIGILE_CODEX_BIN: fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), FAKE_CODEX_LOG: cxLog, ...env } });
  r = await cx();
  assert.equal(r.code, 0, r.out);
  let toml = fs.readFileSync(cxFile, 'utf8');
  assert.ok(toml.startsWith(orig), '原本的段落不動：' + toml);
  assert.match(toml, /\[mcp_servers\.aigile\]\ncommand = "node"\nargs = \[".*aigile-mcp\.mjs"\]\nenv_vars = \["AIGILE_AGENT"\]/, '附加 [mcp_servers.aigile] 含 env_vars');
  const baks = fs.readdirSync(cxHome).filter(n => n.startsWith('config.toml.aigile-bak-'));
  assert.equal(baks.length, 1, '改之前先備份');
  assert.equal(fs.readFileSync(path.join(cxHome, baks[0]), 'utf8'), orig, '備份是原檔');
  assert.match(r.out, /✓ MCP：已在 .*config\.toml 加好通用的 aigile（含 env_vars）/);
  assert.ok(fs.readFileSync(cxLog, 'utf8').includes('["mcp","get","aigile"]'), '改完用 codex mcp get aigile 驗證');
  assert.match(r.out, /! Codex 網路：.*沒看到 network_access = true/, '沙盒沒開網路：只印清楚');
  r = await cx();
  assert.match(r.out, /✓ MCP：Codex 已有 \[mcp_servers\.aigile\]（不改）/, '已有就跳過');
  assert.equal(fs.readFileSync(cxFile, 'utf8'), toml, '不重複加');
  // 驗證失敗（這版 Codex 不認得）→ 還原、印設定
  fs.writeFileSync(cxFile, orig + '[sandbox_workspace_write]\nnetwork_access = true\n');
  r = await cx({ FAKE_CODEX_FAIL: '1' });
  assert.equal(fs.readFileSync(cxFile, 'utf8'), orig + '[sandbox_workspace_write]\nnetwork_access = true\n', '驗證失敗：還原原檔');
  assert.match(r.out, /驗證失敗（fake codex: unknown field env_vars），已還原/);
  assert.match(r.out, /Codex → ~\/\.codex\/config\.toml 加 \[mcp_servers\.aigile\]/, '退回印設定請人貼');
  assert.ok(!/! Codex 網路/.test(r.out), '有開網路就不提');
  fs.rmSync(cxFile);
  r = await cx({ FAKE_CODEX_FAIL: '1' });
  assert.ok(!fs.existsSync(cxFile), '原本沒有設定檔、驗證失敗：刪掉不留半套');
  r = await cx();
  assert.match(fs.readFileSync(cxFile, 'utf8'), /\[mcp_servers\.aigile\]/, '原本沒有設定檔：新建');
  assert.ok(!fs.existsSync(path.join(os.homedir(), '.codex', 'config.toml')) || !/aigile-p323/.test(fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8')), '沒動到真的 Codex 設定');
  console.log('✓ PO 補充 7 Codex 自動裝通用 MCP（備份、驗證、失敗還原）');
  console.log('one-line-start-test：全部通過');
} catch (e) {
  console.error('one-line-start-test 失敗：', e.message, (e.stack || '').split('\n').find(l => l.includes('one-line-start-test.js')) || '');
  process.exitCode = 1;
} finally {
  for (const pid of new Set(testPids)) killPid(pid);
  server.close();
  db.close?.();
  await new Promise(ok => setTimeout(ok, 500));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
}
